import * as vscode from "vscode";
import CodeGraphParserTsMorph from "./parser/tsMorph";
import ReaderVSCode from "./reader/vscode";
import ScannerTsMorph from "./scanner/tsMorph";
import {
  buildNodeMapNodeFromTsMorphNode,
  ExcludeNullish,
  verifyCallDefinitionLocations,
  buildFailureNode,
} from "src/utils/index";
// @ts-expect-error
import type { LineColumnFinder } from "line-column";

import * as objectHash from "object-hash";

import { MapNode, FailReason, FindDefinitionFail } from "types/index";
const {
  window: { activeTextEditor },
  commands,
  workspace: ws,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  Position,
} = vscode;

const buildNodeMap = async ({
  targetFunctionRange,
  targetFunctionUri,
  nodeMap,
  isEntry,
  parentHash,
}:
  | {
      targetFunctionRange: vscode.Range;
      targetFunctionUri: vscode.Uri;
      nodeMap: Map<string, any>;
      isEntry: true;
      parentHash?: undefined;
    }
  | {
      targetFunctionRange: vscode.Range;
      targetFunctionUri: vscode.Uri;
      nodeMap: Map<string, any>;
      isEntry: false;
      parentHash: string;
    }) => {
      const reader = new ReaderVSCode(targetFunctionRange, targetFunctionUri);
      const { targetFunctionCode, targetFileCode } =
        await reader.readDocument();

      const parser = new CodeGraphParserTsMorph(
        targetFunctionCode,
        targetFileCode
      );
      const { unPositionedFunctionNode, fileNode } = await parser.parse();

      if (!unPositionedFunctionNode || !fileNode) {
        console.error("parser did not return node");
        const node = buildFailureNode({
          failReason: FailReason.parseFail,
          uri: targetFunctionUri,
          range: targetFunctionRange,
          code: targetFunctionCode,
          parentId: parentHash,
        });
        if (nodeMap.has(node.id)) {
          nodeMap.get(node.id).incomingCalls.push(parentHash);
        } else {
          nodeMap.set(node.id, node);
        }
        return node;
      }

      const scanner = new ScannerTsMorph(
        unPositionedFunctionNode,
        fileNode,
        targetFileCode
      );

      const { postitionedFunctionNode, callExpressionLocations } = scanner;

      if (!postitionedFunctionNode) {
        console.error("unable to find positionedFunctionNode");
        const id = objectHash.sha1({ failKey: targetFunctionCode });
        const node = {
          id,
          astNode: null,
          uri: targetFunctionUri,
          range: targetFunctionRange,
          code: targetFunctionCode,
          incomingCalls: isEntry ? [] : [parentHash],
          outgoingCalls: [],
          name: null,
        };
        nodeMap.set(id, node);
        return node;
      }

      const mapNode = buildNodeMapNodeFromTsMorphNode(
        postitionedFunctionNode,
        targetFunctionUri,
        targetFunctionRange,
        targetFunctionCode,
        isEntry,
        parentHash
      );

      if (isEntry) {
        nodeMap.set("entry", mapNode.id);
      }

      if (nodeMap.has(mapNode.id)) {
        nodeMap.get(mapNode.id).incomingCalls.push(parentHash);
        return null;
      }

      nodeMap.set(mapNode.id, mapNode);

      let callDefinitionLocations = (await Promise.all(
        callExpressionLocations.map((lineColumnFinder) => {
          const position = new Position(
            lineColumnFinder.line - 1,
            lineColumnFinder.col
          );
          return commands.executeCommand(
            "vscode.executeDefinitionProvider",
            targetFunctionUri,
            position
          );
        })
      )) as (vscode.Location | vscode.LocationLink)[][];

      const maxDefinitionFindAttempts = 5;
      let attempts = 1;

      // The VS Code API sometimes doesn't find the function definition on the first try. So we attempt it a few times.
      while (
        callDefinitionLocations.some((def) => !def.length) &&
        attempts <= maxDefinitionFindAttempts
      ) {
        callDefinitionLocations = await Promise.all(
          callDefinitionLocations.map(async (def, idx) => {
            return def.length
              ? def
              : commands.executeCommand(
                  "vscode.executeDefinitionProvider",
                  targetFunctionUri,
                  new Position(
                    callExpressionLocations[idx].line - 1,
                    callExpressionLocations[idx].col
                  )
                );
          })
        );
        attempts += 1;
      }

      /*
    VS Code API has trouble finding some functionDefinitions no matter how many attempts it makes
    Definitions it has trouble finding include:
      - methods on classes that are passed into a function as an argument

    We're handling these cases by returning a node with the callExpressionLocation. That way it should be easy
    to locate these failures and replace them with a valid node that the user finds seperately.
  */
      const verifiedCallDefinitionLocations: (
        | vscode.Location
        | vscode.LocationLink
        | FindDefinitionFail
      )[] = callDefinitionLocations.map((def, idx) =>
        def.length
          ? def[0]
          : buildFailureNode({
              failReason: FailReason.findDefinitionFail,
              callExpressionLocation: callExpressionLocations[idx],
              parentId: mapNode.id,
            })
      );

      // if (callDefinitionLocations.some((def) => !def.length)) {
      //   callDefinitionLocations = callDefinitionLocations.map((def, idx) =>
      //     !!def.length
      //       ? def
      //       : buildFailureNode({
      //           failReason: FailReason.findDefinitionFail,
      //           callExpressionLocation: callExpressionLocations[idx],
      //           parentId: mapNode.id,
      //         })
      //   );
      //   debugger;
      // }

      // const verifiedCallDefinitionLocations = verifyCallDefinitionLocations(
      //   callDefinitionLocations
      // );

      // const filteredCallDefinitionLocations =
      //   verifiedCallDefinitionLocations.filter((loc) =>
      //     loc.failure
      //       ? true
      //       : loc instanceof vscode.Location
      //       ? !loc?.uri?.path.includes("node_modules")
      //       : !loc?.targetUri?.path.includes("node_modules")
      //   );

      try {
        const childNodes = await Promise.all(
          verifiedCallDefinitionLocations.map(
            (loc) => {
              if ("failure" in loc) {
                return loc;
              } else if (loc instanceof vscode.Location) {
                // excluding node_modules by default to keep from getting too deep into esoteric code
                if (loc?.uri?.path.includes("node_modules")) {
                  return null;
                } else {
                  return buildNodeMap({
                    targetFunctionRange: loc.range,
                    targetFunctionUri: loc.uri,
                    nodeMap,
                    isEntry: false,
                    parentHash: mapNode.id,
                  });
                }
              } else {
                // excluding node_modules by default to keep from getting too deep into esoteric code
                if (loc?.targetUri?.path.includes("node_modules")) {
                  return null;
                } else {
                  return buildNodeMap({
                    targetFunctionRange: loc.targetRange,
                    targetFunctionUri: loc.targetUri,
                    nodeMap,
                    isEntry: false,
                    parentHash: mapNode.id,
                  });
                }
              }
            }
            // loc.failure
            //   ? loc
            //   : buildNodeMap({
            //       targetFunctionRange:
            //         loc instanceof vscode.Location ? loc.range : loc.targetRange,
            //       targetFunctionUri:
            //         loc instanceof vscode.Location ? loc.uri : loc.targetUri,
            //       nodeMap,
            //       isEntry: false,
            //       parentHash: mapNode.id,
            //     })
          )
        );

        console.log("[hf]", { childNodes });

        mapNode.outgoingCalls = childNodes
          .filter(ExcludeNullish)
          .map((mapNode) => mapNode.id);
      } catch (error) {
        console.error("[hf] error in recursive buildNodeMap calls", { error });
      }

      return mapNode;
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
      const targetFunctionUri = activeTextEditor?.document.uri;

      if (!targetFunctionUri) {
        throw Error("target URI for function not found");
      }

      const currentSelectionAnchor = currentSelection?.anchor;

      const targetFunctionDefintion: (vscode.Location | vscode.LocationLink)[] =
        await commands.executeCommand(
          "vscode.executeDefinitionProvider",
          targetFunctionUri,
          currentSelectionAnchor
        );

      const targetFunctionRange = targetFunctionDefintion[0]
        .targetRange as vscode.Range;

      if (!targetFunctionRange) {
        throw Error("target Range for function not found");
      }

      const nodeMap = new Map();

      const entryGraphNode = await buildNodeMap({
        targetFunctionRange,
        targetFunctionUri,
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
export function deactivate() {}
