import { Project, SyntaxKind, ts } from "ts-morph";
import { ExcludeNullish } from "../utils/index";
import CodeGraphParser from "./index";

export default class CodeGraphParserTsMorph extends CodeGraphParser {
  constructor(targetFunctionCode: string, targetFileCode: string) {
    super(targetFunctionCode, targetFileCode);
  }

  async parse() {
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
}
