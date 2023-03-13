import * as vscode from "vscode";
import * as objectHash from "object-hash";

import CodeGraphParserTsMorph from "../parser/tsMorph";
import ReaderVSCode from "../reader/vscode";
import ScannerTsMorph from "../scanner/tsMorph";
import View from "../view/index";

import { ExcludeNullish } from "src/utils";
import { getTsMorphNodeFunctionName } from "src/utils/tsMorph";
import type {
  EntryNodeRawData,
  NodeRawData,
  LineColumnFinder,
} from "types/index";
import {
  FailReason,
  TSMorphFunctionNode,
  FindDefinitionFail,
  NodeMap,
  GraphNode,
} from "types/index";

export default class Builder {
  nodeMap: NodeMap;
  entry: EntryNodeRawData;
  entryNodeId: string | undefined;
  view: View;
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

    const { activeTextEditor } = vscode.window;

    if (!nodeData) {
      isEntry = true;
      ({ targetFunctionRange, targetFunctionUri } = this.entry);
      parentHash = undefined;
    } else {
      isEntry = false;
      ({ targetFunctionRange, targetFunctionUri, parentHash } = nodeData);
      parentHash = undefined;
    }

    const reader = new ReaderVSCode(targetFunctionRange, targetFunctionUri);
    const { targetFunctionCode, targetFileCode, targetDocument } =
      await reader.readDocument();

    const panelData = {
      code: targetFunctionCode,
      uri: targetFunctionUri,
      range: targetFunctionRange,
      start: targetFunctionRange.start.line,
      end: targetFunctionRange.end.line,
    };

    const textEditor = await vscode.window.showTextDocument(targetDocument);

    const targetFunctionSelection = new vscode.Selection(
      targetFunctionRange.start.line,
      targetFunctionRange.start.character,
      targetFunctionRange.end.line,
      targetFunctionRange.end.character
    );

    textEditor.selection = targetFunctionSelection;

    console.log("[hf]", {
      textEditor,
      targetFunctionSelection,
      textEditorSelection: textEditor.selection,
    });

    // await vscode.commands.executeCommand(
    //   "editor.action.goToLocations",
    //   targetFunctionUri,
    //   new vscode.Position(
    //     targetFunctionRange.start.line,
    //     targetFunctionRange.start.character
    //   ),
    //   [],
    //   "goto",
    //   "done fucked up"
    // );

    // if (activeTextEditor) {
    //   activeTextEditor.selection = new vscode.Selection(
    //     targetFunctionRange.start.line,
    //     targetFunctionRange.start.character,
    //     targetFunctionRange.end.line,
    //     targetFunctionRange.end.character
    //   );
    // }

    await vscode.commands.executeCommand(
      "editor.action.clipboardCopyWithSyntaxHighlightingAction"
    );

    await view.loadPage(panelData);

    const parser = new CodeGraphParserTsMorph(
      targetFunctionCode,
      targetFileCode
    );
    const { unPositionedFunctionNode, fileNode } = await parser.parse();

    if (!unPositionedFunctionNode || !fileNode) {
      console.error("parser did not return node");
      const node = this._buildFailureNode({
        failReason: FailReason.parseFail,
        uri: targetFunctionUri,
        range: targetFunctionRange,
        code: targetFunctionCode,
        parentId: parentHash,
      });
      if (nodeMap.has(node.id)) {
        parentHash && nodeMap.get(node.id)?.incomingCalls.push(parentHash);
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
        uri: targetFunctionUri,
        range: targetFunctionRange,
        code: targetFunctionCode,
        incomingCalls: parentHash ? [parentHash] : [],
        outgoingCalls: [],
        name: "Not found",
      };
      nodeMap.set(id, node);
      return node;
    }

    const mapNode = this._buildNodeMapNodeFromTsMorphNode(
      postitionedFunctionNode,
      targetFunctionUri,
      targetFunctionRange,
      targetFunctionCode,
      parentHash
    );

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

    try {
      const childNodes = await Promise.all(
        verifiedCallDefinitionLocations.map((loc) => {
          if ("failure" in loc) {
            return loc;
          } else if (loc instanceof vscode.Location) {
            // excluding node_modules by default to keep from getting too deep into esoteric code
            if (loc?.uri?.path.includes("node_modules")) {
              return null;
            } else {
              return this.buildNodeMap({
                targetFunctionRange: loc.range,
                targetFunctionUri: loc.uri,
                parentHash: mapNode.id,
              });
            }
          } else {
            // excluding node_modules by default to keep from getting too deep into esoteric code
            if (loc?.targetUri?.path.includes("node_modules")) {
              return null;
            } else {
              return this.buildNodeMap({
                targetFunctionRange: loc.targetRange,
                targetFunctionUri: loc.targetUri,
                parentHash: mapNode.id,
              });
            }
          }
        })
      );

      console.log("[hf]", { childNodes });

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
  ) {
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
    };
  }
}
