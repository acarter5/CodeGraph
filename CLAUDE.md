# CodeGraph

Guidance for working in this repo. The first half is the product spec; the second half is the engineering map (architecture, commands, conventions, gotchas).

## Intent

The application makes visual graphs of code so that users can view the entirety of a code flow without clicking through individual files and loosing context in the course of their investigations.

A user selects a function/method/section-of-code and a snapshot of that code is taken, along with snapshots of the definitions of every function call within that code, and snapshots of the definitions of every function call within those function definitions... and so on, recursively, until project dependencies (i.e. code imported from `node_modules`, etc. — this code does not get snapshotted) are reached or there are no new function calls.

Each level of the code (level 1 = code the user selected, level 2 = function definitions of calls in that code, etc.) sits in a column, and lines are drawn between columns to connect function calls and their definitions.

## Context

This repo contains the **backend**, implemented as a VS Code extension. The front-end is started in a separate repo: https://github.com/acarter5/CodeGraphUISvelte. Ideally the front-end renders in FigJam, so users can annotate on top of the produced code graph.

## Implementation

- backend is a VS Code extension
- frontend uses Svelte and, if possible, the Figma API to render into FigJam files

## Acceptance Criteria

- application is well tested
- snapshots taken at pixel densities adequate for human-readable text
- clear connections are drawn between function/method calls and their definitions

## Scope

### M0
- only TypeScript is supported
- only connections between function/method calls and their definitions are drawn
- ok to have multiple instances of the same function definition at different levels of the graph BUT there should only be 1 instance of a function definition per graph-level

### M1
- There should only be 1 instance of each function definition in the graph; function calls at later levels point backward to the function definition

### M2
- connections between inheritance are drawn in object-oriented code instances

### M3
- Python is supported

---

## Commands

| Task | Command |
| --- | --- |
| Compile (webpack → `dist/extension.js`) | `npm run compile` |
| Watch-compile | `npm run watch` |
| Production bundle | `npm run package` |
| Lint | `npm run lint` |
| Compile tests (tsc → `out/`) | `npm run compile-tests` |
| Run tests (full `pretest` + electron) | `npm test` |

Run/debug the extension interactively with **F5** (launches an Extension Development Host). The command it registers is **"Codegraph: Make a codegraph"** (`codegraph.makeGraph`) — run it from the Command Palette with a function selected in the active editor.

## Architecture

One command, `codegraph.makeGraph` (`src/extension.ts`), drives a recursive pipeline. For the user's selection it resolves the definition via VS Code's `executeDefinitionProvider`, then `Builder.buildNodeMap` walks the call graph depth-first:

```
extension.ts            registers command, resolves the entry definition
  └─ Builder            buildNodeMap() recursion + buildNodeGraph() tree
       ├─ Reader        opens the document, extracts function code + full file text
       ├─ Parser        parses isolated function code → ts-morph AST (unpositioned)
       ├─ Scanner       re-finds that node inside the full-file AST (positioned),
       │                collects CallExpression locations
       └─ View          loads each node into a webview, captures a PNG snapshot
```

Per node, the loop is: **read → parse → scan → resolve each call's definition → recurse.** For every CallExpression, VS Code's `executeDefinitionProvider` finds the definition; `node_modules` results are skipped, unresolved ones become `FindDefinitionFail` nodes (retried up to 5×, see `builder/index.ts`).

Output is a **`NodeMap`** (`Map<id, MapNode | FailNode>`, id = `object-hash` sha1 of the AST node) where nodes reference each other by id via `incomingCalls`/`outgoingCalls`. `buildNodeGraph` then expands the map into a `GraphNode` tree, breaking cycles with a `recursionId` marker.

### The snapshot mechanism (non-obvious)

Snapshots are syntax-highlighted **images of code**, produced through a roundtrip, not by rendering text directly:

1. `Reader.prepForPageLoad` selects the function range in a real editor and runs `editor.action.clipboardCopyWithSyntaxHighlightingAction` — putting highlighted HTML on the clipboard.
2. `View.loadPage` loads `resources/index.html` into a webview; `resources/app.js` triggers a paste, builds the DOM, and uses `dom-to-image-more` to render a PNG.
3. The webview posts the base64 PNG back (`MESSAGES.snapshotTaken`); `View` writes it to disk.
4. `View.waitForNodeSnapshot` polls (`utils.waitFor`) until the webview confirms the current node was captured before the loop moves on — this serializes the recursion (see the long comment in `builder/index.ts` for why it isn't parallelized).

## Code map

- `src/extension.ts` — activation + command registration
- `src/builder/` — graph construction (`buildNodeMap`, `buildNodeGraph`, fail-node creation)
- `src/reader/` — `Reader` base + `ReaderVSCode` (document I/O + clipboard-highlight prep)
- `src/parser/` — `CodeGraphParser` base + `tsMorph` impl (`tsBabel`/`tsNative` are abandoned spikes)
- `src/scanner/` — `Scanner` base + `tsMorph` impl (positions the node, finds call locations)
- `src/view/` — `View`: webview lifecycle + snapshot capture + PNG file writing
- `src/types/` — shared types (`MapNode`, `FailNode`, `NodeMap`, `GraphNode`, `FailReason`)
- `src/utils/` — `ExcludeNullish`, `looksLike` AST matchers, `waitFor`, fail-node type guards
- `src/constants/` — webview placeholders + message enum
- `resources/` — `index.html` / `app.js` / `app.css` for the snapshot webview

## Conventions

- **Module pattern:** an abstract base class in `<module>/index.ts` with a concrete impl per backing tool (e.g. `parser/index.ts` ← `parser/tsMorph.ts`). New language/tool support follows the same shape.
- **AST library:** **ts-morph** is the live path. The `tsBabel` and `tsNative` variants are exploratory and not wired into the pipeline — don't extend them without reason.
- **Path aliases** (`tsconfig.json`): `types/*` → `src/types/*`, `src/*` → `src/*`. Use these instead of long relative paths.
- **Node matching:** `Scanner._findPositionedFunctionNode` matches the isolated parse against the full-file AST structurally via `utils.looksLike` (not by name/position) — this is how unpositioned nodes get real source ranges.
- Strict TypeScript is on; lint before tests (`pretest` runs `lint`).

## Gotchas / rough edges

- **Hardcoded output dir:** `View.codeGraphOutputDir = "/Users/adamcarter/lattice/test"` (`src/view/index.ts`). This is the original author's machine path and the marked `//todo` is to make it a setting. The extension throws if the dir doesn't exist — make this configurable (or point it at the workspace) before relying on snapshot output.
- **Bug in the message handler:** `view/index.ts` uses `if ((type = MESSAGES.snapshotTaken))` — an assignment, not a comparison (`===`). Every webview message currently falls into the snapshot branch.
- **Debug noise:** many `console.log("[hf] ...")` and stray `debugger` statements remain throughout. Treat `[hf]` logs as scratch instrumentation, not intentional logging.
- **Definition resolution is flaky:** `executeDefinitionProvider` misses some definitions (e.g. methods passed as arguments) even after the 5 retries; those intentionally become `FindDefinitionFail` nodes rather than hard failures.
- **Tests are a stub:** `src/test/suite/extension.test.ts` is the sample placeholder. Despite the acceptance criterion, there is no real coverage yet.
- **Typos in identifiers** (`postitioned`, `defintion`, `Postion`, `Jsonifified`) appear across the code and types — match the existing spelling when referencing them rather than "fixing" in passing, since they're load-bearing names.
