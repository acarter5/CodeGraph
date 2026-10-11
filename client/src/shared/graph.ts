// Graph preparation + layout shared by the plugin (src/code.ts) and the widget
// (src/widget/code.tsx): decode snapshot tiles into image refs, filter, assign
// per-definition colors/glyphs, and run the dagre column layout. Neither step
// creates any scene nodes — each renderer draws boxes its own way.

// Classic dagre 0.8.x (ES5) — the maintained @dagrejs/dagre v3 ships ES2018
// object spread, which Figma's plugin parser rejects ("Unexpected token ...").
import * as dagre from "dagre";

import type {
  ManifestDefinition,
  ManifestEdge,
  ManifestNodeKind,
  ManifestPlacement,
  RenderGraphMessage,
} from "../manifest";
import {
  BADGE_W,
  CARD_PAD,
  CONNECTOR_COLORS,
  CORRIDOR_MARGIN,
  DEFINITION_GLYPHS,
  FALLBACK_HEIGHT,
  FALLBACK_WIDTH,
  HEADER_H,
  IMAGE_FAILED_BG,
  IMAGE_FAILED_STROKE,
  LANE_GAP,
  MIN_RANK_SEP,
  ROW_GAP,
  bgColorForKind,
  isFailureKind,
  levelOf,
  strokeColorForKind,
  titleForKind,
} from "./style";

