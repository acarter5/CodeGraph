import * as vscode from "vscode";
import Reader from "./index";

const { workspace: ws, window } = vscode;

export default class ReaderVSCode extends Reader {
  targetDocument: vscode.TextDocument | undefined;
  targetFunctionCode: string | undefined;
  targetFileCode: string | undefined;

  constructor(
    targetFunctionRange: vscode.Range,
    targetFunctionUri: vscode.Uri
  ) {
    super(targetFunctionRange, targetFunctionUri);
  }

  public async readDocument() {
    if (this.targetDocument && this.targetFunctionCode && this.targetFileCode) {
      return {
        targetDocument: this.targetDocument,
        targetFunctionCode: this.targetFunctionCode,
        targetFileCode: this.targetFileCode,
      };
    }
    const { targetFunctionUri, targetFunctionRange } = this;
    let targetDocument: vscode.TextDocument;
    let targetFunctionCode: string;
    let targetFileCode: string;

    try {
      targetDocument = await ws.openTextDocument(targetFunctionUri);
      if (!targetDocument) {
        throw Error(`unable to open document at ${targetFunctionUri}`);
      }
    } catch (error) {
      console.error("VSCODE API - error opening file", {
        error,
        uri: targetFunctionUri.path,
      });
      throw Error("VSCODE API - error opening file");
    }

    try {
      targetFunctionCode = targetDocument?.getText(targetFunctionRange);
      if (!targetFunctionCode || targetFunctionCode === "") {
        throw Error(
          `unable to find functiontion code. ${{
            found: targetFunctionCode,
          }}`
        );
      }
    } catch (error) {
      console.error(
        "VSCODE API - error reading functiontion code from document",
        {
          error,
          uri: targetFunctionUri.path,
          range: targetFunctionRange,
        }
      );
      throw Error("VSCODE API - error reading functiontion code from document");
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
        uri: targetFunctionUri.path,
      });
      throw Error("VSCODE API - error reading full file text");
    }

    this.targetDocument = targetDocument;
    this.targetFileCode = targetFileCode;
    this.targetFunctionCode = targetFunctionCode;

    return { targetDocument, targetFunctionCode, targetFileCode };
  }

  public async prepForPageLoad(nodeId: string, functionName: string) {
    const { targetDocument, targetFunctionRange } = this;

    if (!targetDocument) {
      throw Error("target document not instantiated");
    }

    const textEditor = await vscode.window.showTextDocument(targetDocument);

    const targetFunctionSelection = new vscode.Selection(
      targetFunctionRange.start.line,
      targetFunctionRange.start.character,
      targetFunctionRange.end.line,
      targetFunctionRange.end.character
    );

    textEditor.selection = targetFunctionSelection;

    await vscode.commands.executeCommand(
      "editor.action.clipboardCopyWithSyntaxHighlightingAction"
    );

    return {
      panelData: {
        uri: this.targetFunctionUri,
        start: targetFunctionRange.start.line,
        end: targetFunctionRange.end.line,
        nodeId: nodeId,
        functionName,
        range: targetFunctionRange,
      },
    };
  }
}
