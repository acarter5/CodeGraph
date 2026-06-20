# Bugs & Improvements (temporary tracking doc)

Working list from a full-codebase scan. Check items off as fixed; delete this file once the list is cleared.

Legend: 🔴 confirmed bug · 🟠 likely bug / needs verification · 🧹 cleanup · ⚙️ design decision needed

---

## 🚨 Build broken

- [x] 🔴 **#0 — Project does not compile (36 errors)** ✅ FIXED
  Both `tsc -p .` and `npm run compile` (webpack/ts-loader) failed on `master`. Now all three pass: `tsc --noEmit` exit 0, webpack exit 0 (2 harmless ts-morph "Critical dependency" warnings), `eslint` exit 0 (2 pre-existing warnings remain: `Jsonifified` naming → part of #6; `val == null` idiom in `utils/tsMorph.ts`).
  Done via: installed `@types/object-hash`; deleted dead files (#12); typed `waitFor`/`looksLike`/`isPrimitive` + removed dead matchers & `verifyCallDefinitionLocations` (#11 + part of #13); `_getStructure` guard helper in `scanner/tsMorph.ts`; `GraphNode.children` typed recursively; `view/index.ts:169` `value.toString()`.

## Confirmed bugs

- [x] 🔴 **#1 — Message handler uses `=` instead of `===`**
  `src/view/index.ts:53` — `if ((type = MESSAGES.snapshotTaken))` assigns instead of compares, so every webview message (`copied`/`download`/`tweet`/`beer`) is treated as a snapshot.
  Fix: `if (type === MESSAGES.snapshotTaken)`.

- [x] 🔴 **#2 — `activeTextEditor` captured once at module load** ✅ FIXED
  Removed `activeTextEditor` from the top-level `vscode` destructure; the command callback now reads `const { activeTextEditor } = vscode.window;` at invocation time, so it always reflects the editor the user has focused when they run the command.

- [x] 🔴 **#3 — Hardcoded macOS output path** ✅ FIXED
  Added a `codegraph.outputDirectory` setting (contributed in `package.json`). `View._resolveOutputDir()` resolves it: absolute → as-is, relative → against workspace root, empty → `.codegraph` in the workspace root (throws only when there's no setting and no open workspace). `registerEntryNode` now creates the dir with `mkdirSync(..., { recursive: true })` instead of throwing when it's missing.

- [x] 🔴 **#4 — positionFail node stored under the wrong key** ✅ FIXED
  Deleted the stale `id = objectHash.sha1({ failKey: targetFunctionCode })`; the node is now stored with `nodeMap.set(failNode.id, failNode)`. This also fixed a latent crash: `view.loadPage(failNode.id)` did `nodeMap.get(failNode.id)`, which previously missed (node was under the wrong key) and threw — so the positionFail path now actually snapshots instead of erroring.

- [x] 🔴 **#5 — parseFail returns the wrong node on a cache hit** ✅ FIXED
  The cache-hit branch now early-returns the existing node (`const existingNode = nodeMap.get(failNode.id) as FailNode; … return existingNode;`), matching the positionFail branch. Restructured to an early return rather than fall-through so the new `failNode` can no longer leak out on a hit.

- [x] 🔴 **#6 — Graph output is computed then discarded** ✅ FIXED
  Now emits a `graph.json` manifest into the graph's output folder (alongside the PNGs), consumed by the FigJam renderer via the Figma REST API (Node process → relative file paths, no base64).
  **Shape:** two-layer — `definitions[]` (unique functions, the dedup/color-key layer, each with `image{file,width,height,scale}` + `source{uri,range}` + `kind`) and `placements[]` (one box per `(definition, level)`; same definition → several placements sharing `definitionId` so the front-end can color-code duplicates), plus `edges[]` (placement→placement, with `recursion:true` back-edges for cycles). Per the M0 rule: a definition may appear at several levels but once per level.
  Implemented across: `resources/app.js` (capture PNG `width/height/scale`), `WebviewMessage` + new manifest types in `src/types/index.ts`, `View` records `snapshotMeta` + `writeManifest()`, `Builder.serializeGraph()` (level-expansion + cycle break), and `extension.ts` writes it (also deleted the dead `Jsonifified` line → closed that lint warning).
  **Deferred (until FE work begins):** `edges[].callSite` (precise call-line anchor) is in the type but not yet populated. The `ManifestPosition` + definition `ManifestRange` get you the *logical* location inside a snapshot (`rowInSnapshot = callSite.line - definition.range.start.line`), but **not** the pixel location in the PNG — that needs render geometry the manifest doesn't carry (line height, char width, padding, title-bar + gutter offsets) and breaks on tabs. Decision: don't reconstruct pixels from font metrics; have the webview measure each call-site token's `getBoundingClientRect()` at capture time (× `scale`) and emit a `callSiteRect`. Deferred deliberately until the front-end exists so we design the anchor interface against the renderer's real needs. Also blocked on the off-by-one (#7), which must be fixed before either the logical or measured offset can be trusted. Renderer falls back to node-edge anchoring until then.

## Likely bugs / needs verification

- [x] 🟠 **#7 — Column off-by-one into the definition provider** ✅ FIXED
  `line-column` (in `scanner/tsMorph.ts`) returns 1-based `line` AND `col`; `vscode.Position` is 0-based for both. The builder converted `line - 1` but passed `col` straight, landing the cursor one char into the callee identifier. Fixed both call sites in `builder/index.ts` (initial resolution + the retry loop) to `col - 1`.
  **Side effects:** should make definition resolution more reliable (fewer fallbacks into the 5× retry / fewer spurious `FindDefinitionFail` nodes), and it makes the call-column trustworthy — a prerequisite for populating `edges[].callSite` in #6 (still deferred until FE per that entry). Worth eyeballing a real run to confirm retries actually drop.

- [x] 🟠 **#8 — `object-hash` on a raw compiler node** ✅ FIXED
  `_buildNodeMapNodeFromTsMorphNode` now hashes a stable source identity — `objectHash.sha1({ uri, range (flattened to plain numbers), name })` — instead of `node.compilerNode`. The uri + definition range is exactly what makes two references to the same function dedup to one NodeMap entry, so dedup semantics are preserved while dropping the circular-`.parent`/large-subtree hashing risk and cost. (The `node` param is still used for `getTsMorphNodeFunctionName`.)

- [x] 🟠 **#9 — `waitForNodeSnapshot` can hang forever** ✅ FIXED
  `waitFor` (`src/utils/index.ts`) now takes `{ intervalMs, maxAttempts }` (default 400ms × 75 ≈ 30s) and **rejects** once the attempts are exhausted instead of polling forever; pass `maxAttempts: Infinity` to opt out. `View.waitForNodeSnapshot` wraps the call in try/catch: on timeout it logs a warning and resolves so the serial recursion continues — the affected node just gets no image (`image: null` in the manifest) rather than stalling the entire build.

- [x] 🟠 **#10 — Snapshot write not actually awaited** ✅ FIXED
  Removed the no-op `await` while fixing the `Buffer`/TS-version issue at `src/view/index.ts:89`. Now `writeFile(path, img, "base64", cb)` — base64 string written directly, no `Buffer`, no misleading `await`.

- [x] 🟠 **#11 — Strict `noImplicitAny` violated** ✅ FIXED (with #0)
  Confirmed it was failing the build. Typed `waitFor` (`utils/index.ts`) and `looksLike`/`isPrimitive` (`utils/tsMorph.ts`); deleted the unused untyped matchers in `utils/index.ts`.

## Cleanup / cruft

- [x] 🧹 **#12 — Delete dead files** ✅ DONE (with #0)
  Deleted `src/parser.ts`, `src/parser/tsNative.ts`, `src/parser/tsBabel.ts`, `src/scanner/tsBabel.ts`. Still TODO: commented-out `extract` block in `src/reader/index.ts:19-57`.

- [x] 🧹 **#13 — Remove duplicate matchers** ✅ DONE (with #0)
  Removed the unused `looksLike` / `looksLikeSkipPosition` / `looksLikeSkipPositionTsMorph` (and `verifyCallDefinitionLocations`) from `src/utils/index.ts`. The live `looksLike` in `src/utils/tsMorph.ts` is now the only one.

- [ ] 🧹 **#14 — Strip debug noise**
  `[hf]` `console.log`s and `debugger` statements throughout (`utils/index.ts:119`, `view/index.ts`, `builder/index.ts`, …) and the `"CommandRun!"` toast at `extension.ts:17`.

- [ ] 🧹 **#15 — Remove junk dependencies**
  `package.json:38` `"-": "^0.0.1"` (accidental install) and `"save": "^2.9.0"` (unused). If the babel/native parsers are dropped, also drop the `@babel/*` deps.

- [ ] 🧹 **#16 — `incomingCalls` accumulates duplicate parents**
  `src/builder/index.ts:145` etc. push without dedup. Use a Set if uniqueness matters.

## Tests & infra

- [ ] ⚙️ **#17 — No real tests**
  `src/test/suite/extension.test.ts` is the sample placeholder, despite "well tested" being an acceptance criterion.

- [ ] 🟠 **#18 — Path aliases won't survive `tsc` for tests**
  `tsconfig` maps `src/*` / `types/*`, but `tsc` doesn't rewrite them at emit and `runTest.ts` doesn't register `tsconfig-paths`. Fine now (webpack handles the bundle), but the first test that imports `builder`/`utils` will fail at runtime.
  Fix: add `tsconfig-paths/register` or use relative imports in tested code.

- [ ] 🧹 **#19 — README is the unedited extension template.**

## Confirmed bugs (continued)

- [x] 🔴 **#20 — Every snapshot rendered the entry's source** ✅ FIXED
  When run on `cluster.js` in the SneakerBot repo, the 4 PNGs in the graph folder were all identical — every one showed `PuppeteerCluster.build`, regardless of which callee the file was named for.
  **Root cause:** The whole snapshot pipeline relied on the system clipboard. `prepForPageLoad` ran `editor.action.clipboardCopyWithSyntaxHighlightingAction` to put syntax-highlighted HTML on the clipboard, then the webview's `app.js` ran `execCommand("paste")` to render it. That command targets the focused editor — and once the webview was visible, the OS-level focus lived in the webview's iframe (vscode's `activeTextEditor` said otherwise, but the clipboard never updated). Net effect: every non-entry copy command no-op'd, the clipboard kept holding the entry's HTML, and every PNG rendered the entry.
  Multiple incremental fixes (handshake messages, atomic `showTextDocument({selection})`, focus-poll + retry, plain-text fallback) each closed one symptom but none made the highlighted copy reliable across all nodes.
  **Final fix:** Dropped the clipboard pipeline entirely. Added `prismjs` as a dependency. The webview now reads `code` + `language` directly out of `window.__data__` (the host writes them when it sets `panelData` in `view.loadPage`) and uses `Prism.highlight(code, grammar, language)` to render. `prepForPageLoad`, the `webviewReady`/`takeSnapshot` handshake, and the paste handler are gone. The webview also no longer needs OS focus to render, so reentry on a stale focus state is impossible by construction.
  **Trade-off:** snapshots use Prism's `prism-tomorrow` theme instead of the user's vscode theme. Consistent across machines (a feature, not a bug), but no longer follows the editor's colors.
  **Packaging note:** the webview references `node_modules/prismjs/...` for the Prism core, components, and theme. `.vscodeignore` excludes `node_modules/**`, so these files won't ship in a `.vsix`. Vendoring (or `CopyWebpackPlugin`-ing them into `dist/` or `resources/prism/`) is needed before packaging. → tracked as **#21**.

- [x] 🔴 **#21 — Webview assets load from `node_modules`; won't ship in a `.vsix`** ✅ FIXED
  Added `copy-webpack-plugin` (v11) to `webpack.config.js`, mirroring the 6 files the webview actually loads (Prism core + typescript/jsx/tsx components + the `prism-tomorrow` theme + dom-to-image) into `dist/vendor/` at build. Repointed the placeholders in `src/constants/index.ts` from `../node_modules/...` to `../dist/vendor/...` (they resolve against `resources/`, and `dist/` ships while `node_modules/` is `.vscodeignore`d). Copied only the referenced files rather than the whole `prismjs` package (~600 grammars) — adding a language for M3 means one copy pattern + one placeholder. Verified with `vsce ls`: **6 `dist/vendor` files packaged, 0 from `node_modules`.** Still worth a real install-from-`.vsix` smoke test of the snapshot render before the first publish.
  `resources/index.html` references the Prism core/components/theme under `node_modules/prismjs/...` and `node_modules/dom-to-image-more/dist/dom-to-image-more.min.js`. These are plain string URLs in the HTML (not `import`s), so webpack never bundles them, and `.vscodeignore` excludes `node_modules/**` from the package. Result: the snapshot webview works under F5 (the dev host can reach `node_modules`) but every asset 404s the moment the extension is installed from a `.vsix` — i.e. the entire snapshot pipeline silently breaks for real users.
  Surfaced by #20 (the Prism rewrite introduced the `prismjs` dependency) and overlaps the same `.vscodeignore` gotcha in `CLAUDE.md`. Confirmed by inspection; not yet observed because nothing has been `vsce package`d yet.
  **Fix (decide one):**
    1. **Vendor** the needed files into `resources/` (e.g. `resources/prism/`, `resources/vendor/`), update the `index.html` references + `localResourceRoots`, and let them ship as part of `resources/**`. Simple, explicit, no build step.
    2. **`copy-webpack-plugin`** to mirror the specific files into `dist/` (or `resources/`) at build time and reference them there. Keeps `node_modules` as the source of truth, versions stay in sync on `npm i`.
  Recommend **option 2** (build stays the source of truth; no stale vendored copies to maintain), but option 1 is fine if we want to avoid adding a webpack plugin. Either way, verify with an actual `vsce package` + install-from-vsix before closing.
