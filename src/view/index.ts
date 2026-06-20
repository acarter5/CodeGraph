import { resolve, join, basename, isAbsolute } from "path";
import * as vscode from "vscode";
import type {
  FailNode,
  GraphManifest,
  MapNode,
  NodeMap,
  PageData,
  SnapshotMeta,
  WebviewMessage,
} from "types/index";
import { readFile, PathLike, writeFile, mkdirSync } from "fs";

import { placeholders, MESSAGES } from "src/constants/index";
import { isFindDefinitionFailNode, waitFor } from "src/utils/index";

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
  // Resolved from the `codegraph.outputDirectory` setting in registerEntryNode.
  codeGraphOutputDir: string | undefined;
  graphDir: string | undefined;
  // Image metadata per snapshotted node id, consumed when writing graph.json.
  snapshotMeta: Map<string, SnapshotMeta> = new Map();
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

    this.panel.webview.onDidReceiveMessage(async (message: any) => {
      // Webview-side logs and errors get routed back to the host so they show
      // up in the extension host console alongside the host's own [hf] logs.
      // Without this, a script error in app.js is invisible from here — it
      // only shows in the webview's own DevTools panel.
      if (message && message.type === "webviewLog") {
        // Stringify so the contents survive into the extension host log
        // even when the console viewer collapses nested objects to `{…}`.
        try {
          console.log("[hf:webview]", JSON.stringify(message.data));
        } catch {
          console.log("[hf:webview]", message.data);
        }
        return;
      }
      if (message.type === MESSAGES.snapshotTaken) {
        console.log("[hf] in receive message", {
          dataFromMessage: message.data,
          curNodeData: this.curNodeData,
        });

        if (!this.codeGraphOutputDir || !this.graphDir) {
          throw Error("output directory not found");
        }

        const { snapshotedNode, img, width, height, scale } = message.data;

        // const wsRootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        // const codeGraphDir = "CodeGraph";

        const escapedTargetFunctionUri = this.curNodeData?.uri.path
          .split("/")
          .slice(-3)
          .join("-")
          .replace(".", "%");

        const imageFileName = `${this.curNodeData?.functionName} ${escapedTargetFunctionUri} ${this.curNodeData?.id}`;

        console.log("[hf]", { imageFileName });
        // const codeGraphOutputDir = wsRootDir && path.join(wsRootDir, codeGraphDir);

        // const imageFileName = `${functionName} - ${this.targetFunctionUri.path} - ${nodeId}`;

        // console.log("[hf]", { wsRootDir, codeGraphDir, codeGraphOutputDir, imageFileName });

        const newImgPath = join(
          this.codeGraphOutputDir,
          this.graphDir,
          imageFileName
        );

        writeFile(newImgPath + ".png", img, "base64", (err) => {
          if (err) {
            console.error("snapshot save failed", { err });
          }
        });

        // Record image metadata so the graph manifest can size the snapshot
        // and (later) anchor connectors. Keyed by node id (== snapshotedNode).
        this.snapshotMeta.set(snapshotedNode, {
          file: imageFileName + ".png",
          width,
          height,
          scale,
        });

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
    let code: string;

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
      code = curNode.code;
    }

    this.curNodeData = {
      functionName,
      uri,
      id: nodeId,
    };

    // The webview renders `code` directly using Prism — no clipboard, no
    // paste handler, no vscode copy command. `language` tells Prism which
    // grammar to apply; we just look at the file extension.
    const panelData = {
      start: range.start.line + 1,
      end: range.end.line + 1,
      nodeId,
      code,
      language: View._inferLanguage(uri),
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

    // Log the resolved URIs once per page load so we can verify the webview
    // is being handed real, reachable paths to Prism, dom-to-image, and the
    // app script. If app.js never logs into the host, this is the next thing
    // to check.
    console.log(
      "[hf] loadPage resolved URIs",
      Object.fromEntries(
        replacements.map(({ key, value }) => [key, value.toString()])
      )
    );

    replacements.forEach(({ key, value }) => {
      // Use a function replacement so $-substitution patterns inside `value`
      // (rare in URIs, but common in the JSON-encoded source code we stuff
      // into __DATA_PLACEHOLDER__ — e.g. template literals ${userAgent}) are
      // NOT interpreted by String.replace. Passing a plain string here would
      // let `$&`/`$'`/etc. corrupt the rendered HTML.
      html = html.replace(key, () => value.toString());
    });

    html = html.replace(/__CSP_SOURCE__/g, this.panel.webview.cspSource);
    this.panel.webview.html = html;
  }

  public getLastSnapshotedNode() {
    return this.lastSnapshotedNode;
  }

  // Maps a file URI's extension to a Prism language id. Falls back to
  // javascript so non-js code still tokenizes against a sane default rather
  // than rendering as flat text.
  private static _inferLanguage(uri: vscode.Uri): string {
    const path = uri.path.toLowerCase();
    if (path.endsWith(".tsx")) return "tsx";
    if (path.endsWith(".jsx")) return "jsx";
    if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
      return "typescript";
    }
    return "javascript";
  }

  public getSnapshotMeta(): Map<string, SnapshotMeta> {
    return this.snapshotMeta;
  }

  // Writes the graph manifest (graph.json) into the graph's output folder,
  // alongside the snapshot PNGs it references by relative filename.
  public writeManifest(manifest: GraphManifest): Promise<void> {
    if (!this.codeGraphOutputDir || !this.graphDir) {
      throw Error("view: writeManifest: output directory not registered");
    }

    const manifestPath = join(
      this.codeGraphOutputDir,
      this.graphDir,
      "graph.json"
    );

    return new Promise((resolve, reject) =>
      writeFile(manifestPath, JSON.stringify(manifest, null, 2), (err) =>
        err ? reject(err) : resolve()
      )
    );
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
  public async waitForNodeSnapshot() {
    let attemptWaitForSnapshot = 0;
    const successCondition = () =>
      !!this.curNodeData?.id &&
      this.getLastSnapshotedNode() === this.curNodeData?.id;
    const onFail = () => {
      attemptWaitForSnapshot += 1;
      console.log("[hf] waitForNodeSnapshot fail", {
        lastSnapshotedNode: this.getLastSnapshotedNode(),
        curNode: this.curNodeData?.id,
        attemptWaitForSnapshot,
      });
    };

    // A snapshot that never arrives (webview error, crash, etc.) used to poll
    // forever and stall the entire serial recursion. `waitFor` now bails after
    // ~30s; swallow that timeout so the build continues — the node just won't
    // have an image (the manifest records `image: null` for it).
    try {
      await waitFor(successCondition, onFail);
    } catch (err) {
      console.error(
        "view: waitForNodeSnapshot: snapshot timed out, continuing without it",
        { curNode: this.curNodeData?.id, err }
      );
    }
  }

  public registerEntryNode(entryNode: MapNode | FailNode) {
    this.entryNode = entryNode;
    if (isFindDefinitionFailNode(entryNode)) {
      throw Error(
        "cannot create a graph from the selected function because its defintion was not found"
      );
    }

    this.codeGraphOutputDir = this._resolveOutputDir();
    mkdirSync(this.codeGraphOutputDir, { recursive: true });

    const escapedUri = entryNode.uri.path
      .split("/")
      .slice(-3)
      .join("-")
      .replace(".", "%");

    this.graphDir = `${entryNode.name} ${escapedUri} ${entryNode.id}`;

    const fullDirPath = join(this.codeGraphOutputDir, this.graphDir);
    mkdirSync(fullDirPath, { recursive: true });
  }

  /*
    Resolves the directory snapshots are written to:
      - `codegraph.outputDirectory` setting, if set (absolute used as-is,
        relative resolved against the workspace root)
      - otherwise `.codegraph` in the workspace root
      - throws if no setting and no open workspace folder
  */
  private _resolveOutputDir(): string {
    const configured = vscode.workspace
      .getConfiguration("codegraph")
      .get<string>("outputDirectory")
      ?.trim();

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (configured) {
      if (isAbsolute(configured)) {
        return configured;
      }
      return workspaceRoot
        ? join(workspaceRoot, configured)
        : resolve(configured);
    }

    if (workspaceRoot) {
      return join(workspaceRoot, ".codegraph");
    }

    throw Error(
      "CodeGraph: no output directory available. Open a workspace folder or set the `codegraph.outputDirectory` setting to an absolute path."
    );
  }
}
