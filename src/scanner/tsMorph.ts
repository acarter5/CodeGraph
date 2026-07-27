import { SyntaxKind } from "ts-morph";
import {
  buildImportModuleMap,
  baseIdentifierName,
  isExternalCallee,
} from "src/utils/tsMorph";
import { isExternalModuleSpecifier } from "src/utils/moduleResolution";

import Scanner from "./index";

import lineColumn = require("line-column");
import { ExcludeNullish } from "../utils";
// @ts-expect-error
import type { LineColumnFinder } from "line-column";
import type { SourceFile } from "ts-morph";
import type { TSMorphFunctionNode } from "types/index";

export default class ScannerTsMorph extends Scanner {
  callExpressionLocations: LineColumnFinder[];
  // The callee identifier text per call, index-aligned with
  // callExpressionLocations — its length sizes the call-site rect downstream.
  callExpressionNames: string[];
  // Whether each call is "provably external" — its receiver is imported from a
  // bare (node_modules) module specifier, or is a JS builtin. Index-aligned
  // with the arrays above. The Builder skips these: no definition lookup, no
  // FindDefinitionFail node, no connector (see builder/index.ts).
  callExpressionExternal: boolean[];
  constructor(
    positionedFunctionNode: TSMorphFunctionNode,
    fileNode: SourceFile,
    targetFileCode: string,
    containingFilePath?: string
  ) {
    super(positionedFunctionNode, fileNode, targetFileCode, containingFilePath);

    const callExpressions = this._getCallExpressions();
    this.callExpressionLocations = callExpressions.map((c) => c.location);
    this.callExpressionNames = callExpressions.map((c) => c.name);
    this.callExpressionExternal = callExpressions.map((c) => c.isExternal);
  }

  private _getCallExpressions(): {
    location: LineColumnFinder;
    name: string;
    isExternal: boolean;
  }[] {
    const {
      positionedFunctionNode,
      targetFileCode,
      fileNode,
      containingFilePath,
    } = this;

    // localName -> module specifier (e.g. "proxyChain" -> "proxy-chain").
    const importModules = buildImportModuleMap(fileNode);

    // Resolve specifiers for real when we know the file's path, so first-party
    // `paths`/`baseUrl` aliases and workspace packages aren't mistaken for
    // node_modules and silently dropped. Without a path we can only fall back
    // to the specifier-shape heuristic (isExternalCallee's default).
    const isExternalSpecifier = containingFilePath
      ? (specifier: string) =>
          isExternalModuleSpecifier(specifier, containingFilePath)
      : undefined;

    const callExpressionNodes = positionedFunctionNode.getDescendantsOfKind(
      SyntaxKind.CallExpression
    );

    const callExpressions = callExpressionNodes
      .map((callExpressionNode) => {
        const callee = callExpressionNode.getFirstChild();
        // The callee identifier used for location/name/definition lookup: for a
        // property access (`a.b()`) it's the method name `b`, else the callee.
        const tsMorphCallee =
          callee?.getKind() === SyntaxKind.PropertyAccessExpression
            ? callee.getLastChildByKind(SyntaxKind.Identifier)
            : callee;

        if (!tsMorphCallee) {
          return null;
        }

        // The receiver's leftmost identifier (`a` in `a.b.c()`) classifies the
        // call as external. null when the receiver isn't a bare identifier
        // (e.g. `new Proxy().find()` — a method on an instance).
        const isExternal = isExternalCallee(
          baseIdentifierName(callee),
          importModules,
          isExternalSpecifier
        );

        return {
          location: lineColumn(targetFileCode, tsMorphCallee.getStart()),
          name: tsMorphCallee.getText(),
          isExternal,
        };
      })
      .filter(ExcludeNullish);

    if (callExpressions.length !== callExpressionNodes.length) {
      throw new Error("problem finding callee in call expression");
    }

    return callExpressions;
  }
}
