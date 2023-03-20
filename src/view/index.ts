import { resolve, join, basename } from "path";
import * as vscode from "vscode";
import type { FailNode, MapNode, NodeMap, PageData } from "types/index";
import { readFile, PathLike, writeFile } from "fs";

import { placeholders, MESSAGES } from "src/constants/index";
import {
  isFindDefinitionFailNode,
  isParseFailNode,
  isPositionFailNode,
  waitFor,
} from "src/utils/index";

export default class View {
  panel: vscode.WebviewPanel;
  context: vscode.ExtensionContext;
  lastSnapshotedNode: string | null;
  nodeMap: NodeMap;
  /* It feels a little janky to store the entry node here but this is the only class that persists throughout the buildNode process */
  entryNode: undefined | MapNode | FailNode;
  curNodeData:
    | {
        functionName: string;
        uri: vscode.Uri;
        id: string;
      }
    | undefined;
  constructor(context: vscode.ExtensionContext, nodeMap: NodeMap) {
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

    this.nodeMap = nodeMap;

    this.lastSnapshotedNode = null;

    this.panel.webview.onDidReceiveMessage(async ({ type, data, message }) => {
      // console.log("[hf] in panel callBack", {
      //   prevSnapshotedNode: this.lastSnapshotedNode,
      //   newSnapshotedNode: data.snapshotedNode,
      //   this: this,
      //   type,
      //   data,
      // });
      if ((type = MESSAGES.snapshotTaken)) {
        console.log("[hf] in receive message", {
          dataFromMessage: data,
          curNodeData: this.curNodeData,
        });
        const { snapshotedNode, img } = data;

        //todo: make this configureable in settings
        const testDir = "/Users/adamcarter/lattice/test";
        // const wsRootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        // const codeGraphDir = "CodeGraph";

        // const outputDir = wsRootDir && path.join(wsRootDir, codeGraphDir);

        // const imageFileName = `${functionName} - ${this.targetFunctionUri.path} - ${nodeId}`;

        // console.log("[hf]", { wsRootDir, codeGraphDir, outputDir, imageFileName });

        const newImgPath = join(testDir, snapshotedNode);

        console.log("[hf]", { newImgPath });
        await writeFile(
          newImgPath + ".png",
          Buffer.from(img, "base64"),
          (err) => {
            if (!err) {
              console.log("[hf] save succeeded");
            } else {
              console.error("[hf] save failed", { err });
            }
          }
        );

        this.lastSnapshotedNode = snapshotedNode;
      }
    });
  }

  public async loadPage(nodeId: string) {
    if (!this.entryNode) {
      throw Error("view: load page: entry node not registered");
    }

    const curNode = this.nodeMap.get(nodeId);

    let range: vscode.Range;
    let functionName: string;
    let uri: vscode.Uri;

    if (!curNode) {
      throw Error("view: load page: nodeId not found in node map");
    } else if (isFindDefinitionFailNode(curNode)) {
      throw Error(
        "view: load page: cannot load findDefinitionFail node into page"
      );
    } else {
      range = curNode.range;
      functionName = curNode.name || "Anonymous";
      uri = curNode.uri;
    }

    this.curNodeData = {
      functionName,
      uri,
      id: nodeId,
    };

    const panelData = {
      start: range.start.line + 1,
      end: range.end.line + 1,
      nodeId,
    };

    // const entryNodeUri =
    //   "uri" in this.entryNode ? this.entryNode.uri : undefined;

    // const dirName = `${this.entryNode.name} - ${
    //   entryNodeUri ? basename(entryNodeUri.path) : ""
    // } - ${this.entryNode.id}`;

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

  public registerEntryNode(entryNode: MapNode | FailNode) {
    this.entryNode = entryNode;
  }
}
