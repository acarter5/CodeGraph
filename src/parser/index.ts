import type * as vscode from "vscode";

export default class CodeGraphParser {
  targetFunctionCode: string;
  targetFileCode: string;
  // The definition's span in its file, from `executeDefinitionProvider` (or the
  // user's selection for the entry). We look the function node up by this
  // position in the full-file AST instead of reparsing the isolated snippet and
  // structurally re-matching it — see TODO.md `position-based-node-lookup`.
  targetFunctionRange: vscode.Range;

  constructor(
    targetFunctionCode: string,
    targetFileCode: string,
    targetFunctionRange: vscode.Range
  ) {
    this.targetFunctionCode = targetFunctionCode;
    this.targetFileCode = targetFileCode;
    this.targetFunctionRange = targetFunctionRange;
  }
}
