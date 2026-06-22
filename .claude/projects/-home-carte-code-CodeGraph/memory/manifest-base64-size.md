---
name: manifest-base64-size
description: Why inline-base64 image transport was scrapped for a local HTTP server — graph.json got huge
metadata:
  type: project
---

The inline-base64 transport (snapshots embedded in `graph.json` as `data:image/png;base64,...`) was **built and then scrapped** (2026-06-20). It produced a **1.8 MB manifest for a 2-function graph** (verified via `src/test/suite/makeGraph.test.ts`, a real extension-host run). Each snapshot is ~0.5–1.3 MB because dom-to-image captures a ~1040×918 canvas at `scale: 3`.

**Why scrapped:** base64's ~33% overhead is minor; the snapshot PNGs themselves are large and all sat in one JSON file. A real call graph (dozens of nodes) would yield a multi-tens-of-MB manifest — bad for memory and likely past practical Figma `postMessage` limits. (Figma documents *no* hard postMessage size cap and uses structured clone, which even supports `Uint8Array` — but large payloads still cost memory/time.)

**Current approach:** `CodeGraphServer` (`src/server/index.ts`) serves the output dir over `http://127.0.0.1:<port>` (default 3939, `codegraph.serverPort`); the plugin fetches `graph.json` + PNGs. `ManifestDefinition.image` is just `{ file, width, height, scale }` — no bytes inlined.

**Still worth investigating:** the snapshot canvas size / `scale: 3` looks larger than necessary (a 3-line function shouldn't need 918px height).
