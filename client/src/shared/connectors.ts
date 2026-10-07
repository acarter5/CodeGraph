// Connector drawing shared by the plugin (src/code.ts) and the widget
// (src/widget/code.tsx). FigJam-only — callers check `figma.editorType`.

import type { ManifestEdge } from "../manifest";
import type { Box } from "./graph";
import { CORRIDOR_MARGIN, defIdOf, levelOf } from "./style";

// Where each placement currently sits, as the renderer knows it.
export interface EdgeGeometry {
  // Outer box (card) of a placement, or undefined if it isn't drawn.
  box: (placementId: string) => Box | undefined;
  // The snapshot image inside the card, when it's showing. Call-site rects are
  // normalized to the image, not the outer card, so the caller side anchors
  // against this; null falls back to the card (e.g. a fail-node caller).
  imageBox: (placementId: string) => Box | null;
  // A collapsed caller (widget) has no visible call token; its outgoing
  // call-site edges start here instead. Null when the caller is expanded.
  collapsedStart: (placementId: string) => { x: number; y: number } | null;
  // Scene node id to attach connector endpoints to.
  nodeId: (placementId: string) => string | undefined;
  columnLeftX: (level: number) => number | undefined;
  columnRightX: (level: number) => number | undefined;
  colorForDef: (definitionId: string) => RGB;
}

// Draws every edge and returns the connectors created for each, index-aligned
// with `edges` (empty for an edge whose endpoints aren't drawn).
//
// Each forward, call-site-anchored edge is a chain of straight connectors (a Z:
// horizontal out of the snapshot → vertical lane → horizontal into the def).
// FigJam can't route connectors manually, so we choose the vertical lane's x.
// The edges crossing one column gap (corridor) each get their own lane; the gap
// was sized by prepareGraph to fit them all. Pass every forward edge of a
// corridor together, or lanes will be assigned as if the others didn't exist.
export function drawEdges(
  edges: ManifestEdge[],
  geo: EdgeGeometry
): ConnectorNode[][] {
  const geomOf = (placementId: string) =>
    geo.imageBox(placementId) ?? (geo.box(placementId) as Box);

  // Start of a call-site edge: just past the call token in the caller's image,
  // or the collapsed caller's header.
  const callStart = (e: ManifestEdge) => {
    const collapsed = geo.collapsedStart(e.from);
    if (collapsed) {
      return collapsed;
    }
    const fb = geomOf(e.from);
    const r = e.callSiteRect as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    return {
      x: fb.x + (r.x + r.width) * fb.w,
      y: fb.y + (r.y + r.height / 2) * fb.h,
    };
  };

  const isDrawn = (e: ManifestEdge) => !!geo.box(e.from) && !!geo.box(e.to);

  const corridorGroups = new Map<number, ManifestEdge[]>();
  for (const e of edges) {
    if (e.recursion || !e.callSiteRect || !isDrawn(e)) {
      continue;
    }
    const lvl = levelOf(e.from);
    const arr = corridorGroups.get(lvl) ?? [];
    arr.push(e);
    corridorGroups.set(lvl, arr);
  }
  const stagger = new Map<ManifestEdge, { i: number; n: number }>();
  for (const arr of corridorGroups.values()) {
    // Order top→bottom by call site; lane assignment below makes the first
    // (topmost) edge the rightmost lane and the last the leftmost.
    arr.sort((a, b) => callStart(a).y - callStart(b).y);
    arr.forEach((e, i) => stagger.set(e, { i, n: arr.length }));
  }

  // A single straight connector between two absolute points (a chain link).
  // TODO(node-relative-connectors): pin these ends to the caller/def boxes
  // with `{ endpointNodeId, position }` so the chain follows box moves.
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
    return c;
  };

  return edges.map((edge) => {
    const from = geo.box(edge.from);
    const to = geo.box(edge.to);
    const fromId = geo.nodeId(edge.from);
    const toId = geo.nodeId(edge.to);
    if (!from || !to || !fromId || !toId) {
      return [];
    }
    // Color by destination definition so every line into the same def (and
    // that def's snapshot background) shares one color.
    const color = geo.colorForDef(defIdOf(edge.to));

    const rect = edge.callSiteRect;
    if (rect && !edge.recursion) {
      const start = callStart(edge);
      const endY = to.y + to.h / 2;

      // Lane within the column gap. The corridor spans from this column's
      // right edge to the next column's left edge. First edge (i=0) → furthest
      // right; last (i=n-1) → furthest left.
      const s = stagger.get(edge) ?? { i: 0, n: 1 };
      const lvl = levelOf(edge.from);
      const fb = geomOf(edge.from);
      const corridorL = geo.columnRightX(lvl) ?? fb.x + fb.w;
      const corridorR = geo.columnLeftX(lvl + 1) ?? to.x;
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
      const out = link(start.x, start.y, vx, start.y, color);
      const lane = link(vx, start.y, vx, endY, color);
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
      last.connectorEnd = { endpointNodeId: toId, magnet: "LEFT" };
      last.strokes = [{ type: "SOLID", color }];
      last.strokeWeight = 2;
      return [out, lane, last];
    }

    // Recursion / no call-site rect → one auto-routed connector.
    const connector = figma.createConnector();
    connector.connectorLineType = "ELBOWED";
    connector.strokes = [{ type: "SOLID", color }];
    connector.strokeWeight = 2;
    const collapsed = rect ? geo.collapsedStart(edge.from) : null;
    if (rect && !collapsed) {
      const fb = geomOf(edge.from);
      const callY = fb.y + (rect.y + rect.height / 2) * fb.h;
      connector.connectorStart = {
        position: { x: fb.x + rect.x * fb.w, y: callY },
      };
    } else {
      connector.connectorStart = {
        endpointNodeId: fromId,
        magnet: edge.recursion ? "LEFT" : "RIGHT",
      };
    }
    connector.connectorEnd = {
      endpointNodeId: toId,
      magnet: edge.recursion ? "RIGHT" : "LEFT",
    };
    if (edge.recursion) {
      connector.dashPattern = [6, 6];
    }
    return [connector];
  });
}
