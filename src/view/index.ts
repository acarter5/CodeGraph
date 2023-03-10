import { resolve, join } from "path";
import * as vscode from "vscode";
import type { PageData } from "types/index";
import { readFile, PathLike } from "fs";

import { placeholders } from "src/constants/index";

export default class View {
  panel: vscode.WebviewPanel;
  context: vscode.ExtensionContext;
  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.panel = vscode.window.createWebviewPanel(
      "codegraph-tab",
      "CodeGraph",
      {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
      },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(context.extensionPath)],
      }
    );
  }

  public async loadPage(data: PageData) {
    const contentPath = resolve(
      this.context.extensionPath,
      "resources",
      "index.html"
    );
    let html = await this._read(contentPath);

    const replacements: { key: string; value: string | vscode.Uri }[] =
      placeholders.map(({ key, value }) => ({
        key,
        value: this.panel.webview.asWebviewUri(
          this._generateInternalUri(this.context.extensionPath, value)
        ),
      }));

    replacements.push({
      key: "__DATA_PLACEHOLDER__",
      value: JSON.stringify(JSON.stringify(data)),
    });

    replacements.forEach(({ key, value }) => {
      html = html.replace(key, value);
    });

    html = html.replace(/__CSP_SOURCE__/g, this.panel.webview.cspSource);
    this.panel.webview.html = html;
  }

  private _read(path: PathLike): Promise<string> {
    return new Promise((resolve, reject) =>
      readFile(path, "utf-8", (err, data) => {
        if (err) {
          return reject(err);
        }

        resolve(data);
      })
    );
  }

  private _generateInternalUri(extensionPath: string, value: string) {
    return vscode.Uri.file(join(extensionPath, "resources", value));
  }
}
