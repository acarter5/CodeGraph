import type { SourceFile } from "ts-morph";
import type { TSMorphFunctionNode } from "types/index";

export default class Scanner {
  unpostitionedFunctionNode: TSMorphFunctionNode;
  fileNode: SourceFile;
  targetFileCode: string;

  constructor(
    unpostitionedFunctionNode: TSMorphFunctionNode,
    fileNode: SourceFile,
    targetFileCode: string
  ) {
    this.unpostitionedFunctionNode = unpostitionedFunctionNode;
    this.fileNode = fileNode;
    this.targetFileCode = targetFileCode;
  }
}
