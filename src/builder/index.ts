import * as vscode from "vscode";
import * as objectHash from "object-hash";

import CodeGraphParserTsMorph from "../parser/tsMorph";
import ReaderVSCode from "../reader/vscode";
import ScannerTsMorph from "../scanner/tsMorph";
import View from "../view/index";

import { ExcludeNullish, waitFor } from "src/utils";
import { getTsMorphNodeFunctionName } from "src/utils/tsMorph";
import type {
  EntryNodeRawData,
  NodeRawData,
  LineColumnFinder,
  FailNode,
} from "types/index";
import {
  FailReason,
  TSMorphFunctionNode,
  FindDefinitionFail,
  NodeMap,
  GraphNode,
  MapNode,
} from "types/index";

export default class Builder {
  nodeMap: NodeMap;
  entry: EntryNodeRawData;
  entryNodeId: string | undefined;
  view: View;
  failNodeNames = {
    [FailReason.findDefinitionFail]: "Find Definition Fail",
    [FailReason.parseFail]: "Parse Fail",
    [FailReason.positionFail]: "Postion Fail",
  };

  constructor(entry: EntryNodeRawData, view: View) {
    this.nodeMap = new Map();
    this.entry = entry;
    this.view = view;
  }

  public async buildNodeMap(nodeData: NodeRawData | undefined) {
    let isEntry: boolean;
    let targetFunctionRange: vscode.Range;
    let targetFunctionUri: vscode.Uri;
    let parentHash: string | undefined;

    const { nodeMap, view } = this;

    if (!nodeData) {
      isEntry = true;
      ({ targetFunctionRange, targetFunctionUri } = this.entry);
      parentHash = undefined;
    } else {
      isEntry = false;
      ({ targetFunctionRange, targetFunctionUri, parentHash } = nodeData);
    }

    const reader = new ReaderVSCode(targetFunctionRange, targetFunctionUri);
    const { targetFunctionCode, targetFileCode, targetDocument } =
      await reader.readDocument();

    const parser = new CodeGraphParserTsMorph(
      targetFunctionCode,
      targetFileCode
    );
    const { unPositionedFunctionNode, fileNode } = await parser.parse();

    if (!unPositionedFunctionNode || !fileNode) {
      console.error("parser did not return node");
      const failNode = this._buildFailureNode({
        failReason: FailReason.parseFail,
        uri: targetFunctionUri,
        range: targetFunctionRange,
        code: targetFunctionCode,
        parentId: parentHash,
      });
      if (nodeMap.has(failNode.id)) {
        parentHash && nodeMap.get(failNode.id)?.incomingCalls.push(parentHash);
      } else {
        const { panelData } = await reader.prepForPageLoad(
          failNode.id,
          "Function parse fail"
        );

        await view.loadPage(panelData);
        await view.waitForNodeSnapshot(failNode.id);

        nodeMap.set(failNode.id, failNode);
      }
      return failNode;
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

      const failNode = this._buildFailureNode({
        uri: targetFunctionUri,
        range: targetFunctionRange,
        code: targetFunctionCode,
        failReason: FailReason.positionFail,
        parentId: parentHash,
      });
      if (nodeMap.has(failNode.id)) {
        parentHash && nodeMap.get(failNode.id)?.incomingCalls.push(parentHash);
        return;
      }
      nodeMap.set(id, failNode);
      const { panelData } = await reader.prepForPageLoad(
        failNode.id,
        failNode.name
      );

      await view.loadPage(panelData);
      await view.waitForNodeSnapshot(failNode.id);

      return failNode;
    }

    const mapNode = this._buildNodeMapNodeFromTsMorphNode(
      postitionedFunctionNode,
      targetFunctionUri,
      targetFunctionRange,
      targetFunctionCode,
      parentHash
    );

    const { panelData } = await reader.prepForPageLoad(
      mapNode.id,
      mapNode.name
    );

    await view.loadPage(panelData);

    if (isEntry) {
      this.entryNodeId = mapNode.id;
    }

    if (nodeMap.has(mapNode.id) && parentHash) {
      nodeMap.get(mapNode.id)?.incomingCalls.push(parentHash);
      return null;
    }

    nodeMap.set(mapNode.id, mapNode);

    let callDefinitionLocations = (await Promise.all(
      callExpressionLocations.map((lineColumnFinder) => {
        const position = new vscode.Position(
          lineColumnFinder.line - 1,
          lineColumnFinder.col
        );
        return vscode.commands.executeCommand(
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
            : vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider",
                targetFunctionUri,
                new vscode.Position(
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
    // TODO: do I need to add these failNodes to the node map? I think probably yes.
    const verifiedCallDefinitionLocations: (
      | vscode.Location
      | vscode.LocationLink
      | FindDefinitionFail
    )[] = callDefinitionLocations.map((def, idx) =>
      def.length
        ? def[0]
        : this._buildFailureNode({
            failReason: FailReason.findDefinitionFail,
            callExpressionLocation: callExpressionLocations[idx],
            parentId: mapNode.id,
          })
    );

    await view.waitForNodeSnapshot(mapNode.id);
    /*
      It'd probably be faster (and cleaner) to allow the below returned promises from recursive calls to
      buildNodeMap to resolve in parallel. I could forego taking snapshots until the nodeMap is built and 
      then loop through it, taking the snapshots then but:
          1. I like the UX of showing the function being processed in the webview as it's being processed
          2. That would duplicate some of the work (i.e. opening documents)
          3. I'd need to put more thought into whether letting the buildNodeMap calls execute in parallel will
            mess up the building of the nodeMap in some way 
    */

    const childNodes: (MapNode | FailNode | null)[] = [];

    try {
      let idx = 0;
      for (let loc of verifiedCallDefinitionLocations) {
        if ("failure" in loc) {
          childNodes[idx] = loc;
        } else if (loc instanceof vscode.Location) {
          if (loc?.uri?.path.includes("node_modules")) {
            childNodes[idx] = null;
          } else {
            childNodes[idx] = await this.buildNodeMap({
              targetFunctionRange: loc.range,
              targetFunctionUri: loc.uri,
              parentHash: mapNode.id,
            });
          }
        } else {
          if (loc?.targetUri?.path.includes("node_modules")) {
            childNodes[idx] = null;
          } else {
            childNodes[idx] = await this.buildNodeMap({
              targetFunctionRange: loc.targetRange,
              targetFunctionUri: loc.targetUri,
              parentHash: mapNode.id,
            });
          }
        }

        idx += 1;
      }

      mapNode.outgoingCalls = childNodes
        .filter(ExcludeNullish)
        .map((mapNode) => mapNode.id);
    } catch (error) {
      console.error("[hf] error in recursive buildNodeMap calls", { error });
    }

    return mapNode;
  }

  public buildNodeGraph(nodeId: string, ancestors: string[] = []): GraphNode {
    const { nodeMap } = this;
    if (ancestors.includes(nodeId)) {
      return {
        recursionId: nodeId,
        children: [],
      };
    }

    const node = nodeMap.get(nodeId);

    const graphNode = { ...node };
    graphNode.children =
      graphNode?.outgoingCalls?.map((nodeId: string) =>
        this.buildNodeGraph(nodeId, [...ancestors, graphNode.id])
      ) || [];

    return graphNode;
  }

  private _buildNodeMapNodeFromTsMorphNode(
    node: TSMorphFunctionNode,
    targetFunctionUri: vscode.Uri,
    targetFunctionRange: vscode.Range,
    targetFunctionCode: string,
    parentHash: string | undefined
  ) {
    const astNodeHash = objectHash.sha1(node.compilerNode);
    const name = getTsMorphNodeFunctionName(node);
    const graphNode = {
      id: astNodeHash,
      // astNode: postitionedFunctionNode.compilerNode,
      uri: targetFunctionUri,
      range: targetFunctionRange,
      code: targetFunctionCode,
      incomingCalls: parentHash ? [parentHash] : [],
      outgoingCalls: [] as string[],
      name,
    };

    return graphNode;
  }

  private _buildFailureNode(
    args:
      | {
          code: string;
          failReason: FailReason.parseFail;
          uri: vscode.Uri;
          range: vscode.Range;
          parentId: string | undefined;
        }
      | {
          failReason: FailReason.findDefinitionFail;
          callExpressionLocation: LineColumnFinder;
          parentId: string | undefined;
        }
      | {
          failReason: FailReason.positionFail;
          uri: vscode.Uri;
          range: vscode.Range;
          parentId: string | undefined;
          code: string;
        }
  ): FailNode {
    const { parentId, ...rest } = args;
    const id =
      args.failReason === FailReason.parseFail
        ? objectHash.sha1(rest)
        : objectHash.sha1(args);

    return {
      ...rest,
      id,
      failure: true as true,
      incomingCalls: parentId ? [parentId] : [],
      name: this.failNodeNames[args.failReason],
    };
  }
}
