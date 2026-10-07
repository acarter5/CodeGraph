// Visual constants + per-kind styling shared by the plugin (src/code.ts) and the
// widget (src/widget/code.tsx), so both renderers draw the same graph.

import type { ManifestNodeKind } from "../manifest";

// Vertical gap between boxes in a column (dagre nodesep).
export const ROW_GAP = 80;
// Column gap (dagre ranksep) is computed per-graph so it's wide enough to fit
// every connector's vertical lane; this is the floor.
export const MIN_RANK_SEP = 200;
// Horizontal spacing between adjacent connector vertical lanes in a corridor,
// and the gap from a column edge to the nearest lane.
export const LANE_GAP = 28;
export const CORRIDOR_MARGIN = 28;
// Fallback box size for definitions with no snapshot (e.g. findDefinitionFail).
export const FALLBACK_WIDTH = 260;
export const FALLBACK_HEIGHT = 88;
export const LABEL_FONT: FontName = { family: "Inter", style: "Medium" };
// Snapshot boxes are wrapped in a colored "card": padding around the image plus
// a header band at the top for the file path. The card fill is the definition's
// connector color so each snapshot visually matches the lines pointing to it.
export const CARD_PAD = 10;
export const HEADER_H = 22;
// Right-side header slot for the duplicate badge (`<glyph> <index>/<count>`).
export const BADGE_W = 72;

// Per-definition glyphs, cycled like the colors. A definition's glyph is shared
// across all of its snapshots, so two boxes are the same function iff they show
// the same glyph — duplicates are matchable at a glance even when two different
// definitions happen to land on the same (cycled) color. Basic geometric shapes
// (U+25xx) render reliably across fonts.
export const DEFINITION_GLYPHS: string[] = [
  "◆", "●", "▲", "★", "■", "▼", "◀", "▶",
  "◇", "○", "△", "☆", "□", "▽", "◁", "▷",
];

// Distinct connector colors, cycled per edge so each call→definition line is
// easy to trace.
export const CONNECTOR_COLORS: RGB[] = [
  { r: 0.20, g: 0.60, b: 0.86 }, // blue
  { r: 0.18, g: 0.72, b: 0.46 }, // green
  { r: 0.90, g: 0.49, b: 0.13 }, // orange
  { r: 0.61, g: 0.35, b: 0.71 }, // purple
  { r: 0.84, g: 0.20, b: 0.35 }, // red
  { r: 0.93, g: 0.73, b: 0.06 }, // gold
  { r: 0.09, g: 0.63, b: 0.72 }, // teal
  { r: 0.55, g: 0.40, b: 0.24 }, // brown
];

// Fill/stroke/title-color for a box whose snapshot was in the manifest but
// couldn't be decoded ("⚠ Image too large to render").
export const IMAGE_FAILED_BG: RGB = { r: 0.99, g: 0.91, b: 0.91 };
export const IMAGE_FAILED_STROKE: RGB = { r: 0.85, g: 0.3, b: 0.3 };
export const FAILURE_TITLE_COLOR: RGB = { r: 0.7, g: 0.12, b: 0.12 };

// A placement id is `${definitionId}@${level}`; the definitionId (an object-hash)
// contains no `@`, so everything before the last `@` is the definition id.
export function defIdOf(placementId: string): string {
  const at = placementId.lastIndexOf("@");
  return at === -1 ? placementId : placementId.slice(0, at);
}

// …and everything after it is the level.
export function levelOf(placementId: string): number {
  const n = parseInt(placementId.slice(placementId.lastIndexOf("@") + 1), 10);
  return Number.isNaN(n) ? 0 : n;
}

// The three failure kinds (vs. a plain function that just has no snapshot).
export function isFailureKind(kind: ManifestNodeKind): boolean {
  return (
    kind === "findDefinitionFail" ||
    kind === "parseFail" ||
    kind === "positionFail" ||
    kind === "notAFunction"
  );
}

// A no-image box gets a tint + a title so it isn't a mystery box. Failures are
// red-tinted; a plain no-snapshot function is neutral grey.
export function bgColorForKind(kind: ManifestNodeKind): RGB {
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

export function strokeColorForKind(kind: ManifestNodeKind): RGB {
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
export function titleForKind(kind: ManifestNodeKind): string {
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
