import * as vscode from "vscode";
import { Project, SyntaxKind, ts } from "ts-morph";
import * as typescript from "typescript";
import { ExcludeNullish } from "./utils/index";

const {
  window: { activeTextEditor, showTextDocument },
  commands,
  workspace: ws,
  Position,
  Uri,
} = vscode;

export default class CodeGraphParser {
  targetFunctionCode: string;
  targetFileCode: string;

  constructor(targetFunctionCode: string, targetFileCode: string) {
    this.targetFunctionCode = targetFunctionCode;
    this.targetFileCode = targetFileCode;
  }

  async tSMorphParse() {
    // get unpositioned function node
    const { targetFunctionCode, targetFileCode } = this;

    const funcProject = new Project();
    funcProject.createSourceFile("func.ts", targetFunctionCode);
    const funcSourceFile = funcProject.getSourceFiles()[0];

    const maybeFunctionDeclarationNode =
      funcSourceFile.getFirstDescendantByKind(SyntaxKind.FunctionDeclaration);
    const maybeArrowFunctionDeclaration =
      funcSourceFile.getFirstDescendantByKind(SyntaxKind.ArrowFunction);
    const maybeFunctionExpressionnNode =
      funcSourceFile.getFirstDescendantByKind(SyntaxKind.FunctionExpression);

    const functionDefinition = [
      maybeFunctionDeclarationNode,
      maybeArrowFunctionDeclaration,
      maybeFunctionExpressionnNode,
    ]
      .filter(ExcludeNullish)
      .sort((nodeA, nodeB) => {
        return nodeA?.getStart() - nodeB?.getStart();
      })[0];

    const fileProject = new Project();
    fileProject.createSourceFile("file.ts", targetFileCode);
    const fileSourceFile = fileProject.getSourceFiles()[0];

    return {
      unPositionedFunctionNode: functionDefinition,
      fileNode: fileSourceFile,
    };
  }

  //   async tsNativeParse() {
  //     const tsSourceFile = ts.createSourceFile(
  //       "test.ts",
  //       targetFunctionCode,
  //       ts.ScriptTarget.ES5,
  //       true
  //     );
  //   }
}
