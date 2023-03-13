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
import { looksLike } from "src/utils/tsMorph";
import type { TSMorphFunctionNode } from "types/index";

export default class ScannerTsMorph extends Scanner {
  postitionedFunctionNode: TSMorphFunctionNode | null;
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

    if (!postitionedFunctionNode) {
      return [];
    }

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

  // TODO: clean this up
  private _findPositionedFunctionNode() {
    const { unpostitionedFunctionNode, fileNode } = this;

    const unpostitionedFunctionNodeStructure =
      unpostitionedFunctionNode.getStructure &&
      unpostitionedFunctionNode.getStructure();

    if (!unpostitionedFunctionNodeStructure) {
      throw Error("cannot get unpositioned node structure");
    }

    let postitionedFunctionNode;

    fileNode.forEachDescendant((fileNodeDescendant) => {
      if (
        fileNodeDescendant.getKind() === unpostitionedFunctionNode?.getKind()
      ) {
        const fileNodeDescendantStructure = fileNodeDescendant.getStructure();
        const isMatch = looksLike(
          fileNodeDescendantStructure,
          unpostitionedFunctionNodeStructure
        );

        if (isMatch) {
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
    } else {
      return null;
    }
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
