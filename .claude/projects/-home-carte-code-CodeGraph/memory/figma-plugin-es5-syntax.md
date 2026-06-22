---
name: figma-plugin-es5-syntax
description: Figma plugin sandbox parser rejects ES2018 object spread — bundled deps must be ES5/ES2017-safe
metadata:
  type: project
---

Figma's plugin **main-thread (`code.js`) parser rejects ES2018+ syntax** — notably object spread `{...a}` — failing with "Syntax error on line N: Unexpected token ...". The whole `code.js` fails to load, so the plugin silently doesn't run (you see stale results from the prior run + the error in Figma's console).

**Why it bites:** the client (`client/`) Rollup build has **no transpile step for dependencies** — `rollup-plugin-typescript` only compiles our own `.ts` (down to the tsconfig `target`), and `terser` minifies but does NOT transpile. So any npm dep bundled into the sandbox passes through at its original syntax level.

**Concrete instance (2026-06-20):** `@dagrejs/dagre` v3 ships ES2018 object spread → broke the plugin. Fixed by switching to classic **`dagre` 0.8.x + `@types/dagre`** (ES5, same `dagre.graphlib.Graph` / `dagre.layout` API). Imported as `import * as dagre from "dagre"`.

**How to apply:** before adding any runtime dep to `client/src/code.ts`, confirm its published JS is ES5/ES2017-safe (`grep '\.\.\.' public/code.js` after a build should find no spread). If you need a modern-only dep, add a Babel/transpile pass over the whole bundle (incl. node_modules) — there isn't one today. The UI iframe (`PluginUI.svelte`) runs in a normal browser context and is NOT subject to this; only the sandbox bundle is.
