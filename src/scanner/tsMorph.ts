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
  // The callee identifier text per call, index-aligned with
  // callExpressionLocations — its length sizes the call-site rect downstream.
  callExpressionNames: string[];
  constructor(
    unpostitionedFunctionNode: TSMorphFunctionNode,
    fileNode: SourceFile,
    targetFileCode: string
  ) {
    super(unpostitionedFunctionNode, fileNode, targetFileCode);

    this.postitionedFunctionNode = this._findPositionedFunctionNode();
    const callExpressions = this._getCallExpressions();
    this.callExpressionLocations = callExpressions.map((c) => c.location);
    this.callExpressionNames = callExpressions.map((c) => c.name);
  }

  private _getCallExpressions(): { location: LineColumnFinder; name: string }[] {
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
    const callExpressions = tsMorphCallees
      .map((tsMorphCallee) =>
        tsMorphCallee
          ? {
              location: lineColumn(targetFileCode, tsMorphCallee.getStart()),
              name: tsMorphCallee.getText(),
            }
          : null
      )
      .filter(ExcludeNullish);

    if (callExpressions.length !== tsMorphCallees.length) {
      throw new Error("problem finding callee in call expression");
    }

    return callExpressions;
  }

  // Not every Node kind exposes getStructure (e.g. ArrowFunction), so guard it.
  private _getStructure(node: any) {
    return typeof node?.getStructure === "function"
      ? node.getStructure()
      : undefined;
  }

  // TODO: clean this up
  private _findPositionedFunctionNode() {
    const { unpostitionedFunctionNode, fileNode } = this;

    const unpostitionedFunctionNodeStructure = this._getStructure(
      unpostitionedFunctionNode
    );

    if (!unpostitionedFunctionNodeStructure) {
      throw Error("cannot get unpositioned node structure");
    }

    let postitionedFunctionNode;

    fileNode.forEachDescendant((fileNodeDescendant) => {
      if (
        fileNodeDescendant.getKind() === unpostitionedFunctionNode?.getKind()
      ) {
        const fileNodeDescendantStructure =
          this._getStructure(fileNodeDescendant);
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
