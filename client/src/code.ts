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

// The three failure kinds (vs. a plain function that just has no snapshot).
function isFailureKind(kind: ManifestNodeKind): boolean {
  return (
    kind === "findDefinitionFail" ||
    kind === "parseFail" ||
    kind === "positionFail"
  );
}

// A no-image box gets a tint + a title so it isn't a mystery box. Failures are
// red-tinted; a plain no-snapshot function is neutral grey.
function bgColorForKind(kind: ManifestNodeKind): RGB {
  if (kind === "findDefinitionFail") {
    return { r: 0.99, g: 0.91, b: 0.91 };
  }
  if (kind === "parseFail" || kind === "positionFail") {
    return { r: 0.99, g: 0.97, b: 0.86 };
  }
  return { r: 0.95, g: 0.95, b: 0.96 };
}

function strokeColorForKind(kind: ManifestNodeKind): RGB {
  if (kind === "findDefinitionFail") {
    return { r: 0.85, g: 0.3, b: 0.3 };
  }
  if (kind === "parseFail" || kind === "positionFail") {
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
    case "positionFail":
      return "Could not locate in file";
    default:
      return "No snapshot";
  }
}

async function renderGraph({ manifest, images }: RenderGraphMessage) {
  // Decode each definition's PNG into an image hash once. `bytes` is null when
  // the UI couldn't downscale it within Figma's 4096px limit; createImage can
  // also still reject — either way leave it out and render a labeled box below.
  const imageHashByDef = new Map<string, string>();
  for (const { definitionId, bytes } of images) {
    if (!bytes) {
      continue;
    }
    try {
      imageHashByDef.set(definitionId, figma.createImage(bytes).hash);
    } catch (err) {
      // too large / unsupported — falls through to the failed-image box
    }
  }

  const defById = new Map(manifest.definitions.map((d) => [d.id, d]));

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
    return image && imageHashByDef.has(definitionId)
      ? {
          w: image.width / (image.scale || 1),
          h: image.height / (image.scale || 1),
        }
      : { w: FALLBACK_WIDTH, h: FALLBACK_HEIGHT };
  };

  const nodeByPlacement = new Map<string, SceneNode>();
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

    const hash = imageHashByDef.get(placement.definitionId);
    if (hash) {
      rect.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: hash }];
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
  const placementIds = new Set(manifest.placements.map((p) => p.id));
  const forwardEdges = manifest.edges.filter(
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
  for (const placement of manifest.placements) {
    const size = sizeOf(placement.definitionId);
    sizeByPlacement.set(placement.id, size);
    g.setNode(placement.id, { width: size.w, height: size.h });
  }

  const seenLayoutEdges = new Set<string>();
  for (const edge of manifest.edges) {
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
  for (const placement of manifest.placements) {
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

  for (const placement of manifest.placements) {
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
    const callStartY = (e: ManifestEdge) => {
      const f = nodeByPlacement.get(e.from) as SceneNode;
      const r = e.callSiteRect as { y: number; height: number };
      return f.y + (r.y + r.height / 2) * f.height;
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

    let colorIndex = 0;
    for (const edge of manifest.edges) {
      const from = nodeByPlacement.get(edge.from);
      const to = nodeByPlacement.get(edge.to);
      if (!from || !to) {
        continue;
      }
      // (1) Distinct color per edge so each call→definition line is traceable.
      const color = CONNECTOR_COLORS[colorIndex % CONNECTOR_COLORS.length];
      colorIndex += 1;

      const rect = edge.callSiteRect;
      if (rect && !edge.recursion) {
        // (2) Start inside the caller's snapshot, just past the call token.
        const startX = from.x + (rect.x + rect.width) * from.width;
        const startY = from.y + (rect.y + rect.height / 2) * from.height;
        const endY = to.y + to.height / 2;

        // Lane within the column gap. The corridor spans from this column's
        // right edge to the next column's left edge. First edge (i=0) → furthest
        // right; last (i=n-1) → furthest left.
        const s = stagger.get(edge) ?? { i: 0, n: 1 };
        const lvl = levelOf(edge.from);
        const corridorL = columnRightX.get(lvl) ?? from.x + from.width;
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
        const callY = from.y + (rect.y + rect.height / 2) * from.height;
        connector.connectorStart = {
          position: { x: from.x + rect.x * from.width, y: callY },
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
    placements: manifest.placements.length,
    edges: manifest.edges.length,
  });
  figma.notify(`CodeGraph: rendered ${manifest.placements.length} boxes`);
}
