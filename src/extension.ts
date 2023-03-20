import * as vscode from "vscode";
import Builder from "./builder/index";
import { NodeMap } from "./types";
import View from "./view/index";

const {
  window: { activeTextEditor },
  commands,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  Location,
} = vscode;

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "codegraph.makeGraph",
    async () => {
      vscode.window.showInformationMessage("CommandRun!");

      const currentSelection = activeTextEditor?.selection;
      const targetFunctionUri = activeTextEditor?.document.uri;

      if (!targetFunctionUri) {
        throw Error("target URI for function not found");
      }

      const currentSelectionAnchor = currentSelection?.anchor;

      const targetFunctionDefintion: (vscode.Location | vscode.LocationLink)[] =
        await commands.executeCommand(
          "vscode.executeDefinitionProvider",
          targetFunctionUri,
          currentSelectionAnchor
        );

      const primaryTargetFunctionDefinition = targetFunctionDefintion[0];

      const targetFunctionRange =
        primaryTargetFunctionDefinition instanceof Location
          ? primaryTargetFunctionDefinition.range
          : primaryTargetFunctionDefinition.targetRange;

      if (!targetFunctionRange) {
        throw Error("target Range for function not found");
      }

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

      const entryGraphNode = await builder.buildNodeMap(undefined);

      const { entryNodeId } = builder;

      if (!entryNodeId) {
        throw Error("entry node not identified");
      }

      // const nodeGraph = buildNodeGraph(nodeMap, entryNodeId);
      const nodeGraph = builder.buildNodeGraph(entryNodeId, []);
      const Jsonifified = JSON.parse(JSON.stringify(nodeGraph));

      console.log("[hf] end", { nodeMap, entryGraphNode, nodeGraph });
    }
  );

  context.subscriptions.push(disposable);
}
export function deactivate() {}
