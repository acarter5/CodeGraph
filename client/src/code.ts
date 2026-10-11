// CodeGraph plugin — sandbox side. Has access to the *document* (the `figma`
// API) but NOT to `fetch` or the filesystem. The UI iframe fetches graph.json +
// the snapshot PNGs from the extension's local server and posts them here as
// raw bytes; this side turns them into image nodes laid out in columns (one
// column per graph level) with connectors between calls and their definitions.
//
// Graph prep, layout and connectors live in ./shared so the CodeGraph widget
// (./widget/code.tsx) renders the same graph; this file only draws the boxes.

import type { ManifestPlacement, RenderGraphMessage } from "./manifest";
import { drawEdges } from "./shared/connectors";
import { Box, headerLabelWidth, layoutGraph, prepareGraph } from "./shared/graph";
import {
  BADGE_W,
  CARD_PAD,
  FAILURE_TITLE_COLOR,
  HEADER_H,
  LABEL_FONT,
} from "./shared/style";

figma.showUI(__html__, { themeColors: true, width: 340, height: 260 });

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

async function renderGraph(msg: RenderGraphMessage) {
  const graph = prepareGraph(msg);
  const { placements, edges } = graph;

  // Labels need a loaded font; tolerate failure (just skip the text rather
  // than aborting the whole render).
  let fontLoaded = false;
  try {
    await figma.loadFontAsync(LABEL_FONT);
    fontLoaded = true;
  } catch (err) {
    fontLoaded = false;
  }

  const nodeByPlacement = new Map<string, SceneNode>();
  // Absolute geometry of each snapshot's inner image rect (card minus the header
  // + padding). Call-site connector anchoring is normalized to the image, so the
  // caller side must use this, not the outer card.
  const imageBoxByPlacement = new Map<string, Box>();
  const created: SceneNode[] = [];

  // Builds a box (+ optional label) at a top-left position; returns the rect.
  const createBox = (placement: ManifestPlacement, box: Box): SceneNode => {
    const { x, y, w, h } = box;
    const d = graph.describe(placement);

    const rect = figma.createRectangle();
    rect.resize(w, h);
    rect.x = x;
    rect.y = y;
    rect.cornerRadius = 4;
    rect.name = d.name;

    const tiles = d.tiles;
    if (tiles && tiles.length > 0) {
      // Colored card: fill = the definition's color (matches its connectors),
      // a white file-path header, and the snapshot image inset below it.
      rect.fills = [{ type: "SOLID", color: d.color }];
      created.push(rect);

      if (fontLoaded) {
        // Header band: file path on the left, a duplicate badge on the right.
        // The badge is `<glyph> <index>/<count>` — the glyph (shared by every
        // copy of this definition) identifies which boxes are the same function,
        // and the index/count says which copy this is and how many exist.
        const label = figma.createText();
        label.fontName = LABEL_FONT;
        label.fontSize = 11;
        label.textAutoResize = "NONE";
        label.characters = d.headerText;
        label.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        label.resize(headerLabelWidth(w), HEADER_H);
        label.x = x + CARD_PAD;
        label.y = y + CARD_PAD;
        created.push(label);

        const badge = figma.createText();
        badge.fontName = LABEL_FONT;
        badge.fontSize = 12;
        badge.textAutoResize = "NONE";
        badge.characters = d.badge;
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
      const name = d.name + " (snapshot)";
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
          { type: "IMAGE", scaleMode: "FILL", imageHash: tile.ref },
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
    }

    rect.fills = [{ type: "SOLID", color: d.bg }];
    rect.strokes = [{ type: "SOLID", color: d.stroke }];
    rect.strokeWeight = d.failure ? 2 : 1;
    if (fontLoaded) {
      const label = figma.createText();
      label.fontName = LABEL_FONT;
      label.fontSize = 12;
      label.textAutoResize = "HEIGHT";
      label.characters = `${d.title}\n${d.name}`;
      // Emphasize the failure type: larger, and red for failures.
      label.setRangeFontSize(0, d.title.length, 15);
      if (d.failure) {
        label.setRangeFills(0, d.title.length, [
          { type: "SOLID", color: FAILURE_TITLE_COLOR },
        ]);
      }
      label.resize(w - 24, label.height);
      label.x = x + 12;
      label.y = y + 12;
      created.push(label); // created after rect → renders on top
    }

    created.push(rect);
    return rect;
  };

  const layout = layoutGraph(graph, (p) => {
    const d = graph.describe(p);
    return { w: d.width, h: d.height };
  });

  for (const placement of placements) {
    const box = layout.boxes.get(placement.id) as Box;
    nodeByPlacement.set(placement.id, createBox(placement, box));
  }

  // Connectors are a FigJam-only node type; skip them in a Figma design file.
  if (figma.editorType === "figjam") {
    const connectors = drawEdges(edges, {
      box: (id) => layout.boxes.get(id),
      imageBox: (id) => imageBoxByPlacement.get(id) ?? null,
      collapsedStart: () => null,
      nodeId: (id) => nodeByPlacement.get(id)?.id,
      columnLeftX: (lvl) => layout.columnLeftX.get(lvl),
      columnRightX: (lvl) => layout.columnRightX.get(lvl),
      colorForDef: graph.colorForDef,
    });
    for (const cs of connectors) {
      for (const c of cs) {
        created.push(c);
      }
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
