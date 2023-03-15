import { resolve, join } from "path";
import * as vscode from "vscode";
import type { PageData } from "types/index";
import { readFile, PathLike } from "fs";

import { placeholders, MESSAGES } from "src/constants/index";
import { waitFor } from "src/utils/index";

export default class View {
  panel: vscode.WebviewPanel;
  context: vscode.ExtensionContext;
  lastSnapshotedNode: string | null;
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

    this.lastSnapshotedNode = null;

    this.panel.webview.onDidReceiveMessage(async ({ type, data, message }) => {
      console.log("[hf] in panel callBack", {
        prevSnapshotedNode: this.lastSnapshotedNode,
        newSnapshotedNode: data.snapshotedNode,
        this: this,
        type,
        data,
      });
      if ((type = MESSAGES.snapshotTaken)) {
        this.lastSnapshotedNode = data.snapshotedNode;
      }
    });
  }

  public async loadPage(panelData: PageData) {
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
      value: JSON.stringify(JSON.stringify(panelData)),
    });

    replacements.forEach(({ key, value }) => {
      html = html.replace(key, value);
    });

    html = html.replace(/__CSP_SOURCE__/g, this.panel.webview.cspSource);
    this.panel.webview.html = html;
  }

  public getLastSnapshotedNode() {
    return this.lastSnapshotedNode;
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

  /*
    I could incorperate this into the loadPage method but I think there will be instances where I want to allow
    unblocked work to happen between initiating the page load for the current node and moving on to build the next node
  */
  public async waitForNodeSnapshot(nodeId: string) {
    let attemptWaitForSnapshot = 0;
    const successCondition = () => this.getLastSnapshotedNode() === nodeId;
    const onFail = () => {
      attemptWaitForSnapshot += 1;
      console.log("[hf] waitForNodeSnapshot fail", {
        lastSnapshotedNode: this.getLastSnapshotedNode(),
        curNode: nodeId,
        attemptWaitForSnapshot,
      });
    };

    await waitFor(successCondition, onFail);
  }
}
