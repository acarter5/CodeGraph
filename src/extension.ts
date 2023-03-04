// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import { transformSync } from "@babel/core";
import * as hash from "object-hash";
import * as fs from "fs";
import tsPreset from "@babel/preset-typescript";
import tsPlugin from "@babel/plugin-transform-typescript";
import envPreset from "@babel/preset-env";
import * as cm from "core-js-compat";
import { Project, SyntaxKind, ts } from "ts-morph";
import CodeGraphParser from "./parser";

// import * as ts from "typescript";
import * as lineColumn from "line-column";

import type { Node } from "@babel/types";
import objectHash = require("object-hash");
// import * as t from "@babel/types";
const {
  window: { activeTextEditor, showTextDocument },
  commands,
  workspace: ws,
  Position,
  Uri,
} = vscode;

function extract(file: string, identifiers: string[]): void {
  // Create a Program to represent the project, then pull out the
  // source file to parse its AST.
  let program = ts.createProgram([file], { allowJs: true });
  const sourceFile = program.getSourceFile(file);

  // To print the AST, we'll use TypeScript's printer
  // const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  // To give constructive error messages, keep track of found and un-found identifiers
  const unfoundNodes = [],
    foundNodes = [];

  // Loop through the root AST nodes of the file
  ts.forEachChild(sourceFile, (node) => {
    let name = "";

    // This is an incomplete set of AST nodes which could have a top level identifier
    // it's left to you to expand this list, which you can do by using
    // https://ts-ast-viewer.com/ to see the AST of a file then use the same patterns
    // as below
    if (ts.isFunctionDeclaration(node)) {
      name = node.name.text;
      // Hide the method body when printing
      node.body = undefined;
    } else if (ts.isVariableStatement(node)) {
      name = node.declarationList.declarations[0].name.getText(sourceFile);
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name.text;
    }

    const container = identifiers.includes(name) ? foundNodes : unfoundNodes;
    container.push([name, node]);
  });

  // Either print the found nodes, or offer a list of what identifiers were found
  return { foundNodes, unfoundNodes };
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

function looksLike(a, b): boolean {
  return (
    a &&
    b &&
    Object.keys(b).every((bKey) => {
      const bVal = b[bKey];
      const aVal = a[bKey];
      if (typeof bVal === "function") {
        return bVal(aVal);
      }
      return isPrimitive(bVal) ? bVal === aVal : looksLike(aVal, bVal);
    })
  );
}

function isPrimitive(val) {
  return val == null || /^[sbn]/.test(typeof val);
}

function looksLikeSkipPosition(a, b): boolean {
  return (
    a &&
    b &&
    Object.keys(b).every((bKey) => {
      if (
        bKey === "loc" ||
        bKey === "start" ||
        bKey === "end" ||
        bKey === "trailingComma" ||
        bKey === "parenStart"
      ) {
        return true;
      }
      const bVal = b[bKey];
      const aVal = a[bKey];
      if (typeof bVal === "function") {
        return bVal(aVal);
      }

      // FOR DEBUGGING MATCH FAILS
      // if (isPrimitive(bVal) && bVal !== aVal) {
      //   console.log("[hf] MATCH FAIL", { bKey, aVal, bVal });
      // }

      return isPrimitive(bVal)
        ? bVal === aVal
        : looksLikeSkipPosition(aVal, bVal);
    })
  );
}

function looksLikeSkipPositionTsMorph(a, b, depth): boolean {
  //todo: do better
  if (depth >= 100) {
    console.log("[hf] depth hit");
    return true;
  }
  console.log("[hf]", "match test", { a, b });
  return (
    a &&
    b &&
    Object.keys(b).every((bKey) => {
      if (
        bKey === "pos" ||
        bKey === "end" ||
        bKey === "_wrappedChildCount" ||
        bKey === "transformFlags" ||
        bKey === "fileName"
      ) {
        return true;
      }
      const bVal = b[bKey];
      const aVal = a[bKey];
      if (typeof bVal === "function") {
        return bVal(aVal);
      }

      // FOR DEBUGGING MATCH FAILS
      if (isPrimitive(bVal) && bVal !== aVal) {
        debugger;
        console.log("[hf] MATCH FAIL", { bKey, aVal, bVal });
      }

      return isPrimitive(bVal)
        ? bVal === aVal
        : looksLikeSkipPositionTsMorph(aVal, bVal, depth + 1);
    })
  );
}

const scanTargetFunctionAstNode = (
  targetFunctionAstNode: Node,
  scope,
  parentPath
) => {
  let name: string | undefined;
  const callees = [];

  traverse(
    targetFunctionAstNode,
    {
      FunctionDeclaration(path) {
        if (name) {
          return;
        }
        name = path.node.id?.name;
      },
      ArrowFunctionExpression(path) {
        if (name) {
          return;
        }

        try {
          name = path.parent.id.name;
        } catch {
          console.error("arrowFunction name match error", { path });
          throw Error("name match error");
        }
      },
      FunctionExpression(path) {
        if (name) {
          return;
        }

        try {
          name = path.parent.id.name;
        } catch {
          console.error("FunctionExpression name match error", { path });
          throw Error("name match error");
        }
      },
      //   Identifier(path) {
      //     if (
      //       looksLike(path.parentPath.parent, {
      //         callee: () => true,
      //       })
      //     ) {
      //       callees.push(path.node);
      //     }
      //   },
      CallExpression(path) {
        let callee;
        try {
          callee = path.get("callee").node;
          const { property, loc } = callee;

          if (property) {
            callees.push(property.loc);
          } else if (loc) {
            callees.push(loc);
          }
        } catch {
          console.error("error resolving CallExpression callee", { path });
          throw Error("error resolving CallExpression callee");
        }
      },
    },
    scope,
    parentPath
  );

  return { name, callees };
};

const buildNodeMap = async ({
  targetFuncRange,
  targetFuncUri,
  nodeMap,
  isEntry,
  parentHash,
}: {
  targetFuncRange: vscode.Range;
  targetFuncUri: vscode.Uri;
  nodeMap: Map<string, any>;
  isEntry: boolean;
  parentHash?: string;
}) => {
  // let targetDocument;
  // let targetFuncCode;
  // let targetFileCode;
  // let functionAST;
  // let fileAST;
  // let transformedFuncCode;
  // let transformedFuncMap;
  // let transformedFuncAST;

  // try {
  //   targetDocument = await ws.openTextDocument(targetFuncUri);
  // } catch (error) {
  //   console.error("VSCODE API - error opening file", {
  //     error,
  //     uri: targetFuncUri.path,
  //   });
  // }

  // try {
  //   targetFuncCode = targetDocument?.getText(targetFuncRange);
  // } catch (error) {
  //   console.error("VSCODE API - error reading function code from document", {
  //     error,
  //     uri: targetFuncUri.path,
  //     range: targetFuncRange,
  //   });
  // }

  // try {
  //   targetFileCode = targetDocument?.getText();
  // } catch (error) {
  //   console.error("VSCODE API - error reading full file text", {
  //     error,
  //     uri: targetFuncUri.path,
  //   });
  // }

  // TS MORPH PARSING

  // const thisFuncProject = new Project();
  // const funcAST = thisFuncProject.createSourceFile("func.ts", targetFuncCode);
  // const funcProgram = thisFuncProject.getProgram();
  // const funcProgramCompileObject = funcProgram.compilerObject;
  // const nameMap = funcProgramCompileObject.getFilesByNameMap();
  // const sourceFiles = thisFuncProject.getSourceFiles();
  // const compilerNode = sourceFiles[0].compilerNode;

  // const funcProject = new Project();
  // funcProject.createSourceFile("func.ts", targetFuncCode);
  // const funcSourceFile = funcProject.getSourceFiles()[0]);

  // todo: clean this up
  // const functionDeclarationNode = funcSourceFile.getFirstDescendantByKind(
  //   SyntaxKind.FunctionDeclaration
  // );
  // const arrowFunctionDeclaration = funcSourceFile.getFirstDescendantByKind(
  //   SyntaxKind.ArrowFunction
  // );
  // const functionExpressionnNode = funcSourceFile.getFirstDescendantByKind(
  //   SyntaxKind.FunctionExpression
  // );

  // const unPositionedFunctionNode = [
  //   functionDeclarationNode,
  //   arrowFunctionDeclaration,
  //   functionExpressionnNode,
  // ]
  //   .filter((node) => !!node)
  //   .sort((nodeA, nodeB) => {
  //     return nodeA?.getStart() - nodeB?.getStart();
  //   })[0];

  const parser = new CodeGraphParser(targetFuncRange, targetFuncUri);

  const { targetFileCode, targetFuncCode } = await parser.readDocument();

  const { unPositionedFunctionNode, fileNode } = await parser.tSMorphParse();

  if (!unPositionedFunctionNode || !fileNode) {
    debugger;
    console.error("parser hasnt returned node");
    const id = objectHash.sha1({ failKey: targetFuncCode });
    const node = {
      id,
      astNode: null,
      uri: targetFuncUri,
      range: targetFuncRange,
      code: targetFuncCode,
      incomingCalls: isEntry ? [] : [parentHash],
      outgoingCalls: [],
      name: null,
    };
    nodeMap.set(id, node);
    return node;
  }

  // const fileProject = new Project();
  // fileProject.createSourceFile("file.ts", targetFileCode);
  // const fileNode = fileProject.getSourceFiles()[0];

  // TS MORPH TRAVERSAL

  // TODO: make this better:

  // let postitionedFunctionTargetNode
  // try {
  //   console.log('[hf]', unPositionedFunctionNode.getKind())
  //   postitionedFunctionTargetNode = fileNode.getDescendantsOfKind(unPositionedFunctionNode?.getKind()).filter((node) => node.getName() === unPositionedFunctionNode?.getName())[0]
  // } catch(error) {
  //   debugger
  //   console.error('error finding positioned target node', {error})
  // }fileNode

  // console.log('[hf]', {lineColumn})
  // should get the last member of a member expression callee or the first identifier of a standard callee
  // console.log('[hf]', callExpressionNodes[0].getFirstChild()?.getKind())
  // const callExpressionLocations = callExpressionNodes.map((callExpressionNode) => new Position(callExpressionNode.getStartLineNumber(), callExpressionNode.getStartLinePos()))

  let postitionedFunctionTargetNode;

  const unPositionedFunctionNodeText = unPositionedFunctionNode?.getText();

  if (!unPositionedFunctionNodeText) {
    debugger;
    console.error("Function declaration node text not found", {
      targetFuncCode,
      targetFuncUri,
    });
  }

  try {
    fileNode.forEachDescendant((node, traversal) => {
      // console.log('[hf]', {testKind: node.getKind(), controlKind: unPositionedFunctionNode?.getKind()})
      if (node.getKind() === unPositionedFunctionNode?.getKind()) {
        // console.log('[hf] kind match')
        // console.log('{hf} equal?', node.getText().localeCompare(unPositionedFunctionNode.getText()) )
        const nodeText = node.getText();
        if (nodeText.localeCompare(unPositionedFunctionNodeText) === 0) {
          postitionedFunctionTargetNode = node;
        }
        // if(looksLikeSkipPositionTsMorph(node.compilerNode., unPositionedFunctionNode, 0)) {
        //   postitionedFunctionTargetNode = node

        //   traversal.stop()
        // }
      }
    });
  } catch (error) {
    debugger;
    console.error("error getting positioned function node", { error });
  }

  if (!postitionedFunctionTargetNode) {
    console.error("function defintion Node not found in file AST", {
      targetFuncCode,
      targetFileCode,
    });
    throw Error("function defintion Node not found in file AST");
  }

  let callExpressionNodes;
  try {
    callExpressionNodes = postitionedFunctionTargetNode.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );
  } catch (error) {
    debugger;
    console.error("error finding call expressions", { error });
  }

  const tsMorphCallees = callExpressionNodes.map((callExpressionNode) =>
    callExpressionNode.getFirstChild()?.getKind() ===
    SyntaxKind.PropertyAccessExpression
      ? callExpressionNode
          .getFirstChild()
          ?.getLastChildByKind(SyntaxKind.Identifier)
      : callExpressionNode.getFirstChild()
  );
  const tsMorphCalleeLocations = tsMorphCallees.map((tsMorphCallee) =>
    lineColumn(targetFileCode, tsMorphCallee.getStart())
  );

  // BABEL PARSING

  // try {
  //   const result = transformSync(targetFuncCode, {
  //     plugins: [tsPlugin],
  //     presets: [tsPreset, envPreset],
  //     ast: true,
  //     filename: "this matters.ts",
  //   });

  //   transformedFuncCode = result.code;
  //   transformedFuncMap = result.map;
  //   transformedFuncAST = result.ast;

  //   console.log("[hf] THIS ONE", {
  //     transformedFuncCode,
  //     transformedFuncMap,
  //     transformedFuncAST,
  //     result,
  //   });

  //   functionAST =
  //     targetFuncCode &&
  //     parse(targetFuncCode, {
  //       plugins: [
  //         "typescript",
  //         "asyncGenerators",
  //         "classPrivateMethods",
  //         "classPrivateProperties",
  //         "classProperties",
  //         "classStaticBlock",
  //         "estree",
  //         "flowComments",
  //         "functionBind",
  //         "jsx",
  //         "recordAndTuple",
  //         "privateIn",
  //         "placeholders",
  //       ],
  //       allowImportExportEverywhere: true,
  //       errorRecovery: true,
  //     });
  // } catch (error) {
  //   console.error("BABEL PARSER ERROR - error parsing function code", {
  //     error,
  //     targetFuncCode,
  //     uri: targetFuncUri.path,
  //     functionAST,
  //     transformedFuncCode,
  //     transformedFuncMap,
  //     transformedFuncAST,
  //   });
  // }

  // try {
  //   fileAST =
  //     targetFileCode &&
  //     parse(targetFileCode, {
  //       plugins: [
  //         "typescript",
  //         "asyncGenerators",
  //         "classPrivateMethods",
  //         "classPrivateProperties",
  //         "classProperties",
  //         "classStaticBlock",
  //         "estree",
  //         "flowComments",
  //         "functionBind",
  //         "jsx",
  //         "recordAndTuple",
  //         "privateIn",
  //         "placeholders",
  //       ],
  //       allowImportExportEverywhere: true,
  //       errorRecovery: true,
  //     });
  // } catch (error) {
  //   console.error("BABEL PARSER ERROR - error parsing full file", {
  //     error,
  //     targetFuncCode,
  //     uri: targetFuncUri.path,
  //     fileAST,
  //   });
  // }

  //   console.log("[hf]", {
  //     functionAST: functionAST?.valueOf(),
  //   });

  // const functionTargetNode = functionAST?.valueOf().program.body[0];

  // BABEL TRAVERSAL

  // let postitionedFunctionTargetNode;
  // let scope;
  // let parentPath;

  // traverse(fileAST, {
  //   // eslint-disable-next-line @typescript-eslint/naming-convention
  //   [functionTargetNode.type]: function (path) {
  //     console.log("[hf]", {
  //       functionNode: path.node,
  //       targetFunctionNode: functionTargetNode,
  //     });
  //     if (looksLikeSkipPosition(path.node, functionTargetNode)) {
  //       console.log("[hf]", { positionedNode: path.node });
  //       postitionedFunctionTargetNode = path.node;
  //       scope = path.scope;
  //       parentPath = path.parentPath;
  //     }
  //   },
  // });

  const astNodeHash = hash.sha1(postitionedFunctionTargetNode.compilerNode);

  if (nodeMap.has(astNodeHash)) {
    nodeMap.get(astNodeHash).incomingCalls.push(parentHash);
    return null;
  }

  if (isEntry) {
    nodeMap.set("entry", astNodeHash);
  } else {
    nodeMap.get(parentHash).outgoingCalls.push(astNodeHash);
  }

  const graphNode = {
    id: astNodeHash,
    // astNode: postitionedFunctionTargetNode.compilerNode,
    uri: targetFuncUri,
    range: targetFuncRange,
    code: targetFuncCode,
    incomingCalls: isEntry ? [] : [parentHash],
    outgoingCalls: [],
  };

  try {
    if (postitionedFunctionTargetNode.getName) {
      graphNode.name = postitionedFunctionTargetNode.getName();
    } else if (postitionedFunctionTargetNode?.getParent()?.getName) {
      graphNode.name = postitionedFunctionTargetNode.getParent().getName();
    } else {
      graphNode.name =
        "having trouble finding the name of this function. Debug me coward!";
    }
  } catch (error) {
    debugger;
    console.log("[hf] nameing error", {
      error,
      nodeType: postitionedFunctionTargetNode.getKind(),
    });
  }

  nodeMap.set(astNodeHash, graphNode);

  // SCAN BABEL NODES
  // const { name, callees } = scanTargetFunctionAstNode(
  //   graphNode.astNode,
  //   scope,
  //   parentPath
  // );

  // console.log("[hf]", { functionName: name });

  //   console.log("[hf]", { name, callees });

  const calleeDefinitionLocations = [];

  for (var i = 0; i < tsMorphCalleeLocations.length; i++) {
    // const curCallee = callees[i];
    // console.log('[hf]', tsMorphCalleeLocations[i])
    const position = new Position(
      tsMorphCalleeLocations[i].line - 1,
      tsMorphCalleeLocations[i].col
    );

    // console.log('[hf]', {position: tsMorphCalleeLocations[i]})
    const location = await commands.executeCommand(
      "vscode.executeDefinitionProvider",
      targetFuncUri,
      position
    );

    calleeDefinitionLocations.push(location?.[0] ? location[0] : null);
  }

  // const calleeLocations = callees.map(async (callee) => {
  //   // for some reason the executeDefinitionProvider command only works if the line # is 1 less than the actual location of the callee
  //   const position = new Position(
  //     callee.start.line - 1,
  //     callee.start.column + 1
  //   );
  //   console.log("[hf] calleeLocations", {
  //     callee,
  //     start: callee.start,
  //     position,
  //     targetFuncUri,
  //   });
  //   const location = await commands.executeCommand(
  //     "vscode.executeDefinitionProvider",
  //     targetFuncUri,
  //     position
  //   );

  //   console.log("[hf]", { location });

  //   return Array.isArray(location) && location.length
  //     ? {
  //         ...location[0],
  //         identifierName: callee.identifierName,
  //       }
  //     : null;
  // });

  console.log("[hf]", { calleeDefinitionLocations });

  const filteredCalleeDefinitionLocations = calleeDefinitionLocations
    .filter((loc) => loc !== null)
    .filter((loc) => !loc?.targetUri?.path.includes("node_modules"));

  console.log("[hf]", { filteredCalleeDefinitionLocations });
  try {
    graphNode.outgoingCalls = (
      await Promise.all(
        filteredCalleeDefinitionLocations.map(async (loc) =>
          buildNodeMap({
            targetFuncRange: loc.targetRange,
            targetFuncUri: loc.targetUri,
            nodeMap,
            isEntry: false,
            parentHash: graphNode.id,
          })
        )
      )
    )
      .filter((graphNode) => graphNode !== null)
      .map((node) => node.id);
  } catch (error) {
    console.error("[hf] error in recursive buildNodeMap calls", { error });
  }

  return graphNode;
};

