import * as vscode from "vscode";

import {
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunction,
} from "ts-morph";

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
}

export type FindDefinitionFail = {
  id: string;
  failure: true;
  incomingCalls: string[];
  callExpressionLocation: LineColumnFinder;
  failReason: FailReason.findDefinitionFail;
};

export type ParseFail = {
  id: string;
  failure: true;
  incomingCalls: string[];
  code: string;
  failReason: FailReason.parseFail;
};

export type FailNode = FindDefinitionFail | ParseFail;

export type EntryNodeRawData = {
  targetFunctionRange: vscode.Range;
  targetFunctionUri: vscode.Uri;
};

export type NodeRawData = EntryNodeRawData & {
  parentHash: string;
};

export type NodeMap = Map<string, MapNode | FailNode>;

export type GraphNode = (MapNode | FailNode | { recursionId: string }) & {
  children: (MapNode | FailNode)[];
};

export type PageData = {
  code: string;
  uri: vscode.Uri;
  range: vscode.Range;
};