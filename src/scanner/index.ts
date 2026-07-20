import type { SourceFile } from "ts-morph";
import type { TSMorphFunctionNode } from "types/index";

export default class Scanner {
  unpostitionedFunctionNode: TSMorphFunctionNode;
  fileNode: SourceFile;
  targetFileCode: string;
  // Real on-disk path of the scanned file. `fileNode` is parsed from a string
  // under a synthetic name ("file.ts"), so it can't be used to resolve this
  // file's imports — classifying a call as external needs the true path.
  containingFilePath: string | undefined;

  constructor(
    unpostitionedFunctionNode: TSMorphFunctionNode,
    fileNode: SourceFile,
    targetFileCode: string,
    containingFilePath?: string
  ) {
    this.unpostitionedFunctionNode = unpostitionedFunctionNode;
    this.fileNode = fileNode;
    this.targetFileCode = targetFileCode;
    this.containingFilePath = containingFilePath;
  }
}