const buildNodeGraph = (nodeMap, nodeId, ancestors = []) => {
  if (!nodeId) {
    nodeId = nodeMap.get("entry");
  }

  if (ancestors.includes(nodeId)) {
    return {
      recursionId: nodeId,
      children: [],
    };
  }

  const node = nodeMap.get(nodeId);

  const graphNode = { ...node };
  graphNode.children =
    graphNode?.outgoingCalls?.map((nodeId) =>
      buildNodeGraph(nodeMap, nodeId, [...ancestors, graphNode.id])
    ) || [];

  return graphNode;
};

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "codegraph.makeGraph",
    async () => {
      vscode.window.showInformationMessage("CommandRun!");

      const currentSelection = activeTextEditor?.selection;
      const targetFuncUri = activeTextEditor?.document.uri;

      if (!targetFuncUri) {
        throw Error("target URI for function not found");
      }

      const currentSelectionAnchor = currentSelection?.anchor;

      const targetFunctionDefintion: (vscode.Location | vscode.LocationLink)[] =
        await commands.executeCommand(
          "vscode.executeDefinitionProvider",
          targetFuncUri,
          currentSelectionAnchor
        );

      const targetFuncRange = targetFunctionDefintion[0]
        .targetRange as vscode.Range;

      if (!targetFuncRange) {
        throw Error("target Range for function not found");
      }

      const nodeMap = new Map();

      const entryGraphNode = await buildNodeMap({
        targetFuncRange,
        targetFuncUri,
        isEntry: true,
        nodeMap,
      });

      const nodeGraph = buildNodeGraph(nodeMap);
      const Jsonifified = JSON.parse(JSON.stringify(nodeGraph));

      console.log("[hf] end", { nodeMap, entryGraphNode, nodeGraph });
    }
  );

  context.subscriptions.push(disposable);
}
// This method is called when your extension is deactivated
export function deactivate() {}
