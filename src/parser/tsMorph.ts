import { Project, SyntaxKind, Node, SourceFile } from "ts-morph";
import { ExcludeNullish } from "../utils/index";
import {
  baseIdentifierName,
  buildImportModuleMap,
  isExternalCallee,
} from "../utils/tsMorph";
import CodeGraphParser from "./index";
import type { TSMorphFunctionNode } from "types/index";

// Function-like kinds we can treat as a graph node. Class members
// (method/constructor/accessor) are included because the entry/definition can
// be a method — but their isolated code (`foo() { … }`) doesn't parse as a
// member on its own (see `parse`), so they're recovered via a class wrapper.
const FUNCTION_LIKE_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
];

const MEMBER_KINDS = [
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
];

export default class CodeGraphParserTsMorph extends CodeGraphParser {
  constructor(targetFunctionCode: string, targetFileCode: string) {
    super(targetFunctionCode, targetFileCode);
  }

  // Earliest (by source position) function-like descendant of the given kinds.
  private _earliestOfKinds(
    sourceFile: SourceFile,
    kinds: SyntaxKind[]
  ): Node | undefined {
    return kinds
      .map((kind) => sourceFile.getFirstDescendantByKind(kind))
      .filter(ExcludeNullish)
      .sort((nodeA, nodeB) => nodeA.getStart() - nodeB.getStart())[0];
  }

  async parse() {
    const { targetFunctionCode, targetFileCode } = this;

    const funcProject = new Project();
    funcProject.createSourceFile("func.ts", targetFunctionCode);
    const funcSourceFile = funcProject.getSourceFiles()[0];

    let functionDefinition = this._earliestOfKinds(
      funcSourceFile,
      FUNCTION_LIKE_KINDS
    );

    // A class member's isolated code (e.g. `run() { … }` or
    // `static async build() { … }`) doesn't parse as a member outside a class —
    // it reads as a call expression followed by a block, so the search above
    // finds the first ArrowFunction *nested in the body* instead of the member
    // itself (only that callback's calls would then be scanned). Detect this:
    // if the candidate isn't anchored at the start of the snippet, re-parse the
    // code wrapped in a class and prefer the member it exposes.
    //
    // TODO(position-based-node-lookup): this wrapper fallback (and the whole
    // isolated-snippet parse) goes away if we look the node up by position in
    // the full-file AST instead — see TODO.md.
    const isAnchoredAtStart =
      functionDefinition &&
      targetFunctionCode.slice(0, functionDefinition.getStart()).trim() === "";

    if (!isAnchoredAtStart) {
      const wrappedProject = new Project();
      wrappedProject.createSourceFile(
        "wrapped.ts",
        `class __CodeGraphWrapper__ {\n${targetFunctionCode}\n}`
      );
      const wrappedSourceFile = wrappedProject.getSourceFiles()[0];
      const member = this._earliestOfKinds(wrappedSourceFile, MEMBER_KINDS);
      if (member) {
        functionDefinition = member;
      }
    }

    const fileProject = new Project();
    fileProject.createSourceFile("file.ts", targetFileCode);
    const fileSourceFile = fileProject.getSourceFiles()[0];

    // When there's no function-like node, the definition is a value, not a
    // function (e.g. `const db = knex(configuration)` — a knex instance, or an
    // object map for dynamic dispatch). Flag the sub-case where that value is
    // initialized from a node_modules callee, so the Builder can skip it like
    // any other node_modules call instead of surfacing a failure node.
    const externalValueDefinition = functionDefinition
      ? false
      : this._isExternalValueDefinition(funcSourceFile, fileSourceFile);

    return {
      unPositionedFunctionNode: functionDefinition as
        | TSMorphFunctionNode
        | undefined,
      fileNode: fileSourceFile,
      externalValueDefinition,
    };
  }

  // True when the definition is a value whose initializer is `<callee>(…)` /
  // `new <callee>` and that callee traces to a bare (node_modules) import or a
  // JS builtin — i.e. the "function" is really a value backed by a library
  // (e.g. `const db = knex(config)`, a knex instance).
  private _isExternalValueDefinition(
    snippet: SourceFile,
    fileSourceFile: SourceFile
  ): boolean {
    const importModules = buildImportModuleMap(fileSourceFile);

    // The provider may hand us the whole `const x = knex(config)` declaration…
    const inlineDeclaration = snippet.getFirstDescendantByKind(
      SyntaxKind.VariableDeclaration
    );
    if (
      this._isExternalInitializer(
        inlineDeclaration?.getInitializer(),
        importModules
      )
    ) {
      return true;
    }

    // …or just the variable name (e.g. the range of `db`). In that case resolve
    // the declaration in the full file and inspect its initializer.
    const identifier = snippet.getFirstDescendantByKind(SyntaxKind.Identifier);
    if (identifier) {
      const fileDeclaration = fileSourceFile.getVariableDeclaration(
        identifier.getText()
      );
      if (
        this._isExternalInitializer(
          fileDeclaration?.getInitializer(),
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
