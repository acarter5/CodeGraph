import {
  SourceFile,
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunction,
  MethodDeclaration,
  ConstructorDeclaration,
  GetAccessorDeclaration,
  SetAccessorDeclaration,
  SyntaxKind,
} from "ts-morph";
import {
  buildImportModuleMap,
  baseIdentifierName,
  isExternalCallee,
  looksLike,
} from "src/utils/tsMorph";

import Scanner from "./index";

import lineColumn = require("line-column");
import { ExcludeNullish } from "../utils";
// @ts-expect-error
import type { LineColumnFinder } from "line-column";
import type { TSMorphFunctionNode } from "types/index";

export default class ScannerTsMorph extends Scanner {
  postitionedFunctionNode: TSMorphFunctionNode | null;
  callExpressionLocations: LineColumnFinder[];
  // The callee identifier text per call, index-aligned with
  // callExpressionLocations — its length sizes the call-site rect downstream.
  callExpressionNames: string[];
  // Whether each call is "provably external" — its receiver is imported from a
  // bare (node_modules) module specifier, or is a JS builtin. Index-aligned
  // with the arrays above. The Builder skips these: no definition lookup, no
  // FindDefinitionFail node, no connector (see builder/index.ts).
  callExpressionExternal: boolean[];
  constructor(
    unpostitionedFunctionNode: TSMorphFunctionNode,
    fileNode: SourceFile,
    targetFileCode: string
  ) {
    super(unpostitionedFunctionNode, fileNode, targetFileCode);

    this.postitionedFunctionNode = this._findPositionedFunctionNode();
    const callExpressions = this._getCallExpressions();
    this.callExpressionLocations = callExpressions.map((c) => c.location);
    this.callExpressionNames = callExpressions.map((c) => c.name);
    this.callExpressionExternal = callExpressions.map((c) => c.isExternal);
  }

  private _getCallExpressions(): {
    location: LineColumnFinder;
    name: string;
    isExternal: boolean;
  }[] {
    const { postitionedFunctionNode, targetFileCode, fileNode } = this;

    if (!postitionedFunctionNode) {
      return [];
    }

    // localName -> module specifier (e.g. "proxyChain" -> "proxy-chain").
    const importModules = buildImportModuleMap(fileNode);

    const callExpressionNodes = postitionedFunctionNode.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );

    const callExpressions = callExpressionNodes
      .map((callExpressionNode) => {
        const callee = callExpressionNode.getFirstChild();
        // The callee identifier used for location/name/definition lookup: for a
        // property access (`a.b()`) it's the method name `b`, else the callee.
        const tsMorphCallee =
          callee?.getKind() === SyntaxKind.PropertyAccessExpression
            ? callee.getLastChildByKind(SyntaxKind.Identifier)
            : callee;

        if (!tsMorphCallee) {
          return null;
        }

        // The receiver's leftmost identifier (`a` in `a.b.c()`) classifies the
        // call as external. null when the receiver isn't a bare identifier
        // (e.g. `new Proxy().find()` — a method on an instance).
        const isExternal = isExternalCallee(
          baseIdentifierName(callee),
          importModules
        );

        return {
          location: lineColumn(targetFileCode, tsMorphCallee.getStart()),
          name: tsMorphCallee.getText(),
          isExternal,
        };
      })
      .filter(ExcludeNullish);

    if (callExpressions.length !== callExpressionNodes.length) {
      throw new Error("problem finding callee in call expression");
    }

    return callExpressions;
  }

  // Not every Node kind exposes getStructure (e.g. ArrowFunction), so guard it.
  private _getStructure(node: any) {
    return typeof node?.getStructure === "function"
      ? node.getStructure()
      : undefined;
  }

  // TODO: clean this up
  // TODO(position-based-node-lookup): this structural re-match (looksLike)
  // exists only to recover real source positions for the unpositioned snippet
  // node. Looking the node up by position in the file AST removes the need for
  // it entirely — see TODO.md.
  private _findPositionedFunctionNode() {
    const { unpostitionedFunctionNode, fileNode } = this;

    const unpostitionedFunctionNodeStructure = this._getStructure(
      unpostitionedFunctionNode
    );

    if (!unpostitionedFunctionNodeStructure) {
      throw Error("cannot get unpositioned node structure");
    }

    let postitionedFunctionNode;

    fileNode.forEachDescendant((fileNodeDescendant) => {
      if (
        fileNodeDescendant.getKind() === unpostitionedFunctionNode?.getKind()
      ) {
        const fileNodeDescendantStructure =
          this._getStructure(fileNodeDescendant);
        const isMatch = looksLike(
          fileNodeDescendantStructure,
          unpostitionedFunctionNodeStructure
        );

        if (isMatch) {
          postitionedFunctionNode = fileNodeDescendant;
          return;
        }
      }
    });

    const typedPositionedFunctionNode = this._getTypedPostionedFunctionNode(
      postitionedFunctionNode
    );

    return typedPositionedFunctionNode;
  }

  private _getTypedPostionedFunctionNode(node: any) {
    if (node instanceof FunctionDeclaration) {
      return node as FunctionDeclaration;
    } else if (node instanceof FunctionExpression) {
      return node as FunctionExpression;
    } else if (node instanceof ArrowFunction) {
      return node as ArrowFunction;
    } else if (node instanceof MethodDeclaration) {
      return node as MethodDeclaration;
    } else if (node instanceof ConstructorDeclaration) {
      return node as ConstructorDeclaration;
    } else if (node instanceof GetAccessorDeclaration) {
      return node as GetAccessorDeclaration;
    } else if (node instanceof SetAccessorDeclaration) {
      return node as SetAccessorDeclaration;
    } else {
      return null;
    }
  }
}

// let postitionedFunctionTargetNode
// try {
//   console.log('[hf]', unPositionedFunctionNode.getKind())
//   postitionedFunctionTargetNode = fileNode.getDescendantsOfKind(unPositionedFunctionNode?.getKind()).filter((node) => node.getName() === unPositionedFunctionNode?.getName())[0]
// } catch(error) {
//   debugger
//   console.error('error finding positioned target node', {error})
// }
