# CodeGraph

Guidance for working in this repo. The first half is the product spec; the second half is the engineering map (architecture, commands, conventions, gotchas).

## Intent

The application makes visual graphs of code so that users can view the entirety of a code flow without clicking through individual files and loosing context in the course of their investigations.

A user selects a function/method/section-of-code and a snapshot of that code is taken, along with snapshots of the definitions of every function call within that code, and snapshots of the definitions of every function call within those function definitions... and so on, recursively, until project dependencies (i.e. code imported from `node_modules`, etc. — this code does not get snapshotted) are reached or there are no new function calls.

Each level of the code (level 1 = code the user selected, level 2 = function definitions of calls in that code, etc.) sits in a column, and lines are drawn between columns to connect function calls and their definitions.

## Context

This repo contains **both** the backend (a VS Code extension, repo root) and the client (`client/`). The client was vendored in from https://github.com/acarter5/CodeGraphUISvelte (fresh copy, no git history; source commit `d2cbc0e`). It's a **Figma plugin** (Svelte + Rollup) and renders into FigJam, so users can annotate on top of the produced code graph.

The two halves keep **independent tooling**: the backend builds with webpack (`npm run …` at the root), the client builds with Rollup (`npm run …` inside `client/`). They are not an npm workspace; install/build each separately.

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

Snapshots are syntax-highlighted **images of code**, produced entirely inside the webview:

