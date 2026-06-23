# TODO — design tasks

Forward-looking refactors that are bigger than a bug fix. Reference an entry
from code with its slug, e.g. `// TODO(position-based-node-lookup): …` so the
call sites that motivate the change are easy to find. Delete an entry once it
ships.

---

## position-based-node-lookup

**Replace the snippet-reparse + structural-match pipeline with a direct
position lookup against the full-file AST.**

### Why

Today, finding the function node for a graph node takes three hops:

1. `Parser` parses the **isolated** `targetFunctionCode` into an *unpositioned*
   AST and picks the earliest function-like node.
2. Because a class member's isolated text (`run() { … }`, `static async
   build() { … }`) doesn't parse as a member outside a class, the parser has a
   fallback: detect that the picked node isn't anchored at the start of the
   snippet, then **re-parse the snippet wrapped in `class __CodeGraphWrapper__
   { … }`** and take the member instead. (See `src/parser/tsMorph.ts`.)
3. `Scanner._findPositionedFunctionNode` then **structurally re-matches** that
   unpositioned node back onto the full-file AST (`utils.looksLike`) to recover
   real source positions, because the isolated parse has none.

That's a lot of machinery to answer one question: *which function node is at
the location the user selected?* And we already know the location —
`targetFunctionRange` (from `executeDefinitionProvider`) plus the full-file AST
(`fileNode`, which the parser builds anyway).

### Proposed approach

Look the node up by position in the file AST directly:

```ts
const fileSourceFile = fileProject.createSourceFile("file.ts", targetFileCode);

const pos = fileSourceFile.compilerNode.getPositionOfLineAndCharacter(
  targetFunctionRange.start.line,
  targetFunctionRange.start.character,
);

// Deepest node at the definition location (usually the name identifier), then
// walk up to the enclosing function-like declaration (or test the node itself).
const FUNCTION_LIKE_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
];
const at = fileSourceFile.getDescendantAtPos(pos);
const fn = FUNCTION_LIKE_KINDS.map((k) => at?.getFirstAncestorByKind(k))
  .find(Boolean) /* or include `at` itself if it's already function-like */;
```

The node that comes back is **already positioned** (it's a node in the real
file AST), so there is nothing to re-match.

### What this deletes / simplifies

- **No isolated `targetFunctionCode` parse** for node identification. (The
  snippet text is still useful as the snapshot `code`, but it no longer needs
  to be parsed to find the node.)
- **No class-wrapper fallback** (`isAnchoredAtStart` + `__CodeGraphWrapper__`)
  — methods just work, since in the full file they are already real members.
- **No `Scanner._findPositionedFunctionNode` / `looksLike` structural match** —
  the whole positioned/unpositioned split collapses. The Scanner can take the
  positioned node directly and go straight to collecting call expressions.

### Caveats / risks

- **Position fidelity.** Relies on `targetFunctionRange` pointing at the
  function (true today — it's the `executeDefinitionProvider` result). Test the
  edges: an overload signature, and an arrow assigned to a `const` where the
  range may land on the variable name (the ancestor-walk should still recover
  the arrow).
- **`looksLike` may be load-bearing.** CLAUDE.md calls the structural match
  intentional ("matches against the full-file AST structurally … not by
  name/position"). Confirm nothing else depends on it before removing it.
- **Contract change.** The parser → scanner → builder interface changes (parser
  hands back an already-positioned file node; `unPositionedFunctionNode` goes
  away). Touches `src/parser/tsMorph.ts`, `src/scanner/index.ts`,
  `src/scanner/tsMorph.ts`, and the `Builder` glue in `src/builder/index.ts`.

### Acceptance criteria

- A class-method entry (and a method reached recursively) scans **all** its
  calls — the existing regression test
  (`makeGraph.test.ts` → "scans all calls in a class-method entry…") still
  passes.
- Standalone-function entries are unchanged (existing
  `makeGraph.test.ts` integration test passes).
- `_findPositionedFunctionNode` and the class-wrapper fallback are gone (or
  clearly justified if kept).
- `tsc --noEmit`, `npm run lint`, `npm run compile`, and `npm test` are clean.
