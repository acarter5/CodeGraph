import type {
  SourceFile,
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunction,
} from "ts-morph";

export default class Scanner {
  unpostitionedFunctionNode:
    | FunctionDeclaration
    | FunctionExpression
    | ArrowFunction;
  fileNode: SourceFile;
  targetFileCode: string;

  constructor(
    unpostitionedFunctionNode:
      | FunctionDeclaration
      | FunctionExpression
      | ArrowFunction,
    fileNode: SourceFile,
    targetFileCode: string
  ) {
    this.unpostitionedFunctionNode = unpostitionedFunctionNode;
    this.fileNode = fileNode;
    this.targetFileCode = targetFileCode;
  }
}
