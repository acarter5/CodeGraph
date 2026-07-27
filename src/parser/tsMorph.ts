import type * as vscode from "vscode";
import { Project, SyntaxKind, Node, SourceFile } from "ts-morph";
import {
  baseIdentifierName,
  buildImportModuleMap,
  isExternalCallee,
} from "../utils/tsMorph";
import CodeGraphParser from "./index";
import type { TSMorphFunctionNode } from "types/index";

// Function-like kinds we can treat as a graph node. Class members
// (method/constructor/accessor) are included because the entry/definition can
// be a method — in the full-file AST they're already real members, so unlike
// the old isolated-snippet parse there's no wrapper needed to recover them.
const FUNCTION_LIKE_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
];

export default class CodeGraphParserTsMorph extends CodeGraphParser {
  constructor(
    targetFunctionCode: string,
    targetFileCode: string,
    targetFunctionRange: vscode.Range
  ) {
    super(targetFunctionCode, targetFileCode, targetFunctionRange);
  }

  async parse() {
    const { targetFileCode, targetFunctionRange } = this;

    const fileProject = new Project();
    const fileSourceFile = fileProject.createSourceFile("file.ts", targetFileCode);

    // Look the function node up directly by position in the full-file AST. The
    // node that comes back is already positioned (it's a node in the real file
    // AST), so there is nothing to structurally re-match — this replaces the
    // isolated-snippet reparse + `__CodeGraphWrapper__` fallback + Scanner's
    // `looksLike` match, all of which were fragile on large/complex functions
    // (a miss became a positionFail that killed the whole subtree).
    const positionedFunctionNode = this._findFunctionNodeAtPosition(
      fileSourceFile,
      targetFunctionRange
    );

    // No function-like node at the definition location → the definition is a
    // value, not a function (e.g. `const db = knex(config)` — a knex instance,
    // or an object map for dynamic dispatch). Flag the sub-case where that value
    // is initialized from a node_modules callee, so the Builder can skip it like
    // any other node_modules call instead of surfacing a failure node.
    const externalValueDefinition = positionedFunctionNode
      ? false
      : this._isExternalValueDefinition(fileSourceFile, targetFunctionRange);

    return {
      positionedFunctionNode,
      fileNode: fileSourceFile,
      externalValueDefinition,
    };
  }

  // The function-like node at the definition location, or undefined when the
  // definition isn't a function.
  private _findFunctionNodeAtPosition(
    fileSourceFile: SourceFile,
    range: vscode.Range
  ): TSMorphFunctionNode | undefined {
    const startPos = this._offsetOf(fileSourceFile, range.start);
    if (startPos === undefined) {
      return undefined;
    }
    const endPos = this._offsetOf(fileSourceFile, range.end);

    // Primary: the widest function-like declaration whose span lies within the
    // definition range. `executeDefinitionProvider` hands us the full
    // declaration span, so the declaration itself (and only functions nested in
    // it) fall inside it; the widest is the definition. Robust to the range
    // starting on a modifier (`export`/`async`), keyword (`const`/`function`),
    // or decorator — no reliance on which token the position lands on.
    if (endPos !== undefined) {
      const within = this._functionLikeDescendants(fileSourceFile)
        .filter((node) => node.getStart() >= startPos && node.getEnd() <= endPos)
        .sort((a, b) => b.getWidth() - a.getWidth());
      if (within[0]) {
        return within[0] as TSMorphFunctionNode;
      }
    }

    // Fallback: walk up from the node at the definition start to the nearest
    // function-like declaration (covers a name-only definition range, when a
    // provider returns just the identifier). An arrow/function assigned to a
    // `const` is found via the variable declaration's initializer, since it's a
    // sibling of the name rather than an ancestor.
    for (
      let node: Node | undefined = fileSourceFile.getDescendantAtPos(startPos);
      node;
      node = node.getParent()
    ) {
      const fn = this._asFunctionLike(node);
      if (fn) {
        return fn;
      }
      if (Node.isVariableDeclaration(node)) {
        return this._asFunctionLike(node.getInitializer());
      }
    }

    return undefined;
  }

  // Absolute offset of a vscode position in the file, or undefined if the
  // position falls outside the file text.
  private _offsetOf(
    fileSourceFile: SourceFile,
    position: vscode.Position
  ): number | undefined {
    try {
      return fileSourceFile.compilerNode.getPositionOfLineAndCharacter(
        position.line,
        position.character
      );
    } catch {
      return undefined;
    }
  }

  private _functionLikeDescendants(fileSourceFile: SourceFile): Node[] {
    return FUNCTION_LIKE_KINDS.flatMap((kind) =>
      fileSourceFile.getDescendantsOfKind(kind)
    );
  }

  private _asFunctionLike(
    node: Node | undefined
  ): TSMorphFunctionNode | undefined {
    return node && FUNCTION_LIKE_KINDS.includes(node.getKind())
      ? (node as TSMorphFunctionNode)
      : undefined;
  }

  // True when the definition is a value whose initializer is `<callee>(…)` /
  // `new <callee>` and that callee traces to a bare (node_modules) import or a
  // JS builtin — i.e. the "function" is really a value backed by a library
  // (e.g. `const db = knex(config)`, a knex instance).
  private _isExternalValueDefinition(
    fileSourceFile: SourceFile,
    range: vscode.Range
  ): boolean {
    const importModules = buildImportModuleMap(fileSourceFile);
    const startPos = this._offsetOf(fileSourceFile, range.start);
    if (startPos === undefined) {
      return false;
    }
    const endPos = this._offsetOf(fileSourceFile, range.end);

    // The provider may hand us the whole `const db = knex(config)` declaration…
    if (endPos !== undefined) {
      const inRange = fileSourceFile
        .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
        .find((node) => node.getStart() >= startPos && node.getEnd() <= endPos);
      if (this._isExternalInitializer(inRange?.getInitializer(), importModules)) {
        return true;
      }
    }

    // …or just the variable name (e.g. the range of `db`). Resolve the
    // declaration in the full file by name and inspect its initializer.
    const at = fileSourceFile.getDescendantAtPos(startPos);
    const identifier =
      at && Node.isIdentifier(at)
        ? at
        : at?.getFirstDescendantByKind(SyntaxKind.Identifier);
    if (identifier) {
      const declaration = fileSourceFile.getVariableDeclaration(
        identifier.getText()
      );
      if (
        this._isExternalInitializer(
          declaration?.getInitializer(),
          importModules
        )
      ) {
        return true;
      }
    }

    return false;
  }

  private _isExternalInitializer(
    initializer: Node | undefined,
    importModules: Map<string, string>
  ): boolean {
    if (
      !initializer ||
      (!Node.isCallExpression(initializer) &&
        !Node.isNewExpression(initializer))
    ) {
      return false;
    }
    return isExternalCallee(
      baseIdentifierName(initializer.getExpression()),
      importModules
    );
  }
}