1. `View.loadPage` stuffs the node's `code` + `language` (inferred from the file extension by `View._inferLanguage`) into `window.__data__` via the `__DATA_PLACEHOLDER__` substitution in `resources/index.html`, then reassigns `webview.html`.
2. `resources/app.js` reads `window.__data__`, calls `Prism.highlight(code, grammar, language)` to render the highlighted DOM, then `dom-to-image-more` captures it as a PNG. **It captures twice and uses the second result** — dom-to-image's first capture of a freshly-rendered DOM is intermittently blank/incomplete (fonts/layout not flushed; hits larger/wider nodes), so the first call is a discarded warm-up.
3. The webview posts the base64 PNG back (`MESSAGES.snapshotTaken`); `View` writes it to disk and records width/height/scale into `snapshotMeta` for the manifest.
4. `View.waitForNodeSnapshot` polls (`utils.waitFor`) until the webview confirms the current node was captured before the loop moves on — this serializes the recursion (see the long comment in `builder/index.ts` for why it isn't parallelized).

**There used to be a clipboard-based pipeline** (`Reader.prepForPageLoad` ran `editor.action.clipboardCopyWithSyntaxHighlightingAction`, the webview pasted, dom-to-image captured). It was ripped out — see `BUGS.md` #20 for why. If you're tempted to bring it back, read that entry first.

## Code map

- `src/extension.ts` — activation + command registration
- `src/builder/` — graph construction (`buildNodeMap`, `buildNodeGraph`, fail-node creation)
- `src/reader/` — `Reader` base + `ReaderVSCode` (document I/O; the clipboard-highlight prep is gone — see BUGS.md #20)
- `src/parser/` — `CodeGraphParser` base + `tsMorph` impl (`tsBabel`/`tsNative` are abandoned spikes)
- `src/scanner/` — `Scanner` base + `tsMorph` impl (positions the node, finds call locations)
- `src/view/` — `View`: webview lifecycle + snapshot capture + PNG file writing
- `src/server/` — `CodeGraphServer`: loopback static server that hosts `graph.json` + PNGs for the FigJam plugin to fetch
- `src/types/` — shared types (`MapNode`, `FailNode`, `NodeMap`, `GraphNode`, `FailReason`)
- `src/utils/` — `ExcludeNullish`, `looksLike` AST matchers, `waitFor`, fail-node type guards
- `src/constants/` — webview placeholders + message enum
- `resources/` — `index.html` / `app.js` / `app.css` for the snapshot webview
- `client/` — the FigJam plugin (Svelte + Rollup). Self-contained: `src/code.ts` (plugin sandbox / Figma API), `src/PluginUI.svelte` + `src/main.js` (plugin UI iframe), `public/manifest.json` (Figma plugin manifest). Build with `npm run build` (or `npm run dev`) **from inside `client/`**.

## Client ↔ backend integration

The backend's deliverable is the `graph.json` manifest (`GraphManifest` in `src/types/index.ts`) plus the PNG snapshots. The client is a **sandboxed Figma plugin** with no filesystem access, and the Figma **REST API cannot create nodes inside a FigJam file** — so rendering into FigJam must happen from the plugin, and the manifest + images have to cross the sandbox boundary somehow.

> ⚠️ This supersedes the BUGS.md #6 note that the manifest would be "consumed via the Figma REST API (Node process → relative file paths, no base64)." That approach doesn't work: REST can't write FigJam content, and the plugin can't read local paths.

**Chosen transport: local HTTP server.** The extension serves the graph output directory over `http://127.0.0.1:<port>` (`CodeGraphServer`, `src/server/index.ts`, built on Node's `http` — no new deps). `makeGraph` starts it after writing `graph.json`, then copies the manifest URL (`http://localhost:<port>/<encoded graphDir>/graph.json`) to the clipboard and toasts it; the plugin `fetch`es that URL, then fetches each image by the relative `SnapshotMeta.file` name. The server is one long-lived instance reused across runs and disposed on `deactivate`. Port is `codegraph.serverPort` (default **3939**); it binds loopback only. `graph.json` carries **no image bytes** — `ManifestDefinition.image` is just `{ file, width, height, scale }`.

> We previously built an **inline-base64** transport (PNGs embedded as `data:` URIs in `graph.json`) and scrapped it: a real 2-function run produced a **1.8 MB** manifest, so a real graph would be tens of MB in one JSON blob — bad for memory and likely to exceed practical Figma `postMessage` limits. (Note: Figma documents **no** hard `postMessage` size cap, but structured-clone payloads still cost memory/time; large is still bad.) See [[manifest-base64-size]].

**Alternative to try later: disk-based picker (no server).** Instead of `fetch`ing from localhost, the plugin UI could read the `.codegraph` graph folder straight off disk via a folder `<input type="file" webkitdirectory>` (or drag-and-drop), `FileReader` → `Uint8Array`, matching PNGs to the manifest by `file` name. This removes the server, the `networkAccess` manifest entry, and all CORS/mixed-content fuss — at the cost of the user picking the folder each run instead of pasting a URL. **Not chosen because it's unverified in Figma:** the docs only bless drag-and-drop of `File` objects (`pluginDrop`), nothing on `<input type="file">`/`webkitdirectory`, and GitHub code search finds no Figma plugin shipping `webkitdirectory` — so the directory dialog may not surface inside Figma's sandboxed iframe. Before adopting it, verify empirically with a throwaway plugin (a `webkitdirectory` input that logs the file count) loaded via Figma → Plugins → Development → Import. If it works, it's the lower-friction transport.

**Client side** — `npm install` + `npm run build` work inside `client/` (Node 22; produces `public/index.html` with the UI bundle inlined + `public/code.js`). The plugin is wired to CodeGraph (no longer the "Create Shapes" sample):
- `client/public/manifest.json` — `editorType: ["figjam", "figma"]`, `networkAccess.allowedDomains` lists `http://localhost:3939` (Figma blocks the `fetch` otherwise; it **rejects IP addresses** like `127.0.0.1` here — `localhost` with a port only). **Changing `codegraph.serverPort` means editing this.**
- `client/src/PluginUI.svelte` (UI iframe) — URL input (paste the clipboard URL the extension copies). On "Render graph" it `fetch`es `graph.json`, then each PNG (resolved by `image.file` next to the manifest), and posts `{ manifest, images: [{definitionId, bytes: Uint8Array}] }` to the sandbox. The iframe does this because the sandbox has no `fetch`. It **re-encodes every PNG through a canvas** (`fitImageBytes`) before handing bytes to the sandbox — this is load-bearing, not just for downscaling:
  - Figma `createImage` **accepts the original dom-to-image PNGs (returns a hash) but renders them blank**; round-tripping through `<img>` → canvas → `toBlob` yields a normalized PNG it renders reliably. So we always re-encode, even images already under the limit. (Confirmed empirically: a re-encoded 4096px image renders; an un-re-encoded 3363px original renders blank.)
  - Decode uses an `<img>` element, **not `createImageBitmap`** — the latter silently returns a blank bitmap for very large images in the Figma iframe.
  - Images over **4096px** (Figma's hard `createImage` limit; long functions at `scale: 3` exceed it) are downscaled to fit during the same re-encode. Box size still comes from the manifest's logical dims, so only resolution drops.
  - If re-encoding fails entirely, the image is sent as `bytes: null` and the sandbox draws a red **"⚠ Image too large to render"** box — loud, never a silent blank.
  - **Proper fix for big functions is tiling** (or a lower capture scale); this is the stopgap.
- `client/src/code.ts` (sandbox) — `figma.createImage(bytes)` per definition; lays out boxes via **dagre layered-DAG layout** (`rankdir: "LR"` so rank = graph level = column, with crossing-minimization so children sit near their callers). Only forward edges feed the layout (recursion back-edges would add cycles); dagre node coords are centers. Boxes in a column are then **left-aligned** to the column's leftmost edge (dagre centers same-rank nodes, so varying widths leave ragged left edges otherwise). The column gap (dagre `ranksep`) is **computed per-graph** = `2·CORRIDOR_MARGIN + LANE_GAP·(maxLanes−1)` (floored at `MIN_RANK_SEP`) so the busiest corridor's connector lanes fit. Image-filled rectangles for snapshotted defs. **Use classic `dagre` 0.8.x, NOT `@dagrejs/dagre` v3** — v3 ships ES2018 object spread (`{...a}`) which Figma's plugin parser rejects with "Unexpected token ..." (nothing transpiles deps down; `typescript()` only compiles our `.ts`, terser doesn't transpile). See [[figma-plugin-es5-syntax]]. No-image defs (e.g. `findDefinitionFail`) render as a tinted, **labelled** box (name + reason, color-coded by `kind`) instead of a blank grey box. Connectors (`figma.createConnector()`, FigJam only). FigJam connectors can't be routed manually (no waypoint API — confirmed in the ConnectorNode docs), so a **forward, call-site-anchored edge is drawn as a chain of THREE straight connectors** (a Z: horizontal out of the snapshot at the call token → vertical at a chosen x → horizontal into the def box). This buys three things: (1) **distinct color per edge** (cycled `CONNECTOR_COLORS`); (2) the line **starts inside the caller's snapshot at the call token** (`position` endpoint from `callSiteRect`); (3) the **vertical run's x is staggered** per edge — edges crossing the same column gap (`corridorGroups`, grouped by source level, sorted top→bottom by call site) each get a distinct lane spread across the gap (between `columnRightX[level]` and `columnLeftX[level+1]`), with the **first/topmost edge furthest right and the last furthest left**, so vertical runs don't overlap. The arrowhead is only on the last link, which is `ELBOWED` (not `STRAIGHT`) so it can use a `LEFT` magnet attaching to the def box — its endpoints share a y so it still draws straight. (**Straight connectors only allow CENTER/NONE magnets** — "may only use the CENTER or NONE magnets" — so the node-attached link must be elbowed.) The first two links are `STRAIGHT` with position endpoints. Recursion / no-`callSiteRect` edges fall back to a single auto-routed (`ELBOWED`) connector; recursion is dashed.
>
> **Grouping the 3 links does NOT work** — `figma.group()` on connectors in FigJam silently *dissolves* the group (lines stay independent), and a node-attached connector in the group makes `set_selection` throw on the dead id. Tried and reverted. The final `currentPage.selection` filters `!n.removed` as a safety net. If per-connector grouping/rigid-move is ever needed, the only untried avenue is invisible anchor nodes at the bends with CENTER magnets — unverified. See [[figma-figjam-node-quirks]]. Recursion / no-`callSiteRect` edges fall back to a single auto-routed (`ELBOWED`) connector; recursion is dashed. (Caveats: the chain's interior endpoints are absolute `position`s, so they don't follow boxes that are manually dragged; the first two links are both-`position` connectors — if FigJam ever refuses to render a node-less connector, switch them to tiny invisible anchor nodes.)
- `client/src/manifest.ts` — client mirror of the backend manifest types; **keep in sync** with the extension's `src/types/index.ts`.

**Call-site-anchored connectors (the data flow).** Connectors point from the *call* to the *definition*, anchored at the exact call token, via `ManifestEdge.callSiteRect` (normalized [0..1] within the caller's image). Pipeline:
1. `Scanner` already finds each call's callee identifier location; it now also exposes `callExpressionNames` (for the token length).
2. `Builder` records `MapNode.outgoingCalls[]` (type `OutgoingCall`: row/col relative to the snapshot code, length, `definitionNodeId`, `rect`) **before** `loadPage` — one entry per call expression, the single source of truth for what a node calls. `definitionNodeId` is filled after definitions resolve (index-aligned with `callExpressionLocations`); `null` for `node_modules` calls (no connector).
3. The webview (`resources/app.js`) measures each call token's `getBoundingClientRect()` against the captured `#content` box (`measureCallSites` → `offsetFor`/`rangeForOffset` walk the Prism DOM by character offset), normalizes it, and returns `callSiteRects[]` with the snapshot.
4. `View` writes those rects back onto the node's `outgoingCalls`. `Builder.serializeGraph` emits **one edge per outgoing call** (multiple calls to the same def → multiple connectors) carrying `callSiteRect`.
5. The client anchors the connector start at that rect (see `code.ts` above). Falls back to box-edge magnets when a rect is missing.

> **Verified in Figma (2026-06-20):** loads + renders in both a Figma design file and **FigJam** — `createRectangle` + `IMAGE` fills work in FigJam (that earlier open risk is resolved), and connectors draw in FigJam (they're skipped in design files, which is correct — `createConnector` is FigJam-only). Call-site anchoring verified end-to-end by `src/test/suite/makeGraph.test.ts` (asserts the manifest edge carries a normalized `callSiteRect`). Builds + `tsc --noEmit -p tsconfig.json --skipLibCheck` clean.
>
> **Layout:** dagre (classic `dagre` 0.8.x — ES5; **not** `@dagrejs/dagre` v3, see above) does layered-DAG placement with crossing-minimization (replaced the naive centered-columns layout). The `code.ts` Rollup bundle needed `@rollup/plugin-node-resolve` added (it had none) to bundle dagre into the sandbox; client tsconfig needed `moduleResolution: node`. Anything bundled into the sandbox must be ES5/ES2017-safe (no object spread) — there's no transpile step for deps.
>
> **Known rough edges / next:** large snapshots are downscaled, not tiled (see above); a call-site connector's start is an absolute `position`, so it won't follow a box that's manually moved.

> ⚠️ The earlier BUGS.md #6 note ("consumed via the Figma REST API → relative file paths") is wrong: the Figma REST API can't create FigJam content, and the plugin can't read local paths. Ignore it.

## Conventions

- **Module pattern:** an abstract base class in `<module>/index.ts` with a concrete impl per backing tool (e.g. `parser/index.ts` ← `parser/tsMorph.ts`). New language/tool support follows the same shape.
- **AST library:** **ts-morph** is the live path. The `tsBabel` and `tsNative` variants are exploratory and not wired into the pipeline — don't extend them without reason.
- **Path aliases** (`tsconfig.json`): `types/*` → `src/types/*`, `src/*` → `src/*`. Use these instead of long relative paths.
- **Node matching:** `Scanner._findPositionedFunctionNode` matches the isolated parse against the full-file AST structurally via `utils.looksLike` (not by name/position) — this is how unpositioned nodes get real source ranges.
- Strict TypeScript is on; lint before tests (`pretest` runs `lint`).

## Gotchas / rough edges

- **Webview scripts MUST be `defer`-ed.** Every external `<script>` in `resources/index.html` (`prism.js`, the Prism language components, `dom-to-image-more`, `app.js`) has `defer` so it runs after the `<body>` is parsed. Without it, `app.js` executes from the `<head>` and `document.querySelector("#copy")` returns `null`, killing the IIFE before the first `render()` call. The inline `window.__data__ = JSON.parse(...)` script is *not* deferred — it only sets a global, which is safe during parsing.
- **The `placeholders.forEach` loop in `View.loadPage` must use a function replacement.** It substitutes the JSON-encoded source code into the HTML. `String.replace(searchString, replacementString)` treats `$&`, `` $` ``, `$'`, `$<n>`, and `$$` as special patterns in the replacement, so any source code containing those (or whose JSON-encoded form happens to contain them) gets silently corrupted. The fix `html.replace(key, () => value.toString())` disables that interpretation; don't revert it.
- **`.vscodeignore` excludes `node_modules/**` but the webview loads from there.** `resources/index.html` references `../node_modules/prismjs/prism.js`, the Prism component files, the Prism theme CSS, and `../node_modules/dom-to-image-more/dist/dom-to-image-more.min.js`. Webpack doesn't bundle these (they're string references inside HTML, not `import`s). Works in F5/dev, will 404 inside a `.vsix`. Either vendor those files into `resources/` or add `copy-webpack-plugin` to mirror them into `dist/` at build time. Decide before the first `vsce package` run.
- **Diagnostic logs are still in the code.** `[hf]` (host side) and `[hf:webview]` (webview side, routed back via the `webviewLog` message branch in `View`'s `onDidReceiveMessage`) instrument the snapshot pipeline end-to-end. Useful for the next regression; gate them behind a config flag or strip before shipping — see BUGS.md #14.
- **Definition resolution is flaky.** `executeDefinitionProvider` misses some definitions (e.g. methods passed as arguments) even after the 5 retries in `builder/index.ts`; those intentionally become `FindDefinitionFail` nodes rather than hard failures.
- **Tests are a stub.** `src/test/suite/extension.test.ts` is the sample placeholder. Despite the acceptance criterion, there is no real coverage yet.
- **Typos in identifiers** (`postitioned`, `defintion`, `Postion`, `Jsonifified`) appear across the code and types — match the existing spelling when referencing them rather than "fixing" in passing, since they're load-bearing names.
