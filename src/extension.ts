// Extension entry point. VS Code calls `activate` once (lazily, the first time
// the `codegraph.makeGraph` command runs) and `deactivate` on shutdown. This
// file does only two things: register the command and orchestrate the
// high-level pipeline — resolve the selected function → build the call-graph
// NodeMap (Builder) → serialize it to graph.json (Builder + View). All the real
// work lives in Builder/Reader/Parser/Scanner/View.
import * as vscode from "vscode";
import Builder from "./builder/index";
import { NodeMap } from "./types";
import View from "./view/index";

// `Location` is pulled out so we can `instanceof`-check it below (a definition
// provider returns either a `Location` or a `LocationLink`, which expose the
// range under different property names). The eslint-disable is because the
// VS Code class name is PascalCase, which the naming-convention rule rejects.
const {
  commands,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  Location,
} = vscode;

export function activate(context: vscode.ExtensionContext) {
  // Register the "Codegraph: Make a codegraph" command (contributed in
  // package.json). The callback runs every time the user invokes it with a
  // function selected in the active editor.
  let disposable = vscode.commands.registerCommand(
    "codegraph.makeGraph",
    async () => {
      // TODO(#14): debug toast — strip or gate behind a config flag.
      vscode.window.showInformationMessage("CommandRun!");

      // Read the active editor at invocation time, not module-load time —
      // otherwise the value is snapshotted at activate() and goes stale.
      const { activeTextEditor } = vscode.window;

      const currentSelection = activeTextEditor?.selection;
      const targetFunctionUri = activeTextEditor?.document.uri;

      if (!targetFunctionUri) {
        throw Error("target URI for function not found");
      }

      // Resolve the user's cursor position to the definition of the function
      // they're pointing at — that definition becomes the entry (level-0) node
      // of the graph. We go through the definition provider rather than using
      // the selection directly so it works whether the cursor sits on a call or
      // on the declaration itself.
      const currentSelectionAnchor = currentSelection?.anchor;

      const targetFunctionDefintion: (vscode.Location | vscode.LocationLink)[] =
        await commands.executeCommand(
          "vscode.executeDefinitionProvider",
          targetFunctionUri,
          currentSelectionAnchor
        );

      const primaryTargetFunctionDefinition = targetFunctionDefintion[0];

      // A `Location` carries the span as `.range`; a `LocationLink` as
      // `.targetRange`. Normalize to a single range either way.
      const targetFunctionRange =
        primaryTargetFunctionDefinition instanceof Location
          ? primaryTargetFunctionDefinition.range
          : primaryTargetFunctionDefinition.targetRange;

      if (!targetFunctionRange) {
        throw Error("target Range for function not found");
      }

      // The NodeMap is the shared graph store; View captures snapshots and
      // owns the output dir; Builder walks the call graph and fills the map.
      // All three share the same `nodeMap` instance.
      const nodeMap: NodeMap = new Map();

      const view = new View(context, nodeMap);

      const builder = new Builder(
        {
          targetFunctionRange,
          targetFunctionUri,
        },
        view,
        nodeMap
      );

      // Recursively walk calls from the entry definition outward, snapshotting
      // each node as it's discovered. `undefined` marks this as the entry call.
      // Mutates `nodeMap` and sets `builder.entryNodeId` as a side effect.
      await builder.buildNodeMap(undefined);

      const { entryNodeId } = builder;

      if (!entryNodeId) {
        throw Error("entry node not identified");
      }

      // Expand the NodeMap into the graph.json manifest (definitions +
      // per-level placements + edges) and write it next to the PNGs. The
      // snapshot metadata View collected supplies each definition's image dims.
      const manifest = builder.serializeGraph(view.getSnapshotMeta());
      await view.writeManifest(manifest);

      vscode.window.showInformationMessage(
        `CodeGraph: wrote ${manifest.definitions.length} definitions / ${manifest.placements.length} placements to graph.json`
      );
    }
  );

  // Tie the command's lifetime to the extension's so it's disposed on shutdown.
  context.subscriptions.push(disposable);
}

// No teardown needed — the webview panel and command are disposed via
// `context.subscriptions`, and no other long-lived resources are held.
export function deactivate() {}
