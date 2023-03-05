import * as vscode from "vscode";
import CodeGraphParserTsMorph from "./parser/tsMorph";
import ReaderVSCode from "./reader/vscode";
import ScannerTsMorph from "./scanner/tsMorph";
import {
  buildNodeMapNodeFromTsMorphNode,
  ExcludeNullish,
  verifyCallDefinitionLocations,
} from "src/utils/index";

import * as objectHash from "object-hash";
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
  const { targetFunctionCode, targetFileCode } = await reader.readDocument();

  const parser = new CodeGraphParserTsMorph(targetFunctionCode, targetFileCode);
  const { unPositionedFunctionNode, fileNode } = await parser.parse();

  if (!unPositionedFunctionNode || !fileNode) {
    debugger;
    console.error("parser hasnt returned node");
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

  const scanner = new ScannerTsMorph(
    unPositionedFunctionNode,
    fileNode,
    targetFileCode
  );

  const { postitionedFunctionNode, callExpressionLocations } = scanner;

  const graphNode = buildNodeMapNodeFromTsMorphNode(
    postitionedFunctionNode,
    targetFunctionUri,
    targetFunctionRange,
    targetFunctionCode,
    isEntry,
    parentHash
  );

  if (isEntry) {
    nodeMap.set("entry", graphNode.id);
  }

  if (nodeMap.has(graphNode.id)) {
    nodeMap.get(graphNode.id).incomingCalls.push(parentHash);
    return null;
  }

  nodeMap.set(graphNode.id, graphNode);

  const callDefinitionLocations = (await Promise.all(
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

  const verifiedCallDefinitionLocation = verifyCallDefinitionLocations(
    callDefinitionLocations
  );

  const filteredCallDefinitionLocation = verifiedCallDefinitionLocation.filter(
    (loc) =>
      loc instanceof vscode.Location
        ? !loc?.uri?.path.includes("node_modules")
        : !loc?.targetUri?.path.includes("node_modules")
  );

  try {
    graphNode.outgoingCalls = (
      await Promise.all(
        filteredCallDefinitionLocation.map(async (loc) =>
          buildNodeMap({
            targetFunctionRange:
              loc instanceof vscode.Location ? loc.range : loc.targetRange,
            targetFunctionUri:
              loc instanceof vscode.Location ? loc.uri : loc.targetUri,
            nodeMap,
            isEntry: false,
            parentHash: graphNode.id,
          })
        )
      )
    )
      .filter(ExcludeNullish)
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
