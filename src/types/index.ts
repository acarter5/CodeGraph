import * as vscode from "vscode";

import * as ts from "typescript";

import {
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunction,
  MethodDeclaration,
  ConstructorDeclaration,
  GetAccessorDeclaration,
  SetAccessorDeclaration,
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
  | ArrowFunction
  | MethodDeclaration
  | ConstructorDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration;

// One call this node makes — a call expression inside the node's code. Carries
// the call site so we can anchor a connector at the precise call token: `row`/
// `col` are 0-based, relative to the snapshot's `code` (row = line offset from
// the function start; col = column within that line). `definitionNodeId` is filled once
// the call's definition resolves (null for node_modules / unresolved calls);
// `rect` is the normalized pixel box of the call token, measured in the webview.
export type OutgoingCall = {
  row: number;
  col: number;
  length: number;
  definitionNodeId: string | null;
  rect: ManifestRect | null;
};

export type MapNode = {
  id: string;
  uri: vscode.Uri;
  range: vscode.Range;
  code: string;
  incomingCalls: string[];
  // One entry per call expression in this node's code (in source order). The
  // single source of truth for what this node calls — each entry's
  // `definitionNodeId` is the called definition's node id.
  outgoingCalls: OutgoingCall[];
  name: string | undefined;
};

export enum FailReason {
  parseFail = "parser did not return node",
  findDefinitionFail = "could not find definition for call expression",
  positionFail = "could not position function AST Node",
  // Resolved + parsed fine, but the definition isn't a function — it's a value
  // (e.g. `const db = knex(config)`) or an object map for dynamic dispatch.
  notAFunction = "definition is a value, not a function",
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

export type NotAFunctionFail = {
  id: string;
  failure: true;
  incomingCalls: string[];
  code: string;
  uri: vscode.Uri;
  range: vscode.Range;
  failReason: FailReason.notAFunction;
  name: string;
};

export type FailNode =
  | FindDefinitionFail
  | ParseFail
  | PositionFail
  | NotAFunctionFail;

export type EntryNodeRawData = {
  targetFunctionRange: vscode.Range;
  targetFunctionUri: vscode.Uri;
};

export type NodeRawData = EntryNodeRawData & {
  parentHash: string;
};

export type NodeMap = ts.ESMap<string, MapNode | FailNode>;

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
        // Per-call-site normalized rects, index-aligned with the node's
        // callSites; null where a call token couldn't be measured.
        callSiteRects?: (ManifestRect | null)[];
      };
    }
  | { type: "copied" }
  | { type: "download"; data: string }
  | { type: "tweet" }
  | { type: "beer" };

// Metadata about a written snapshot PNG, recorded by `View` keyed by node id.
export type SnapshotMeta = {
  // PNG filename, relative to the graph's output folder. The FigJam plugin
  // resolves this against the manifest URL and fetches the image bytes from the
  // local server (see CLAUDE.md "Client ↔ backend integration").
  file: string;
  width: number;
  height: number;
  scale: number;
};

// ---- graph.json manifest (the deliverable consumed by the FigJam renderer) ----

export type ManifestNodeKind =
  | "function"
  | "parseFail"
  | "positionFail"
  | "findDefinitionFail"
  | "notAFunction";

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

// A rectangle normalized to [0..1] relative to a definition's snapshot image
// (the captured `#content` node, title bar + gutter included). Used to anchor a
// connector at a call site inside the caller's image; normalized so it survives
// the image being scaled to its logical box in FigJam.
export type ManifestRect = {
  x: number;
  y: number;
  width: number;
  height: number;
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
  from: string; // placement id (the caller)
  to: string; // placement id (the definition)
  // Normalized box of the call token within the caller's image. When present,
  // the renderer anchors the connector at the call site rather than the box
  // edge. Absent for fail nodes (no snapshot) or unmeasurable calls.
  callSiteRect?: ManifestRect;
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