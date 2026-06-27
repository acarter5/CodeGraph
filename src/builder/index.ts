import * as vscode from "vscode";
import * as objectHash from "object-hash";

import CodeGraphParserTsMorph from "../parser/tsMorph";
import ReaderVSCode from "../reader/vscode";
import ScannerTsMorph from "../scanner/tsMorph";
import View from "../view/index";

import { getTsMorphNodeFunctionName } from "src/utils/tsMorph";
import type {
  EntryNodeRawData,
  NodeRawData,
  LineColumnFinder,
  FailNode,
  SnapshotMeta,
  GraphManifest,
  ManifestDefinition,
  ManifestPlacement,
  ManifestEdge,
  ManifestNodeKind,
  ManifestRange,
  ManifestRect,
  OutgoingCall,
} from "types/index";
import {
  FailReason,
  TSMorphFunctionNode,
  FindDefinitionFail,
  NodeMap,
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
    [FailReason.notAFunction]: "Not a Function",
  };

  constructor(entry: EntryNodeRawData, view: View, nodeMap: NodeMap) {
    this.nodeMap = nodeMap;
    this.entry = entry;
    this.view = view;
  }

  public async buildNodeMap(
    nodeData: NodeRawData | undefined
  ): Promise<MapNode | FailNode | null> {
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
    const { unPositionedFunctionNode, fileNode, externalValueDefinition } =
      await parser.parse();

    if (!unPositionedFunctionNode || !fileNode) {
      // The definition is a value, not a function. If that value is backed by a
      // node_modules callee (e.g. `const db = knex(config)`), skip it like any
      // other node_modules call — no node, no connector. (Never for the entry:
      // the user selected it, so they should see why it didn't graph.)
      if (externalValueDefinition && fileNode && !isEntry) {
        return null;
      }

      // `!fileNode` is a genuine parse failure; otherwise the file parsed fine
      // but had no function-like node at the definition (a value / dynamic
      // dispatch) — label that distinctly, not as a parse failure.
      const failReason = fileNode
        ? FailReason.notAFunction
        : FailReason.parseFail;
      console.error("parser did not return a function node", { failReason });
      const failNode = this._buildFailureNode({
        failReason,
        uri: targetFunctionUri,
        range: targetFunctionRange,
        code: targetFunctionCode,
        parentId: parentHash,
      });
      if (nodeMap.has(failNode.id)) {
        const existingNode = nodeMap.get(failNode.id) as FailNode;
        parentHash && existingNode.incomingCalls.push(parentHash);
        return existingNode;
      }

      if (isEntry) {
        this.entryNodeId = failNode.id;
        view.registerEntryNode(failNode);
      }
      nodeMap.set(failNode.id, failNode);

      // The webview renders directly from the panel data the host writes into
      // window.__data__ (Prism does the highlighting client-side), so the
      // sequence is just: load the page → wait for the snapshot to come back.
      await view.loadPage(failNode.id);
      await view.waitForNodeSnapshot();

      return failNode;
    }

    const scanner = new ScannerTsMorph(
      unPositionedFunctionNode,
      fileNode,
      targetFileCode
    );

    const {
      postitionedFunctionNode,
      callExpressionLocations,
      callExpressionNames,
      callExpressionExternal,
    } = scanner;

    if (!postitionedFunctionNode) {
      console.error("unable to find positionedFunctionNode");

      const failNode = this._buildFailureNode({
        uri: targetFunctionUri,
        range: targetFunctionRange,
        code: targetFunctionCode,
        failReason: FailReason.positionFail,
        parentId: parentHash,
      });
      if (nodeMap.has(failNode.id)) {
        parentHash && nodeMap.get(failNode.id)?.incomingCalls.push(parentHash);
        return nodeMap.get(failNode.id) as FailNode;
      }
      nodeMap.set(failNode.id, failNode);

      if (isEntry) {
        this.entryNodeId = failNode.id;
        view.registerEntryNode(failNode);
      }

      await view.loadPage(failNode.id);
      await view.waitForNodeSnapshot();

      return failNode;
    }

    const mapNode = this._buildNodeMapNodeFromTsMorphNode(
      postitionedFunctionNode,
      targetFunctionUri,
      targetFunctionRange,
      targetFunctionCode,
      parentHash
    );

    if (nodeMap.has(mapNode.id) && parentHash) {
      const existingNode = nodeMap.get(mapNode.id) as MapNode;
      existingNode.incomingCalls.push(parentHash);
      return existingNode;
    }

    if (isEntry) {
      view.registerEntryNode(mapNode);
      this.entryNodeId = mapNode.id;
    }

    // Record each call site relative to the snapshot code (row = line offset
    // from the function's first line, col = column within that line; the first
    // line starts at range.start.character, later lines at column 0). The
    // webview measures the pixel rect per call at capture time, and `definitionNodeId`
    // is filled in once definitions resolve below — both index-aligned with
    // callExpressionLocations. This drives call-site-anchored connectors.
    mapNode.outgoingCalls = callExpressionLocations.map((loc, i) => {
      const row = loc.line - 1 - targetFunctionRange.start.line;
      const col =
        loc.col - 1 - (row === 0 ? targetFunctionRange.start.character : 0);
      return {
        row,
        col,
        length: callExpressionNames[i]?.length ?? 1,
        definitionNodeId: null,
        rect: null,
      } as OutgoingCall;
    });

    nodeMap.set(mapNode.id, mapNode);

    // Load the snapshot page; the webview's app.js will Prism-highlight and
    // capture asynchronously while we kick off the executeDefinitionProvider
    // work in parallel below. We wait for the snapshot just before recursing.
    await view.loadPage(mapNode.id);

    let callDefinitionLocations = (await Promise.all(
      callExpressionLocations.map((lineColumnFinder, idx) => {
        // Provably external (bare import / builtin): don't bother the definition
        // provider — it would resolve to node_modules (skipped anyway) or, in
        // untyped JS, return nothing and become a noisy FindDefinitionFail.
        if (callExpressionExternal[idx]) {
          return Promise.resolve([] as (
            | vscode.Location
            | vscode.LocationLink
          )[]);
        }
        // `line-column` is 1-based for both line and col; `vscode.Position` is
        // 0-based for both, so subtract 1 from each. Passing `col` unconverted
        // landed the cursor one char into the identifier, which is why
        // definition resolution was flaky and leaned on the retry loop below.
        const position = new vscode.Position(
          lineColumnFinder.line - 1,
          lineColumnFinder.col - 1
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

    // The VS Code API sometimes doesn't find the function definition on the
    // first try, so we retry — but only for non-external calls (external ones
    // are intentionally left empty and handled as skips below).
    while (
      callDefinitionLocations.some(
        (def, i) => !def.length && !callExpressionExternal[i]
      ) &&
      attempts <= maxDefinitionFindAttempts
    ) {
      callDefinitionLocations = await Promise.all(
        callDefinitionLocations.map(async (def, idx) => {
          return def.length || callExpressionExternal[idx]
            ? def
            : vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider",
                targetFunctionUri,
                new vscode.Position(
                  callExpressionLocations[idx].line - 1,
                  callExpressionLocations[idx].col - 1
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
      | null
    )[] = callDefinitionLocations.map((def, idx) => {
      // Provably external — skip entirely (no node, no connector), like a
      // resolved node_modules call.
      if (callExpressionExternal[idx]) {
        return null;
      }
      return def.length
        ? def[0]
        : this._buildFailureNode(
            {
              failReason: FailReason.findDefinitionFail,
              callExpressionLocation: callExpressionLocations[idx],
              parentId: mapNode.id,
            },
            // Label the fail with the call text (e.g. "taskLogger.info") so the
            // node is identifiable instead of an anonymous "Find Definition Fail".
            callExpressionNames[idx]
          );
    });

    await view.waitForNodeSnapshot();
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
      for (let locOrFail of verifiedCallDefinitionLocations) {
        if (locOrFail === null) {
          // Provably external call — no node, no connector.
          childNodes[idx] = null;
        } else if ("failure" in locOrFail) {
          if (!nodeMap.has(locOrFail.id)) {
            nodeMap.set(locOrFail.id, locOrFail);
          } else {
            locOrFail = nodeMap.get(locOrFail.id) as FindDefinitionFail;
            locOrFail.incomingCalls.push(mapNode.id);
          }
          childNodes[idx] = locOrFail;
        } else if (locOrFail instanceof vscode.Location) {
          if (locOrFail?.uri?.path.includes("node_modules")) {
            childNodes[idx] = null;
          } else {
            childNodes[idx] = await this.buildNodeMap({
              targetFunctionRange: locOrFail.range,
              targetFunctionUri: locOrFail.uri,
              parentHash: mapNode.id,
            });
          }
        } else {
          if (locOrFail?.targetUri?.path.includes("node_modules")) {
            childNodes[idx] = null;
          } else {
            childNodes[idx] = await this.buildNodeMap({
              targetFunctionRange: locOrFail.targetRange,
              targetFunctionUri: locOrFail.targetUri,
              parentHash: mapNode.id,
            });
          }
        }

        idx += 1;
      }

      // Link each outgoing call to the definition it resolved to (index-aligned
      // with childNodes / callExpressionLocations). `null` children are
      // node_modules calls we don't snapshot, so they get no connector.
      childNodes.forEach((child, i) => {
        const outgoingCall = mapNode.outgoingCalls[i];
        if (outgoingCall) {
          outgoingCall.definitionNodeId = child ? child.id : null;
        }
      });
    } catch (error) {
      console.error("[hf] error in recursive buildNodeMap calls", { error });
    }

    return mapNode;
  }

  /*
    Serializes the built NodeMap into the graph.json manifest the FigJam
    renderer consumes. The NodeMap is the single-instance definition layer;
    here we expand it into per-level "placements" (one box per definition per
    level) plus the connector edges between them. Repeated placements of the
    same definition share `definitionId` so the renderer can color-code them.
    Cycles are broken by pointing back to the ancestor's existing placement.
  */
  public serializeGraph(
    snapshotMeta: Map<string, SnapshotMeta>
  ): GraphManifest {
    const { nodeMap, entryNodeId } = this;

    if (!entryNodeId) {
      throw Error("builder: serializeGraph: entry node not identified");
    }
    const entryNode = nodeMap.get(entryNodeId);
    if (!entryNode) {
      throw Error("builder: serializeGraph: entry node missing from node map");
    }

    // ---- definitions (dedup layer) ----
    const definitions: ManifestDefinition[] = [];
    nodeMap.forEach((node, id) => {
      definitions.push({
        id,
        name: node.name || "Anonymous",
        kind: this._manifestKind(node),
        image: snapshotMeta.get(id) ?? null,
        source: this._manifestSource(node),
      });
    });

    // ---- placements + edges (expand per (definition, level)) ----
    const placements: ManifestPlacement[] = [];
    const edges: ManifestEdge[] = [];
    const seenPlacements = new Set<string>();

    const visit = (
      nodeId: string,
      level: number,
      ancestors: Map<string, number>
    ) => {
      const placementId = `${nodeId}@${level}`;
      if (seenPlacements.has(placementId)) {
        return;
      }
      seenPlacements.add(placementId);
      placements.push({ id: placementId, definitionId: nodeId, level });

      const node = nodeMap.get(nodeId);
      const nextAncestors = new Map(ancestors).set(nodeId, level);
      // Recurse into each distinct child once (placements dedup by level), but
      // emit an edge per call below — multiple calls to the same definition get
      // their own connectors.
      const recursed = new Set<string>();

      const linkChild = (childId: string, callSiteRect?: ManifestRect) => {
        const ancestorLevel = nextAncestors.get(childId);
        if (ancestorLevel !== undefined) {
          // Cycle: point backward to the ancestor's existing placement.
          edges.push({
            from: placementId,
            to: `${childId}@${ancestorLevel}`,
            recursion: true,
            ...(callSiteRect ? { callSiteRect } : {}),
          });
          return;
        }
        edges.push({
          from: placementId,
          to: `${childId}@${level + 1}`,
          ...(callSiteRect ? { callSiteRect } : {}),
        });
        if (!recursed.has(childId)) {
          recursed.add(childId);
          visit(childId, level + 1, nextAncestors);
        }
      };

      // One edge per outgoing call (so multiple calls to the same definition
      // each get their own connector, anchored at the call). Fail nodes have no
      // outgoingCalls. Skip node_modules calls (definitionNodeId null).
      const outgoingCalls =
        node && "outgoingCalls" in node ? node.outgoingCalls : [];
      for (const call of outgoingCalls) {
        if (call.definitionNodeId) {
          linkChild(call.definitionNodeId, call.rect ?? undefined);
        }
      }
    };

    visit(entryNodeId, 0, new Map());

    return {
      version: 1,
      entryDefinitionId: entryNodeId,
      source: {
        name: entryNode.name || "Anonymous",
        uri: "uri" in entryNode ? entryNode.uri.toString() : "",
      },
      definitions,
      placements,
      edges,
    };
  }

  private _manifestKind(node: MapNode | FailNode): ManifestNodeKind {
    if (!("failure" in node)) {
      return "function";
    }
    if (node.failReason === FailReason.parseFail) {
      return "parseFail";
    }
    if (node.failReason === FailReason.positionFail) {
      return "positionFail";
    }
    if (node.failReason === FailReason.notAFunction) {
      return "notAFunction";
    }
    return "findDefinitionFail";
  }

  private _manifestSource(
    node: MapNode | FailNode
  ): { uri: string; range: ManifestRange } | null {
    if (!("uri" in node) || !("range" in node)) {
      return null;
    }
    const { uri, range } = node;
    return {
      uri: uri.toString(),
      range: {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
      },
    };
  }

  private _buildNodeMapNodeFromTsMorphNode(
    node: TSMorphFunctionNode,
    targetFunctionUri: vscode.Uri,
    targetFunctionRange: vscode.Range,
    targetFunctionCode: string,
    parentHash: string | undefined
  ) {
    const name = getTsMorphNodeFunctionName(node);

    // Identity = the definition's source location (uri + range), which is what
    // makes two references to the same function dedup to one NodeMap entry.
    // We hash that rather than `node.compilerNode` (BUGS.md #8): a raw TS
    // compiler node carries circular `.parent` back-pointers and a large
    // subtree, so hashing it is slow and risks blowing up on the cycles.
    // Flatten the vscode.Range to plain numbers so object-hash sees stable
    // values, not getter-backed objects.
    const astNodeHash = objectHash.sha1({
      uri: targetFunctionUri.toString(),
      range: {
        start: {
          line: targetFunctionRange.start.line,
          character: targetFunctionRange.start.character,
        },
        end: {
          line: targetFunctionRange.end.line,
          character: targetFunctionRange.end.character,
        },
      },
      name,
    });

    const graphNode: MapNode = {
      id: astNodeHash,
      uri: targetFunctionUri,
      range: targetFunctionRange,
      code: targetFunctionCode,
      incomingCalls: parentHash ? [parentHash] : [],
      outgoingCalls: [],
      name,
    };

    return graphNode;
  }

  private _buildFailureNode(
    args:
      | {
          code: string;
          failReason: FailReason.parseFail | FailReason.notAFunction;
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
        },
    // For findDefinitionFail nodes, the call text (e.g. "taskLogger.info") used
    // as the node's label. Kept out of `args` so the node id (hashed from args)
    // is unchanged — only the display name varies per call site.
    callExpressionName?: string
  ): FailNode {
    const { parentId, ...rest } = args;
    // parseFail / notAFunction hash on the file+range only (not parentId) so a
    // value/unparseable definition referenced from many call sites dedups to a
    // single node.
    const id =
      args.failReason === FailReason.parseFail ||
      args.failReason === FailReason.notAFunction
        ? objectHash.sha1(rest)
        : objectHash.sha1(args);

    const name =
      args.failReason === FailReason.findDefinitionFail && callExpressionName
        ? callExpressionName
        : this.failNodeNames[args.failReason];

    return {
      ...rest,
      id,
      failure: true as true,
      incomingCalls: parentId ? [parentId] : [],
      name,
    };
  }
}
