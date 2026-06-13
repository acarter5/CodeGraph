# Bugs & Improvements (temporary tracking doc)

Working list from a full-codebase scan. Check items off as fixed; delete this file once the list is cleared.

Legend: 🔴 confirmed bug · 🟠 likely bug / needs verification · 🧹 cleanup · ⚙️ design decision needed

---

## Confirmed bugs

- [x] 🔴 **#1 — Message handler uses `=` instead of `===`**
  `src/view/index.ts:53` — `if ((type = MESSAGES.snapshotTaken))` assigns instead of compares, so every webview message (`copied`/`download`/`tweet`/`beer`) is treated as a snapshot.
  Fix: `if (type === MESSAGES.snapshotTaken)`.

- [ ] 🔴 **#2 — `activeTextEditor` captured once at module load**
  `src/extension.ts:7-8` destructures `const { window: { activeTextEditor } } = vscode;` (a getter), then uses it at `:19-20`. Value is snapshotted at `activate()` time and goes stale when the user switches editors.
  Fix: read `vscode.window.activeTextEditor` inside the command callback.

- [ ] 🔴 **#3 — Hardcoded macOS output path** ⚙️
  `src/view/index.ts:24` — `codeGraphOutputDir = "/Users/adamcarter/lattice/test"`. `registerEntryNode` throws if it doesn't exist, breaking the feature on every other machine.
  Fix: make it a VS Code setting (there's already a `//todo`) or workspace-relative.

- [ ] 🔴 **#4 — positionFail node stored under the wrong key**
  `src/builder/index.ts:108,117-121` — dedup check uses `failNode.id` but `nodeMap.set(id, failNode)` stores under the unrelated `id = objectHash.sha1({ failKey: targetFunctionCode })`. Keys never match → no dedup + dangling key.
  Fix: use `failNode.id` consistently; delete the stale `id`.

- [ ] 🔴 **#5 — parseFail returns the wrong node on a cache hit**
  `src/builder/index.ts:81-95` — on `nodeMap.has`, pushes the parent but `return failNode` (the new one) instead of the existing accumulated node. Inconsistent with positionFail branch (`:119` returns `nodeMap.get(...)`).
  Fix: return the existing node from the map.

- [ ] 🔴 **#6 — Graph output is computed then discarded** ⚙️
  `src/extension.ts:68-71` — `nodeGraph` (the actual deliverable) is only `console.log`-ed; `Jsonifified` is unused. Nothing is persisted or sent to the front-end.
  Fix: decide the output target (write to disk / postMessage to webview / file in workspace) and emit it.

## Likely bugs / needs verification

- [ ] 🟠 **#7 — Column off-by-one into the definition provider**
  `src/scanner/tsMorph.ts:54` → `src/builder/index.ts:161-163`. `line-column` returns 1-based `line` and `col`; code does `line - 1` but passes `col` straight into a 0-based `vscode.Position`. Cursor lands one char into the identifier — likely why definition lookups are flaky and need the 5× retry at `:178`.
  Fix: try `col - 1`; verify retries drop.

- [ ] 🟠 **#8 — `object-hash` on a raw compiler node**
  `src/builder/index.ts:307` — `objectHash.sha1(node.compilerNode)`. TS compiler nodes have circular `.parent` back-pointers and are large → circular-ref risk + slow.
  Fix: hash a stable identity (uri + range + name, or text + position).

- [ ] 🟠 **#9 — `waitForNodeSnapshot` can hang forever**
  `src/view/index.ts:201-216` + `src/utils/index.ts:125-135`. `waitFor` has no timeout/max-attempts; a failed snapshot polls every 400 ms indefinitely and stalls the whole build.
  Fix: add a max-attempt/timeout bail.

- [ ] 🟠 **#10 — Snapshot write not actually awaited**
  `src/view/index.ts:90` — `await writeFile(...)` on callback-style `fs.writeFile` doesn't wait (returns `undefined`).
  Fix: use `fs/promises`.

- [ ] 🟠 **#11 — Strict `noImplicitAny` likely violated**
  `src/utils/index.ts:17,32` and `src/utils/tsMorph.ts:21` — untyped params (`looksLike(a, b)`, `isPrimitive(val)`) under `strict: true`. Confirm `npm run compile` / `compile-tests` is actually clean; if it passes, type-checking may be suppressed somewhere.

## Cleanup / cruft

- [ ] 🧹 **#12 — Delete dead files**
  `src/parser.ts` (duplicate of `parser/tsMorph.ts`), `src/parser/tsNative.ts` (empty stub), `src/parser/tsBabel.ts` + `src/scanner/tsBabel.ts` (abandoned spikes), commented-out `extract` block in `src/reader/index.ts:19-57`.

- [ ] 🧹 **#13 — Remove duplicate matchers**
  `looksLike` / `looksLikeSkipPosition` / `looksLikeSkipPositionTsMorph` in `src/utils/index.ts` vs the live `looksLike` in `src/utils/tsMorph.ts`. Keep only what's used.

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
