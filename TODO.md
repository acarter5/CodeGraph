# TODO — design tasks

Forward-looking refactors that are bigger than a bug fix. Reference an entry
from code with its slug, e.g. `// TODO(some-slug): …` so the call sites that
motivate the change are easy to find. Delete an entry once it ships.

---

## node-relative-connectors

**Goal:** make each call→definition connector chain follow its boxes when they
move, so the widget's expand/collapse (and user drags) stop leaving lines
behind, and a toggle only has to redraw the edges of the node that changed size.

**Where things are today** (`client/src/shared/connectors.ts`, `drawEdges`):
a forward, call-site-anchored edge is a 3-link Z chain:

1. link 1: horizontal, from the call token to the lane (`STRAIGHT`)
2. link 2: the vertical lane (`STRAIGHT`)
3. link 3: horizontal into the def box (`ELBOWED`, arrow)

Links 1 and 2 and the start of link 3 are **absolute canvas points**
(`{ position }`). Only link 3's end follows a node (`{ endpointNodeId, magnet:
"LEFT" }` on the def box). So when a box moves, its lines stay put. The widget
works around this by deleting and redrawing every connector touching the
toggled column plus both adjacent corridors (`toggleNode` in
`client/src/widget/code.tsx`, ids tracked per edge in root plugin data under
`graph:<id>:edge:<i>`).

**The idea:** the Figma API has a third endpoint form, `{ endpointNodeId,
position }`, where `position` is *relative to the attached node*
([ConnectorEndpoint docs](https://developers.figma.com/docs/plugins/api/ConnectorEndpoint)).
Pin every link end to a box:

| Link | Start | End |
| --- | --- | --- |
| 1 | caller + offset of call token | caller + offset of bend 1 (lane x, token y) |
| 2 | caller + offset of bend 1 | def + offset of bend 2 (lane x, def center y) |
| 3 | def + offset of bend 2 | def, `LEFT` magnet (unchanged) |

Offsets = absolute point − box top-left. The absolute points are already
computed in `drawEdges`, so this is a small change there.

**Why it works for the widget:** a column toggle only moves nodes *vertically*.
- When a caller moves, link 1 and bend 1 move with it, and the lane stays
  vertical because its x is unchanged.
- When a def moves, bend 2 and link 3 move with it.

So column neighbours need **no** redraw. A toggled node still redraws its own
edges, because its size changes:
- **outgoing:** the call token appears or disappears, so link 1's start offset
  changes;
- **incoming:** bend 2 was pinned at the def's old vertical center, so link 3
  would come in at an angle.

That shrinks `toggleNode`'s redraw set from "column + both corridors" to "edges
incident to the toggled node". Sideways drags still tilt the lane, but it stays
connected. The plugin (`client/src/code.ts`) gets the same benefit for user
drags, since it shares `drawEdges`.

**Open question (verify before building):** bends 1 and 2 lie *outside* the box
they're pinned to (bend 1 is right of the caller, bend 2 is left of the def).
The docs don't say whether out-of-bounds relative positions are kept, clamped
onto the box edge, or rejected. If they're clamped, the bends collapse onto the
box edges and the chain breaks.

Also check that a `STRAIGHT` connector accepts `{ endpointNodeId, position }`
on **both** ends. Straight connectors only allow `CENTER`/`NONE` magnets, and
the docs say `NONE` is set automatically when a position is given, so it
*should* be fine.

**Spike:** a throwaway FigJam plugin with:
- one caller box and one def box;
- a 3-link chain built as in the table, with bend offsets outside the boxes.

Then drag each box vertically and sideways and read back `connectorStart` /
`connectorEnd` to see whether the offsets were kept. Also test with a
**WidgetNode** as the endpoint, since the widget's boxes are widgets, not
rectangles.

**Fallbacks if out-of-bounds offsets don't work:**
- *Widget only:* keep detached lines, but have `toggleNode` shift the
  affected connectors' endpoints by the same delta it applies to the nodes,
  instead of delete + redraw. This is the same effect, done by hand. It doesn't
  help user drags.
- *Invisible anchor nodes* at the bends with `CENTER` magnets (already noted
  as untried in `CLAUDE.md`). These don't follow box moves either, unless the
  widget moves them.
- *One fully node-attached `ELBOWED` connector per edge:* nothing ever needs
  redrawing, but it loses lane staggering, so FigJam's auto-routing may stack
  vertical runs in busy column gaps. That's the problem the lanes exist to fix.

<!--
Shipped:
- position-based-node-lookup — the Parser now looks the function node up by
  position in the full-file AST (`getPositionOfLineAndCharacter` + widest
  function-like node within the definition range, with an ancestor-walk
  fallback for name-only ranges). Deleted the isolated-snippet reparse, the
  `__CodeGraphWrapper__` member fallback, and `Scanner._findPositionedFunctionNode`
  / `looksLike` structural match. This also removed the `positionFail` failure
  mode: large/complex functions no longer fail a structural re-match and lose
  their whole subtree.
-->
