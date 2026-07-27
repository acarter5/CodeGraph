// CodeGraph plugin — sandbox side. Has access to the *document* (the `figma`
// API) but NOT to `fetch` or the filesystem. The UI iframe fetches graph.json +
// the snapshot PNGs from the extension's local server and posts them here as
// raw bytes; this side turns them into image nodes laid out in columns (one
// column per graph level) with connectors between calls and their definitions.

// Classic dagre 0.8.x (ES5) — the maintained @dagrejs/dagre v3 ships ES2018
// object spread, which Figma's plugin parser rejects ("Unexpected token ...").
import * as dagre from "dagre";

import type {
  ManifestEdge,
  ManifestNodeKind,
  ManifestPlacement,
  RenderGraphMessage,
} from "./manifest";

// A decoded snapshot tile: its Figma image hash plus its normalized [0..1]
// position/size within the full snapshot image, used to place it in the box.
type RenderedTile = {
  hash: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

figma.showUI(__html__, { themeColors: true, width: 340, height: 260 });

// Vertical gap between boxes in a column (dagre nodesep).
const ROW_GAP = 80;
// Column gap (dagre ranksep) is computed per-graph so it's wide enough to fit
// every connector's vertical lane; this is the floor.
const MIN_RANK_SEP = 200;
// Horizontal spacing between adjacent connector vertical lanes in a corridor,
// and the gap from a column edge to the nearest lane.
const LANE_GAP = 28;
const CORRIDOR_MARGIN = 28;
// Fallback box size for definitions with no snapshot (e.g. findDefinitionFail).
const FALLBACK_WIDTH = 260;
const FALLBACK_HEIGHT = 88;
const LABEL_FONT: FontName = { family: "Inter", style: "Medium" };
// Snapshot boxes are wrapped in a colored "card": padding around the image plus
// a header band at the top for the file path. The card fill is the definition's
// connector color so each snapshot visually matches the lines pointing to it.
const CARD_PAD = 10;
const HEADER_H = 22;
// Right-side header slot for the duplicate badge (`<glyph> <index>/<count>`).
const BADGE_W = 72;

// Per-definition glyphs, cycled like the colors. A definition's glyph is shared
// across all of its snapshots, so two boxes are the same function iff they show
// the same glyph — duplicates are matchable at a glance even when two different
// definitions happen to land on the same (cycled) color. Basic geometric shapes
// (U+25xx) render reliably across fonts.
const DEFINITION_GLYPHS: string[] = [
  "◆", "●", "▲", "★", "■", "▼", "◀", "▶",
  "◇", "○", "△", "☆", "□", "▽", "◁", "▷",
];

// Distinct connector colors, cycled per edge so each call→definition line is
// easy to trace.
const CONNECTOR_COLORS: RGB[] = [
  { r: 0.20, g: 0.60, b: 0.86 }, // blue
  { r: 0.18, g: 0.72, b: 0.46 }, // green
  { r: 0.90, g: 0.49, b: 0.13 }, // orange
  { r: 0.61, g: 0.35, b: 0.71 }, // purple
  { r: 0.84, g: 0.20, b: 0.35 }, // red
  { r: 0.93, g: 0.73, b: 0.06 }, // gold
  { r: 0.09, g: 0.63, b: 0.72 }, // teal
  { r: 0.55, g: 0.40, b: 0.24 }, // brown
];

figma.ui.onmessage = async (msg: RenderGraphMessage | { type: string }) => {
  if (msg.type === "render-graph") {
    try {
      await renderGraph(msg as RenderGraphMessage);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.notify(`CodeGraph: render failed — ${message}`, { error: true });
      figma.ui.postMessage({ type: "error", message });
    }
    return;
  }
  if (msg.type === "cancel") {
    figma.closePlugin();
  }
};

// A placement id is `${definitionId}@${level}`; the definitionId (an object-hash)
// contains no `@`, so everything before the last `@` is the definition id.
function defIdOf(placementId: string): string {
  const at = placementId.lastIndexOf("@");
  return at === -1 ? placementId : placementId.slice(0, at);
}

// The three failure kinds (vs. a plain function that just has no snapshot).
function isFailureKind(kind: ManifestNodeKind): boolean {
  return (
    kind === "findDefinitionFail" ||
    kind === "parseFail" ||
    kind === "positionFail" ||
    kind === "notAFunction"
  );
}

// A no-image box gets a tint + a title so it isn't a mystery box. Failures are
// red-tinted; a plain no-snapshot function is neutral grey.
function bgColorForKind(kind: ManifestNodeKind): RGB {
  if (kind === "findDefinitionFail") {
    return { r: 0.99, g: 0.91, b: 0.91 };
  }
  if (
    kind === "parseFail" ||
    kind === "positionFail" ||
    kind === "notAFunction"
  ) {
    return { r: 0.99, g: 0.97, b: 0.86 };
  }
  return { r: 0.95, g: 0.95, b: 0.96 };
}

function strokeColorForKind(kind: ManifestNodeKind): RGB {
  if (kind === "findDefinitionFail") {
    return { r: 0.85, g: 0.3, b: 0.3 };
  }
  if (
    kind === "parseFail" ||
    kind === "positionFail" ||
    kind === "notAFunction"
  ) {
    return { r: 0.85, g: 0.65, b: 0.2 };
  }
  return { r: 0.8, g: 0.8, b: 0.82 };
}

// Human-readable failure type shown as the box header.
function titleForKind(kind: ManifestNodeKind): string {
  switch (kind) {
    case "findDefinitionFail":
      return "Definition not found";
    case "parseFail":
      return "Parse failed";
    case "notAFunction":
      return "Not a function (value)";
    case "positionFail":
      return "Could not locate in file";
    default:
      return "No snapshot";
  }
}

async function renderGraph({
  manifest,
  images,
  hideFailures,
}: RenderGraphMessage) {
  // Decode each definition's snapshot tiles into image hashes, keeping each
  // tile's normalized position so we can lay them back out to fill the box.
  // `tiles` is null when the UI couldn't decode the PNG at all; createImage can
  // also still reject a tile — either way leave the whole def out and render a
  // labeled box below (all-or-nothing: a half-rendered snapshot is worse than a
  // clearly-flagged one).
  const imageTilesByDef = new Map<string, RenderedTile[]>();
  for (const { definitionId, tiles } of images) {
    if (!tiles || tiles.length === 0) {
      continue;
    }
    try {
      const rendered: RenderedTile[] = tiles.map((tile) => ({
        hash: figma.createImage(tile.bytes).hash,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
      }));
      imageTilesByDef.set(definitionId, rendered);
    } catch (err) {
      // a tile too large / unsupported — falls through to the failed-image box
    }
  }

  const defById = new Map(manifest.definitions.map((d) => [d.id, d]));

  // One color per definition (cycled in stable definition order). This is the
  // single source of truth for both connector color and snapshot background, so
  // every line into a definition, and every box of that definition, agree.
  const colorByDefinition = new Map<string, RGB>();
  manifest.definitions.forEach((d, i) => {
    colorByDefinition.set(d.id, CONNECTOR_COLORS[i % CONNECTOR_COLORS.length]);
  });
  const colorForDef = (definitionId: string): RGB =>
    colorByDefinition.get(definitionId) ?? CONNECTOR_COLORS[0];

  // One glyph per definition (same stable order as the colors), shared across
  // all of that definition's snapshots.
  const glyphByDefinition = new Map<string, string>();
  manifest.definitions.forEach((d, i) => {
    glyphByDefinition.set(d.id, DEFINITION_GLYPHS[i % DEFINITION_GLYPHS.length]);
  });

  // When the "Hide failure nodes" toggle is on, drop every failure-kind
  // placement and any edge touching one, so the graph shows only the resolved
  // call flow. Filter once here; the rest of the render works off these.
  const isHiddenDef = (definitionId: string): boolean => {
    const def = defById.get(definitionId);
    return !!hideFailures && !!def && isFailureKind(def.kind);
  };
  const hiddenPlacementIds = new Set(
    manifest.placements
      .filter((p) => isHiddenDef(p.definitionId))
      .map((p) => p.id)
  );
  const placements = manifest.placements.filter(
    (p) => !hiddenPlacementIds.has(p.id)
  );
  const edges = manifest.edges.filter(
    (e) => !hiddenPlacementIds.has(e.from) && !hiddenPlacementIds.has(e.to)
  );

  // Instance numbering for the duplicate badge: how many times each definition
  // appears in the rendered graph, and this placement's 1-based index among them
  // (ordered by level). A box's badge reads `<glyph> <index>/<count>`.
  const placementsByDefinition = new Map<string, ManifestPlacement[]>();
  for (const p of placements) {
    const arr = placementsByDefinition.get(p.definitionId) ?? [];
    arr.push(p);
    placementsByDefinition.set(p.definitionId, arr);
  }
  const instanceCountByDef = new Map<string, number>();
  const instanceIndexByPlacement = new Map<string, number>();
  for (const [defId, arr] of placementsByDefinition) {
    arr.sort((a, b) => a.level - b.level);
    instanceCountByDef.set(defId, arr.length);
    arr.forEach((p, i) => instanceIndexByPlacement.set(p.id, i + 1));
  }

  // Labels for no-image boxes need a loaded font; tolerate failure (just skip
  // the text rather than aborting the whole render).
  let fontLoaded = false;
  try {
    await figma.loadFontAsync(LABEL_FONT);
    fontLoaded = true;
  } catch (err) {
    fontLoaded = false;
  }

  // Size from the image's logical dims only when we actually have a hash to
  // fill it with; otherwise (no snapshot, or an image that failed to render)
  // use the small fallback so the box stays readable instead of a giant blank.
  const sizeOf = (definitionId: string) => {
    const image = defById.get(definitionId)?.image ?? null;
    if (image && imageTilesByDef.has(definitionId)) {
      // Card = image + surrounding padding + a header band for the file path.
      const imgW = image.width / (image.scale || 1);
      const imgH = image.height / (image.scale || 1);
      return {
        w: imgW + 2 * CARD_PAD,
        h: imgH + HEADER_H + 2 * CARD_PAD,
      };
    }
    return { w: FALLBACK_WIDTH, h: FALLBACK_HEIGHT };
  };

  const nodeByPlacement = new Map<string, SceneNode>();
  // Absolute geometry of each snapshot's inner image rect (card minus the header
  // + padding). Call-site connector anchoring is normalized to the image, so the
  // caller side must use this, not the outer card.
  const imageBoxByPlacement = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();
  const created: SceneNode[] = [];

  // Builds a box (+ optional label) at a top-left position; returns the rect.
  const createBox = (
    placement: ManifestPlacement,
    x: number,
    y: number,
    w: number,
    h: number
  ): SceneNode => {
    const def = defById.get(placement.definitionId);

    const rect = figma.createRectangle();
    rect.resize(w, h);
    rect.x = x;
    rect.y = y;
    rect.cornerRadius = 4;
    rect.name = def ? def.name : placement.definitionId;

    const tiles = imageTilesByDef.get(placement.definitionId);
    if (tiles && tiles.length > 0) {
      // Colored card: fill = the definition's color (matches its connectors),
      // a white file-path header, and the snapshot image inset below it.
      rect.fills = [
        { type: "SOLID", color: colorForDef(placement.definitionId) },
      ];
      created.push(rect);

      if (fontLoaded) {
        // Header band: file path on the left, a duplicate badge on the right.
        // The badge is `<glyph> <index>/<count>` — the glyph (shared by every
        // copy of this definition) identifies which boxes are the same function,
        // and the index/count says which copy this is and how many exist.
        const glyph = glyphByDefinition.get(placement.definitionId) ?? "";
        const idx = instanceIndexByPlacement.get(placement.id) ?? 1;
        const count = instanceCountByDef.get(placement.definitionId) ?? 1;

        const label = figma.createText();
        label.fontName = LABEL_FONT;
        label.fontSize = 11;
        label.textAutoResize = "NONE";
        label.characters =
          def && def.path ? def.path : def ? def.name : placement.definitionId;
        label.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        label.resize(Math.max(1, w - 2 * CARD_PAD - BADGE_W - 8), HEADER_H);
        label.x = x + CARD_PAD;
        label.y = y + CARD_PAD;
        created.push(label);

        const badge = figma.createText();
        badge.fontName = LABEL_FONT;
        badge.fontSize = 12;
        badge.textAutoResize = "NONE";
        badge.characters = `${glyph} ${idx}/${count}`;
        badge.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        badge.textAlignHorizontal = "RIGHT";
        badge.resize(BADGE_W, HEADER_H);
        badge.x = x + w - CARD_PAD - BADGE_W;
        badge.y = y + CARD_PAD;
        created.push(badge);
      }

      const imgX = x + CARD_PAD;
      const imgY = y + CARD_PAD + HEADER_H;
      const imgW = w - 2 * CARD_PAD;
      const imgH = h - HEADER_H - 2 * CARD_PAD;
      // One rectangle per tile, positioned by the tile's normalized rect so the
      // tiles abut exactly and together fill the image box. Each tile's aspect
      // ratio matches its rect (it's a crop at the same scale), so FILL fills it
      // with no distortion. Kept at full capture resolution — no downscaling.
      const name = (def ? def.name : placement.definitionId) + " (snapshot)";
      tiles.forEach((tile, i) => {
        const image = figma.createRectangle();
        image.resize(
          Math.max(1, tile.width * imgW),
          Math.max(1, tile.height * imgH)
        );
        image.x = imgX + tile.x * imgW;
        image.y = imgY + tile.y * imgH;
        image.cornerRadius = 2;
        image.name = tiles.length > 1 ? `${name} [${i + 1}/${tiles.length}]` : name;
        image.fills = [
          { type: "IMAGE", scaleMode: "FILL", imageHash: tile.hash },
        ];
        created.push(image);
      });
      imageBoxByPlacement.set(placement.id, {
        x: imgX,
        y: imgY,
        w: imgW,
        h: imgH,
      });
      return rect;
    } else {
      const kind = (def ? def.kind : "function") as ManifestNodeKind;
      // The manifest had a snapshot for this def but we have no hash → the
      // image was too large to render. Flag it loudly rather than blank.
      const imageFailed = !!def?.image;
      const failure = imageFailed || isFailureKind(kind);
      const bg = imageFailed
        ? { r: 0.99, g: 0.91, b: 0.91 }
        : bgColorForKind(kind);
      const stroke = imageFailed
        ? { r: 0.85, g: 0.3, b: 0.3 }
        : strokeColorForKind(kind);
      rect.fills = [{ type: "SOLID", color: bg }];
      rect.strokes = [{ type: "SOLID", color: stroke }];
      rect.strokeWeight = failure ? 2 : 1;
      if (fontLoaded) {
        const name = def ? def.name : placement.definitionId;
        const title = imageFailed
          ? "⚠ Image too large to render"
          : failure
          ? `⚠ ${titleForKind(kind)}`
          : titleForKind(kind);
        const label = figma.createText();
        label.fontName = LABEL_FONT;
        label.fontSize = 12;
        label.textAutoResize = "HEIGHT";
        label.characters = `${title}\n${name}`;
        // Emphasize the failure type: larger, and red for failures.
        label.setRangeFontSize(0, title.length, 15);
        if (failure) {
          label.setRangeFills(0, title.length, [
            { type: "SOLID", color: { r: 0.7, g: 0.12, b: 0.12 } },
          ]);
        }
        label.resize(w - 24, label.height);
        label.x = x + 12;
        label.y = y + 12;
        created.push(label); // created after rect → renders on top
      }
    }

    created.push(rect);
    return rect;
  };

  // A placement id is `${definitionId}@${level}`.
  const levelOf = (placementId: string) => {
    const n = parseInt(placementId.slice(placementId.lastIndexOf("@") + 1), 10);
    return Number.isNaN(n) ? 0 : n;
  };

  // Forward, call-site-anchored edges get a chained connector with a vertical
  // lane in the column gap they cross. Size each column gap (dagre ranksep) so
  // the busiest corridor's lanes fit without overlapping.
  const placementIds = new Set(placements.map((p) => p.id));
  const forwardEdges = edges.filter(
    (e) =>
      !e.recursion &&
      e.callSiteRect &&
      placementIds.has(e.from) &&
      placementIds.has(e.to)
  );
  const laneCountByLevel = new Map<number, number>();
  for (const e of forwardEdges) {
    const lvl = levelOf(e.from);
    laneCountByLevel.set(lvl, (laneCountByLevel.get(lvl) ?? 0) + 1);
  }
  let maxLanes = 1;
  for (const count of laneCountByLevel.values()) {
    maxLanes = Math.max(maxLanes, count);
  }
  const rankSep = Math.max(
    MIN_RANK_SEP,
    2 * CORRIDOR_MARGIN + LANE_GAP * (maxLanes - 1)
  );

  // Layered-DAG layout via dagre: rank = graph level (rankdir LR → columns),
  // with crossing-minimization + coordinate assignment so children sit near
  // their callers instead of in arbitrary column order. Only forward edges
  // shape the layout — recursion back-edges would just introduce cycles; we
  // draw those connectors afterward.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: rankSep });
  g.setDefaultEdgeLabel(() => ({}));

  const sizeByPlacement = new Map<string, { w: number; h: number }>();
  for (const placement of placements) {
    const size = sizeOf(placement.definitionId);
    sizeByPlacement.set(placement.id, size);
    g.setNode(placement.id, { width: size.w, height: size.h });
  }

  const seenLayoutEdges = new Set<string>();
  for (const edge of edges) {
    if (edge.recursion) {
      continue;
    }
    const key = `${edge.from}->${edge.to}`;
    if (seenLayoutEdges.has(key)) {
      continue; // several call sites → one structural edge for layout
    }
    seenLayoutEdges.add(key);
    if (g.hasNode(edge.from) && g.hasNode(edge.to)) {
      g.setEdge(edge.from, edge.to);
    }
  }

  dagre.layout(g);

  // (1) Left-align every box in a column. dagre centers same-rank nodes on a
  // shared x, so varying widths leave their LEFT edges ragged; snap them all to
  // the column's leftmost edge. Also record each column's left/right x so the
  // connector lanes below can be placed in the gap between columns.
  const columnLeftX = new Map<number, number>();
  const columnRightX = new Map<number, number>();
  const centerYByPlacement = new Map<string, number>();
  const placementsByLevel = new Map<number, ManifestPlacement[]>();
  for (const placement of placements) {
    const lvl = levelOf(placement.id);
    const arr = placementsByLevel.get(lvl) ?? [];
    arr.push(placement);
    placementsByLevel.set(lvl, arr);
    const pos = g.node(placement.id) as { y?: number } | undefined;
    centerYByPlacement.set(
      placement.id,
      pos && typeof pos.y === "number" ? pos.y : 0
    );
  }
  for (const [lvl, ps] of placementsByLevel) {
    let leftX = Infinity;
    let maxW = 0;
    for (const p of ps) {
      const size = sizeByPlacement.get(p.id) as { w: number; h: number };
      const pos = g.node(p.id) as { x?: number } | undefined;
      const cx = pos && typeof pos.x === "number" ? pos.x : 0;
      leftX = Math.min(leftX, cx - size.w / 2);
      maxW = Math.max(maxW, size.w);
    }
    if (!isFinite(leftX)) {
      leftX = 0;
    }
    columnLeftX.set(lvl, leftX);
    columnRightX.set(lvl, leftX + maxW);
  }

  for (const placement of placements) {
    const size = sizeByPlacement.get(placement.id) as { w: number; h: number };
    const x = columnLeftX.get(levelOf(placement.id)) ?? 0;
    const cy = centerYByPlacement.get(placement.id) ?? 0;
    const rect = createBox(placement, x, cy - size.h / 2, size.w, size.h);
    nodeByPlacement.set(placement.id, rect);
  }

  // Connectors are a FigJam-only node type; skip them in a Figma design file.
  if (figma.editorType === "figjam") {
    // (3) Each forward edge is a chain of straight connectors (a Z: horizontal
    // out of the snapshot → vertical lane → horizontal into the def). FigJam
    // can't route connectors manually, so we choose the vertical lane's x. Group
    // the edges by the column gap (corridor) they cross and give each its own
    // lane; the column gap was sized above to fit them all.
    const corridorGroups = new Map<number, ManifestEdge[]>();
    for (const e of forwardEdges) {
      const lvl = levelOf(e.from);
      const arr = corridorGroups.get(lvl) ?? [];
      arr.push(e);
      corridorGroups.set(lvl, arr);
    }
    // Call-site rects are normalized to the snapshot image, not the outer card,
    // so anchor against the image geometry; fall back to the card for nodes that
    // have no inner image (e.g. a fail-node caller).
    const geomOf = (placementId: string) => {
      const box = imageBoxByPlacement.get(placementId);
      if (box) {
        return box;
      }
      const n = nodeByPlacement.get(placementId) as SceneNode;
      return { x: n.x, y: n.y, w: n.width, h: n.height };
    };
    const callStartY = (e: ManifestEdge) => {
      const f = geomOf(e.from);
      const r = e.callSiteRect as { y: number; height: number };
      return f.y + (r.y + r.height / 2) * f.h;
    };
    const stagger = new Map<ManifestEdge, { i: number; n: number }>();
    for (const arr of corridorGroups.values()) {
      // Order top→bottom by call site; lane assignment below makes the first
      // (topmost) edge the rightmost lane and the last the leftmost.
      arr.sort((a, b) => callStartY(a) - callStartY(b));
      arr.forEach((e, i) => stagger.set(e, { i, n: arr.length }));
    }

    // A single straight connector between two absolute points (a chain link).
    const link = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      color: RGB
    ) => {
      const c = figma.createConnector();
      c.connectorLineType = "STRAIGHT";
      c.connectorStartStrokeCap = "NONE";
      c.connectorEndStrokeCap = "NONE";
      c.connectorStart = { position: { x: ax, y: ay } };
      c.connectorEnd = { position: { x: bx, y: by } };
      c.strokes = [{ type: "SOLID", color }];
      c.strokeWeight = 2;
      created.push(c);
      return c;
    };

    for (const edge of edges) {
      const from = nodeByPlacement.get(edge.from);
      const to = nodeByPlacement.get(edge.to);
      if (!from || !to) {
        continue;
      }
      // (1) Color by destination definition so every line into the same def (and
      // that def's snapshot background) shares one color.
      const color = colorForDef(defIdOf(edge.to));

      const rect = edge.callSiteRect;
      if (rect && !edge.recursion) {
        // (2) Start inside the caller's snapshot image, just past the call token.
        const fb = geomOf(edge.from);
        const startX = fb.x + (rect.x + rect.width) * fb.w;
        const startY = fb.y + (rect.y + rect.height / 2) * fb.h;
        const endY = to.y + to.height / 2;

        // Lane within the column gap. The corridor spans from this column's
        // right edge to the next column's left edge. First edge (i=0) → furthest
        // right; last (i=n-1) → furthest left.
        const s = stagger.get(edge) ?? { i: 0, n: 1 };
        const lvl = levelOf(edge.from);
        const corridorL = columnRightX.get(lvl) ?? fb.x + fb.w;
        const corridorR = columnLeftX.get(lvl + 1) ?? to.x;
        const innerL = corridorL + CORRIDOR_MARGIN;
        const innerR = corridorR - CORRIDOR_MARGIN;
        let vx: number;
        if (s.n <= 1 || innerR <= innerL) {
          vx = (corridorL + corridorR) / 2;
        } else {
          vx = innerR - (innerR - innerL) * (s.i / (s.n - 1));
        }

        // Chain: horizontal out of the snapshot → vertical at vx → horizontal
        // into the definition. Same color throughout; arrow only on the last
        // link, which attaches to the def box so it tracks the node.
        link(startX, startY, vx, startY, color);
        link(vx, startY, vx, endY, color);
        // Last link: ELBOWED so it can use a LEFT magnet (straight connectors
        // only allow CENTER/NONE), attaching the arrow to the def box so it
        // tracks the node. Start/end share y → still draws as a straight
        // horizontal. (We don't group the 3 links: FigJam dissolves groups of
        // connectors, so grouping was a no-op and cost the box-tracking arrow.)
        const last = figma.createConnector();
        last.connectorLineType = "ELBOWED";
        last.connectorStartStrokeCap = "NONE";
        last.connectorEndStrokeCap = "ARROW_LINES";
        last.connectorStart = { position: { x: vx, y: endY } };
        last.connectorEnd = { endpointNodeId: to.id, magnet: "LEFT" };
        last.strokes = [{ type: "SOLID", color }];
        last.strokeWeight = 2;
        created.push(last);
        continue;
      }

      // Recursion / no call-site rect → one auto-routed connector.
      const connector = figma.createConnector();
      connector.connectorLineType = "ELBOWED";
      connector.strokes = [{ type: "SOLID", color }];
      connector.strokeWeight = 2;
      if (rect) {
        const fb = geomOf(edge.from);
        const callY = fb.y + (rect.y + rect.height / 2) * fb.h;
        connector.connectorStart = {
          position: { x: fb.x + rect.x * fb.w, y: callY },
        };
      } else {
        connector.connectorStart = {
          endpointNodeId: from.id,
          magnet: edge.recursion ? "LEFT" : "RIGHT",
        };
      }
      connector.connectorEnd = {
        endpointNodeId: to.id,
        magnet: edge.recursion ? "RIGHT" : "LEFT",
      };
      if (edge.recursion) {
        connector.dashPattern = [6, 6];
      }
      created.push(connector);
    }
  }

  // Filter out anything that no longer exists (e.g. a group node that FigJam
  // dissolved) so set_selection can't throw "node does not exist".
  const live = created.filter((n) => !n.removed);
  if (live.length > 0) {
    figma.currentPage.selection = live;
    figma.viewport.scrollAndZoomIntoView(live);
  }

  figma.ui.postMessage({
    type: "done",
    placements: placements.length,
    edges: edges.length,
  });
  figma.notify(`CodeGraph: rendered ${placements.length} boxes`);
}
