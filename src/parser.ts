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
  targetFuncRange: vscode.Range;
  targetFuncUri: vscode.Uri;
  targetDocument: vscode.TextDocument | undefined;
  targetFuncCode: string | undefined;
  targetFileCode: string | undefined;

  constructor(targetFuncRange: vscode.Range, targetFuncUri: vscode.Uri) {
    this.targetFuncRange = targetFuncRange;
    this.targetFuncUri = targetFuncUri;
  }

  async readDocument() {
    const { targetFuncUri, targetFuncRange } = this;
    let targetDocument: vscode.TextDocument;
    let targetFuncCode: string;
    let targetFileCode: string;

    try {
      targetDocument = await ws.openTextDocument(targetFuncUri);
      if (!targetDocument) {
        throw Error(`unable to open document at ${targetFuncUri}`);
      }
    } catch (error) {
      console.error("VSCODE API - error opening file", {
        error,
        uri: targetFuncUri.path,
      });
      throw Error("VSCODE API - error opening file");
    }

    try {
      targetFuncCode = targetDocument?.getText(targetFuncRange);
      if (!targetFuncCode || targetFuncCode === "") {
        throw Error(
          `unable to find function code. ${{
            found: targetFuncCode,
          }}`
        );
      }
    } catch (error) {
      console.error("VSCODE API - error reading function code from document", {
        error,
        uri: targetFuncUri.path,
        range: targetFuncRange,
      });
      throw Error("VSCODE API - error reading function code from document");
    }

    try {
      targetFileCode = targetDocument?.getText();
      if (!targetFileCode || targetFileCode === "") {
        throw Error(
          `unable to find file code. ${{
            found: targetFileCode,
          }}`
        );
      }
    } catch (error) {
      console.error("VSCODE API - error reading full file text", {
        error,
        uri: targetFuncUri.path,
      });
      throw Error("VSCODE API - error reading full file text");
    }

    this.targetDocument = targetDocument;
    this.targetFileCode = targetFileCode;
    this.targetFuncCode = targetFuncCode;

    return { targetDocument, targetFuncCode, targetFileCode };
  }

  async tSMorphParse() {
    // get unpositioned function node
    const { targetFuncCode, targetFileCode } =
      this.targetFuncCode && this.targetFileCode
        ? this
        : await this.readDocument();

    const funcProject = new Project();
    funcProject.createSourceFile("func.ts", targetFuncCode);
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
  //       targetFuncCode,
  //       ts.ScriptTarget.ES5,
  //       true
  //     );
  //   }
}
