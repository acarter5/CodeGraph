---
name: figma-figjam-node-quirks
description: FigJam connector/group quirks found building the CodeGraph plugin renderer
metadata:
  type: project
---

FigJam plugin-API quirks hit while drawing the call→definition connectors (`client/src/code.ts`), verified 2026-06-21:

- **`figma.group()` on connectors silently dissolves** — the group returns but FigJam removes it (lines stay independent), so you can't make multi-segment connectors move/select as one via grouping. If the grouped connectors include one attached to a node, a later `set_selection` on the dead group id throws "node does not exist". Reverted grouping entirely. Guard `currentPage.selection` with `.filter(n => !n.removed)` regardless.
- **Straight connectors only allow CENTER/NONE magnets** — setting a `LEFT`/`RIGHT` magnet on a `connectorLineType: "STRAIGHT"` connector throws "Straight connector endpoints may only use the CENTER or NONE magnets". Use `ELBOWED` for any link that attaches to a node edge (it still draws straight if both ends share an axis).
- **Position-only (node-less) connectors DO render** in FigJam — confirmed working; used for the staggered Z-chain links.
- **`createRectangle` + `IMAGE` fills work in FigJam** (earlier open risk, resolved). `createConnector` works. `createVector` was never needed (the connector-chain approach replaced it) so its FigJam support remains unverified.

**Pattern:** these are all "the API accepts it but FigJam does something unexpected at runtime" — can't be caught by tsc/build, only by loading in the FigJam desktop app. Related: [[figma-createimage-blank-pngs]], [[figma-plugin-es5-syntax]].
