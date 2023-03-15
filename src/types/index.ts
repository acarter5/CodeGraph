import * as vscode from "vscode";

import * as ts from "typescript";

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
};

export type ParseFail = {
  id: string;
  failure: true;
  incomingCalls: string[];
  code: string;
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
  children: (MapNode | FailNode)[];
};

export type PageData = {
  functionName: string;
  uri: vscode.Uri;
  start: number;
  end: number;
  range: vscode.Range;
};