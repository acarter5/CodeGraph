import type { SourceFile } from "ts-morph";
import type { TSMorphFunctionNode } from "types/index";

export default class Scanner {
  // Already positioned — a real node in the full-file AST (found by position in
  // the Parser), so the Scanner can go straight to collecting call expressions
  // without any structural re-match.
  positionedFunctionNode: TSMorphFunctionNode;
  fileNode: SourceFile;
  targetFileCode: string;
  // Real on-disk path of the scanned file. `fileNode` is parsed from a string
  // under a synthetic name ("file.ts"), so it can't be used to resolve this
  // file's imports — classifying a call as external needs the true path.
  containingFilePath: string | undefined;

  constructor(
    positionedFunctionNode: TSMorphFunctionNode,
    fileNode: SourceFile,
    targetFileCode: string,
    containingFilePath?: string
  ) {
    this.positionedFunctionNode = positionedFunctionNode;
    this.fileNode = fileNode;
    this.targetFileCode = targetFileCode;
    this.containingFilePath = containingFilePath;
  }
}