// A decoded snapshot tile: a reference to its image (a Figma image hash for the
// plugin, a PNG data URI for the widget — widget <Image> can't take a hash)
// plus its normalized [0..1] position/size within the full snapshot image,
// used to place it in the box.
export type RenderedTile = {
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

// The facts about a function node that any component may want to show (collapsed
// card, tooltips, side panels...). Plain data, no formatting.
export interface NodeInfo {
  name: string;
  // Repo(workspace)-relative file path; null when the source is unknown.
  path: string | null;
  // How many times this function's definition appears in the rendered graph.
  instanceCount: number;
}

export type Box = { x: number; y: number; w: number; h: number };

export interface PreparedGraph {
  defById: Map<string, ManifestDefinition>;
  imageTilesByDef: Map<string, RenderedTile[]>;
  // After the "Hide failure nodes" filter.
  placements: ManifestPlacement[];
  edges: ManifestEdge[];
  colorForDef: (definitionId: string) => RGB;
  // Column gap (dagre ranksep), wide enough for the busiest corridor's lanes.
  rankSep: number;
  describe: (placement: ManifestPlacement) => BoxDescription;
  // Info for a definition (counts reflect the rendered, post-filter graph).
  infoForDef: (definitionId: string) => NodeInfo;
}

// Everything a renderer needs to draw one placement's box, independent of how
// it draws it (plain nodes in the plugin, a widget in the widget).
export interface BoxDescription {
  name: string;
  info: NodeInfo;
  // Snapshot card (tiles present): header text + duplicate badge.
  headerText: string;
  badge: string;
  color: RGB;
  tiles: RenderedTile[] | null;
  // Card size when showing the snapshot (or the fallback box size).
  width: number;
  height: number;
  // Inner image size (card minus header + padding); 0 when there's no image.
  imageWidth: number;
  imageHeight: number;
  // No-image box styling: the title line, and whether it's a failure.
  title: string;
  failure: boolean;
  bg: RGB;
  stroke: RGB;
}

// Default tile encoding: upload to Figma and reference by image hash.
const imageHashOf = (bytes: Uint8Array) => figma.createImage(bytes).hash;

export function prepareGraph(
  { manifest, images, hideFailures }: RenderGraphMessage,
  tileRef: (bytes: Uint8Array) => string = imageHashOf
): PreparedGraph {
  // Decode each definition's snapshot tiles into image refs, keeping each
  // tile's normalized position so we can lay them back out to fill the box.
  // `tiles` is null when the UI couldn't decode the PNG at all; createImage can
  // also still reject a tile — either way leave the whole def out and render a
  // labeled box (all-or-nothing: a half-rendered snapshot is worse than a
  // clearly-flagged one).
  const imageTilesByDef = new Map<string, RenderedTile[]>();
  for (const { definitionId, tiles } of images) {
    if (!tiles || tiles.length === 0) {
      continue;
    }
    try {
      const rendered: RenderedTile[] = tiles.map((tile) => ({
        ref: tileRef(tile.bytes),
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

  // Forward, call-site-anchored edges get a chained connector with a vertical
  // lane in the column gap they cross. Size each column gap (dagre ranksep) so
  // the busiest corridor's lanes fit without overlapping.
  const placementIds = new Set(placements.map((p) => p.id));
  const laneCountByLevel = new Map<number, number>();
  for (const e of edges) {
    if (
      !e.recursion &&
      e.callSiteRect &&
      placementIds.has(e.from) &&
      placementIds.has(e.to)
    ) {
      const lvl = levelOf(e.from);
      laneCountByLevel.set(lvl, (laneCountByLevel.get(lvl) ?? 0) + 1);
    }
  }
  let maxLanes = 1;
  for (const count of laneCountByLevel.values()) {
    maxLanes = Math.max(maxLanes, count);
  }
  const rankSep = Math.max(
    MIN_RANK_SEP,
    2 * CORRIDOR_MARGIN + LANE_GAP * (maxLanes - 1)
  );

  const infoForDef = (definitionId: string): NodeInfo => {
    const def = defById.get(definitionId);
    return {
      name: def ? def.name : definitionId,
      path: def && def.path ? def.path : null,
      instanceCount: instanceCountByDef.get(definitionId) ?? 1,
    };
  };

  const describe = (placement: ManifestPlacement): BoxDescription => {
    const def = defById.get(placement.definitionId);
    const name = def ? def.name : placement.definitionId;
    const glyph = glyphByDefinition.get(placement.definitionId) ?? "";
    const idx = instanceIndexByPlacement.get(placement.id) ?? 1;
    const count = instanceCountByDef.get(placement.definitionId) ?? 1;
    const tiles = imageTilesByDef.get(placement.definitionId) ?? null;
    const image = def ? def.image : null;
    const kind = (def ? def.kind : "function") as ManifestNodeKind;
    // The manifest had a snapshot for this def but we have no tiles → the
    // image was too large to render. Flag it loudly rather than blank.
    const imageFailed = !!image && !tiles;
    const failure = imageFailed || isFailureKind(kind);

    // Size from the image's logical dims only when we actually have tiles to
    // fill it with; otherwise (no snapshot, or an image that failed to render)
    // use the small fallback so the box stays readable instead of a giant blank.
    let width = FALLBACK_WIDTH;
    let height = FALLBACK_HEIGHT;
    let imageWidth = 0;
    let imageHeight = 0;
    if (image && tiles) {
      // Card = image + surrounding padding + a header band for the file path.
      imageWidth = image.width / (image.scale || 1);
      imageHeight = image.height / (image.scale || 1);
      width = imageWidth + 2 * CARD_PAD;
      height = imageHeight + HEADER_H + 2 * CARD_PAD;
    }

    return {
      name,
      info: infoForDef(placement.definitionId),
      headerText: def && def.path ? def.path : name,
      badge: `${glyph} ${idx}/${count}`,
      color: colorForDef(placement.definitionId),
      tiles,
      width,
      height,
      imageWidth,
      imageHeight,
      title: imageFailed
        ? "⚠ Image too large to render"
        : failure
        ? `⚠ ${titleForKind(kind)}`
        : titleForKind(kind),
      failure,
      bg: imageFailed ? IMAGE_FAILED_BG : bgColorForKind(kind),
      stroke: imageFailed ? IMAGE_FAILED_STROKE : strokeColorForKind(kind),
    };
  };

  return {
    defById,
    imageTilesByDef,
    placements,
    edges,
    colorForDef,
    rankSep,
    describe,
    infoForDef,
  };
}

// Width reserved for the header's file-path label (the badge sits to its right).
export function headerLabelWidth(cardWidth: number): number {
  return Math.max(1, cardWidth - 2 * CARD_PAD - BADGE_W - 8);
}

export interface GraphLayout {
  // Top-left + size of every placement's box.
  boxes: Map<string, Box>;
  // Each column's left/right x, for placing connector lanes in the gaps.
  columnLeftX: Map<number, number>;
  columnRightX: Map<number, number>;
}

// Layered-DAG layout via dagre: rank = graph level (rankdir LR → columns),
// with crossing-minimization + coordinate assignment so children sit near
// their callers instead of in arbitrary column order. Only forward edges
// shape the layout — recursion back-edges would just introduce cycles; those
// connectors are drawn afterward. `sizeOf` is the box size to lay out with
// (the widget lays collapsed nodes out at their collapsed height).
export function layoutGraph(
  graph: PreparedGraph,
  sizeOf: (placement: ManifestPlacement) => { w: number; h: number }
): GraphLayout {
  const { placements, edges } = graph;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: graph.rankSep });
  g.setDefaultEdgeLabel(() => ({}));

  const sizeByPlacement = new Map<string, { w: number; h: number }>();
  for (const placement of placements) {
    const size = sizeOf(placement);
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

  // Left-align every box in a column. dagre centers same-rank nodes on a
  // shared x, so varying widths leave their LEFT edges ragged; snap them all to
  // the column's leftmost edge. Also record each column's left/right x so the
  // connector lanes can be placed in the gap between columns.
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

  const boxes = new Map<string, Box>();
  for (const placement of placements) {
    const size = sizeByPlacement.get(placement.id) as { w: number; h: number };
    const cy = centerYByPlacement.get(placement.id) ?? 0;
    boxes.set(placement.id, {
      x: columnLeftX.get(levelOf(placement.id)) ?? 0,
      y: cy - size.h / 2,
      w: size.w,
      h: size.h,
    });
  }

  return { boxes, columnLeftX, columnRightX };
}
