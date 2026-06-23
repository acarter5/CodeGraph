import { Project, SyntaxKind, Node, SourceFile } from "ts-morph";
import { ExcludeNullish } from "../utils/index";
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

    return {
      unPositionedFunctionNode: functionDefinition as
        | TSMorphFunctionNode
        | undefined,
      fileNode: fileSourceFile,
    };
  }
}
