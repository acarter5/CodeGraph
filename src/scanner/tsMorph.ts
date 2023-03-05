import {
  SourceFile,
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunction,
  SyntaxKind,
} from "ts-morph";

import Scanner from "./index";

import lineColumn = require("line-column");
import { ExcludeNullish } from "../utils";
// @ts-expect-error
import type { LineColumnFinder } from "line-column";
import type { TSMorphFunctionNode } from "types/index";

export default class ScannerTsMorph extends Scanner {
  postitionedFunctionNode: TSMorphFunctionNode;
  callExpressionLocations: LineColumnFinder[];
  constructor(
    unpostitionedFunctionNode: TSMorphFunctionNode,
    fileNode: SourceFile,
    targetFileCode: string
  ) {
    super(unpostitionedFunctionNode, fileNode, targetFileCode);

    this.postitionedFunctionNode = this._findPositionedFunctionNode();
    this.callExpressionLocations = this._getCallExpressionLocations();
  }

  private _getCallExpressionLocations() {
    const { postitionedFunctionNode, targetFileCode } = this;

    const callExpressionNodes = postitionedFunctionNode.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );

    const tsMorphCallees = callExpressionNodes.map((callExpressionNode) =>
      callExpressionNode.getFirstChild()?.getKind() ===
      SyntaxKind.PropertyAccessExpression
        ? callExpressionNode
            .getFirstChild()
            ?.getLastChildByKind(SyntaxKind.Identifier)
        : callExpressionNode.getFirstChild()
    );
    const tsMorphCalleeLocations = tsMorphCallees
      .map(
        (tsMorphCallee) =>
          tsMorphCallee && lineColumn(targetFileCode, tsMorphCallee.getStart())
      )
      .filter(ExcludeNullish);

    if (tsMorphCalleeLocations.length !== tsMorphCallees.length) {
      throw new Error("problem finding callee in call expression");
    }

    return tsMorphCalleeLocations;
  }

  private _findPositionedFunctionNode() {
    const { unpostitionedFunctionNode, fileNode } = this;

    const unPositionedFunctionNodeText = unpostitionedFunctionNode?.getText();

    // todo: clean this up
    if (!unPositionedFunctionNodeText) {
      debugger;
      console.error("Function declaration node text not found");
      throw Error("Function declaration node text not found");
    }

    let postitionedFunctionNode;

    fileNode.forEachDescendant((fileNodeDescendant) => {
      if (
        fileNodeDescendant.getKind() === unpostitionedFunctionNode?.getKind()
      ) {
        const fileNodeDescendantText = fileNodeDescendant.getText();
        // console.log("[hf] node text:", {
        //   fileNodeDescendantText,
        //   unPositionedFunctionNodeText,
        // });
        if (
          fileNodeDescendantText.localeCompare(unPositionedFunctionNodeText) ===
          0
        ) {
          postitionedFunctionNode = fileNodeDescendant;
          return;
        }
      }
    });

    const typedPositionedFunctionNode = this._getTypedPostionedFunctionNode(
      postitionedFunctionNode
    );

    return typedPositionedFunctionNode;
  }

  private _getTypedPostionedFunctionNode(node: any) {
    if (node instanceof FunctionDeclaration) {
      return node as FunctionDeclaration;
    } else if (node instanceof FunctionExpression) {
      return node as FunctionExpression;
    } else if (node instanceof ArrowFunction) {
      return node as ArrowFunction;
    }

    throw Error(`invalid type for positioned function. type = ${typeof node}`);
  }
}

// let postitionedFunctionTargetNode
// try {
//   console.log('[hf]', unPositionedFunctionNode.getKind())
//   postitionedFunctionTargetNode = fileNode.getDescendantsOfKind(unPositionedFunctionNode?.getKind()).filter((node) => node.getName() === unPositionedFunctionNode?.getName())[0]
// } catch(error) {
//   debugger
//   console.error('error finding positioned target node', {error})
// }
