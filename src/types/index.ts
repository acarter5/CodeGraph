import * as vscode from "vscode";

import * as ts from "typescript";

import {
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunction,
} from "ts-morph";

import { MESSAGES } from "src/constants/index";

// @ts-expect-error
import type { LineColumnFinder } from "line-column";
import { Map } from "typescript";
// @ts-expect-error
export type { LineColumnFinder } from "line-column";

export type TSMorphFunctionNode =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunction;

export type MapNode = {
  id: string;
  uri: vscode.Uri;
  range: vscode.Range;
  code: string;
  incomingCalls: string[];
  outgoingCalls: string[];
  name: string | undefined;
};

export enum FailReason {
  parseFail = "parser did not return node",
  findDefinitionFail = "could not find definition for call expression",
  positionFail = "could not position function AST Node",
}

export type FindDefinitionFail = {
  id: string;
  failure: true;
  incomingCalls: string[];
  callExpressionLocation: LineColumnFinder;
  failReason: FailReason.findDefinitionFail;
  name: string;
};

export type PositionFail = {
  id: string;
  failure: true;
  incomingCalls: string[];
  failReason: FailReason.positionFail;
  name: string;
  uri: vscode.Uri;
  range: vscode.Range;
  code: string;
};

export type ParseFail = {
  id: string;
  failure: true;
  incomingCalls: string[];
  code: string;
  uri: vscode.Uri;
  range: vscode.Range;
  failReason: FailReason.parseFail;
  name: string;
};

export type FailNode = FindDefinitionFail | ParseFail | PositionFail;

export type EntryNodeRawData = {
  targetFunctionRange: vscode.Range;
  targetFunctionUri: vscode.Uri;
};

export type NodeRawData = EntryNodeRawData & {
  parentHash: string;
};

export type NodeMap = ts.ESMap<string, MapNode | FailNode>;

export type GraphNode = (MapNode | FailNode | { recursionId: string }) & {
  children: GraphNode[];
};

export type PageData = {
  functionName: string;
  uri: vscode.Uri;
  start: number;
  end: number;
  range: vscode.Range;
};

// Messages posted from the webview (resources/app.js) back to the extension.
export type WebviewMessage =
  | {
      type: MESSAGES.snapshotTaken;
      data: {
        snapshotedNode: string;
        img: string;
        width: number;
        height: number;
        scale: number;
      };
    }
  | { type: "copied" }
  | { type: "download"; data: string }
  | { type: "tweet" }
  | { type: "beer" };

// Metadata about a written snapshot PNG, recorded by `View` keyed by node id.
export type SnapshotMeta = {
  file: string; // PNG filename, relative to the graph's output folder
  width: number;
  height: number;
  scale: number;
};

// ---- graph.json manifest (the deliverable consumed by the FigJam renderer) ----

export type ManifestNodeKind =
  | "function"
  | "parseFail"
  | "positionFail"
  | "findDefinitionFail";

// A point in a source file, mirroring `vscode.Position`: zero-based `line` and
// `character` (column). Plain JSON — we flatten `vscode.Position` into this so
// the manifest carries no VS Code objects.
export type ManifestPosition = { line: number; character: number };

// A source span, mirroring `vscode.Range` — the `start`/`end` of a definition's
// code in its file. Serialized form of `vscode.Range`; used for "jump to source"
// in the renderer and for debugging which slice of the file a node came from.
export type ManifestRange = {
  start: ManifestPosition;
  end: ManifestPosition;
};

// A unique function (dedup layer). The `id` is the color key the renderer
// uses to tie repeated placements of the same definition together.
export type ManifestDefinition = {
  id: string;
  name: string;
  kind: ManifestNodeKind;
  image: SnapshotMeta | null; // null when no snapshot exists (e.g. findDefinitionFail)
  source: { uri: string; range: ManifestRange } | null;
};

// A box actually drawn — one per (definition, level). The same definition can
// produce several placements; all share `definitionId`.
export type ManifestPlacement = {
  id: string; // `${definitionId}@${level}`
  definitionId: string;
  level: number;
};

// A connector between two placements, anchored at the caller's call site.
export type ManifestEdge = {
  from: string; // placement id
  to: string; // placement id
  callSite?: ManifestPosition;
  recursion?: true; // back-edge to an ancestor; renderer may draw it differently
};

export type GraphManifest = {
  version: 1;
  entryDefinitionId: string;
  source: { name: string; uri: string };
  definitions: ManifestDefinition[];
  placements: ManifestPlacement[];
  edges: ManifestEdge[];
};