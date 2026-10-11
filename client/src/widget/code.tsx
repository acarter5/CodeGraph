// CodeGraph widget — an interactive alternative to the plugin (src/code.ts).
// Same UI iframe, same graph prep / layout / connectors (./shared), but every
// box is a widget instance, so it can respond to clicks: each node after the
// root starts collapsed to its header and expands to its snapshot on click,
// pushing the rest of its column apart to make room.
//
// A plugin can't create widgets — widgets can only clone themselves — so the
// whole flow lives here. The first widget the user drops in is the *launcher*
// ("Load graph" opens the UI); rendering clones it once per placement with
// `role: "node"` synced state.

import type {
  ManifestEdge,
  RenderGraphMessage,
} from "../manifest";
import { drawEdges, EdgeGeometry } from "../shared/connectors";
import {
  Box,
  BoxDescription,
  headerLabelWidth,
  layoutGraph,
  prepareGraph,
} from "../shared/graph";
import {
  BADGE_W,
  CARD_PAD,
  FAILURE_TITLE_COLOR,
  HEADER_H,
  defIdOf,
  levelOf,
} from "../shared/style";

const { widget } = figma;
const {
  AutoLayout,
  Frame,
  Image,
  Input,
  Rectangle,
  Text,
  usePropertyMenu,
  useSyncedState,
  useWidgetNodeId,
} = widget;

// An expanded node's header band, and a collapsed node (header + a detail line
// with the file path and instance count).
const HEADER_BAND_H = HEADER_H + 2 * CARD_PAD;
const COLLAPSED_H = HEADER_BAND_H + 16;
// Gap between the launcher and the top of the graph it renders.
const GRAPH_OFFSET_Y = 80;
const WHITE = "#FFFFFF";
// An expanded node grows a notes panel to the left of its snapshot.
const NOTES_W = 360;
const NOTE_LINE_H = 20;
const PAPER = "#FFF8B8";
const PAPER_RULE = "#9CC7E8";
const PAPER_MARGIN = "#E8888C";

// Extra card width an expanded node takes for its notes panel.
const NOTES_EXTRA = NOTES_W + CARD_PAD;

// What a node widget needs to draw itself (its synced "node" state). It's the
// shared BoxDescription plus which graph/placement it belongs to.
interface NodeData extends BoxDescription {
  graphId: string;
  placementId: string;
}

// Per-graph state that no single node owns, kept in root plugin data: each
// edge, and the connector node ids drawn for it, so a toggle can delete and
// redraw the connectors it moved. One entry per edge — Figma caps a single
// plugin-data entry at 100 kB, which one blob would blow on a large graph.
interface StoredEdge {
  edge: ManifestEdge;
  connectorIds: string[];
}

const edgeCountKey = (graphId: string) => `graph:${graphId}:edges`;
const edgeKey = (graphId: string, i: number) => `graph:${graphId}:edge:${i}`;

function loadEdges(graphId: string): StoredEdge[] {
  const count = parseInt(figma.root.getPluginData(edgeCountKey(graphId)), 10);
  const out: StoredEdge[] = [];
  for (let i = 0; i < (Number.isNaN(count) ? 0 : count); i++) {
    const raw = figma.root.getPluginData(edgeKey(graphId, i));
    if (raw) {
      out.push(JSON.parse(raw) as StoredEdge);
    }
  }
  return out;
}

function saveEdge(graphId: string, i: number, stored: StoredEdge) {
  figma.root.setPluginData(edgeKey(graphId, i), JSON.stringify(stored));
}

const expandable = (data: NodeData) => !!data.tiles && data.tiles.length > 0;

// Expandable nodes reserve room for the notes panel even while collapsed, so
// toggling never changes a node's width (and no column has to shift).
function widthOf(data: NodeData, _expanded: boolean): number {
  return expandable(data) ? data.width + NOTES_EXTRA : data.width;
}

function heightOf(data: NodeData, expanded: boolean): number {
  return expandable(data) && !expanded ? COLLAPSED_H : data.height;
}

// The snapshot image's box within a card whose top-left is (x, y).
function imageBoxAt(x: number, y: number, data: NodeData): Box {
  return {
    x: x + CARD_PAD + NOTES_EXTRA,
    y: y + CARD_PAD + HEADER_H,
    w: data.imageWidth,
    h: data.imageHeight,
  };
}

const toColor = (c: RGB) => ({ r: c.r, g: c.g, b: c.b, a: 1 });

// Connector geometry for a set of placements at known positions.
function geometryFor(
  entries: Map<
    string,
    { id: string; x: number; y: number; data: NodeData; expanded: boolean }
  >
): EdgeGeometry {
  const box = (pid: string): Box | undefined => {
    const e = entries.get(pid);
    return e
      ? { x: e.x, y: e.y, w: widthOf(e.data, e.expanded), h: heightOf(e.data, e.expanded) }
      : undefined;
  };
  // Column bounds come from where the nodes actually are now, so the graph
  // still routes correctly after the user drags the whole thing somewhere.
  const columnBound = (level: number, side: "left" | "right") => {
    let v: number | undefined;
    for (const [pid, e] of entries) {
      if (levelOf(pid) !== level) {
        continue;
      }
      const edge =
        side === "left" ? e.x : e.x + widthOf(e.data, e.expanded);
      v =
        v === undefined
          ? edge
          : side === "left"
          ? Math.min(v, edge)
          : Math.max(v, edge);
    }
    return v;
  };
  const colorByDef = new Map<string, RGB>();
  for (const [pid, e] of entries) {
    colorByDef.set(defIdOf(pid), e.data.color);
  }
  return {
    box,
    imageBox: (pid) => {
      const e = entries.get(pid);
      return e && expandable(e.data) && e.expanded
        ? imageBoxAt(e.x, e.y, e.data)
        : null;
    },
    collapsedStart: (pid) => {
      const e = entries.get(pid);
      return e && expandable(e.data) && !e.expanded
        ? { x: e.x + widthOf(e.data, false), y: e.y + COLLAPSED_H / 2 }
        : null;
    },
    nodeId: (pid) => entries.get(pid)?.id,
    columnLeftX: (lvl) => columnBound(lvl, "left"),
    columnRightX: (lvl) => columnBound(lvl, "right"),
    colorForDef: (defId) => colorByDef.get(defId) ?? { r: 0.5, g: 0.5, b: 0.5 },
  };
}

// ---------------------------------------------------------------------------
// Launcher: open the shared UI iframe, then render the graph it posts back.

function openLoader(launcherId: string): Promise<void> {
  return new Promise<void>(() => {
    figma.showUI(__html__, { themeColors: true, width: 340, height: 260 });
    figma.ui.onmessage = async (msg: RenderGraphMessage | { type: string }) => {
      if (msg.type === "render-graph") {
        try {
          await renderGraph(msg as RenderGraphMessage, launcherId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          figma.notify(`CodeGraph: render failed — ${message}`, { error: true });
          figma.ui.postMessage({ type: "error", message });
        }
        return;
      }
      if (msg.type === "cancel") {
        // Ends the widget's run; the pending promise is dropped with it.
        figma.closePlugin();
      }
    };
  });
}

async function renderGraph(msg: RenderGraphMessage, launcherId: string) {
  const launcher = (await figma.getNodeByIdAsync(launcherId)) as WidgetNode | null;
  if (!launcher) {
    throw new Error("the CodeGraph widget was deleted");
  }
  // Widget <Image> takes a URL/data URI, not an image hash, so each tile is
  // carried in its node's synced state as a PNG data URI. (The UI iframe has
  // already re-encoded each tile through canvas — see PluginUI.svelte — so
  // these are the normalized PNGs Figma renders reliably, each ≤4096px.)
  const graph = prepareGraph(
    msg,
    (bytes) => "data:image/png;base64," + figma.base64Encode(bytes)
  );
  const { placements, edges } = graph;
  const graphId =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  // The root is the shallowest placement; it starts expanded, the rest don't.
  let rootLevel = Infinity;
  for (const p of placements) {
    rootLevel = Math.min(rootLevel, p.level);
  }

  const dataByPlacement = new Map<string, NodeData>();
  for (const p of placements) {
    const d = graph.describe(p);
    const data: NodeData = Object.assign({}, d, {
      graphId,
      placementId: p.id,
    });
    dataByPlacement.set(p.id, data);
  }
  const startsExpanded = (pid: string) => levelOf(pid) === rootLevel;

  const layout = layoutGraph(graph, (p) => {
    const data = dataByPlacement.get(p.id) as NodeData;
    return {
      w: widthOf(data, startsExpanded(p.id)),
      h: heightOf(data, startsExpanded(p.id)),
    };
  });

  // Place the graph below the launcher, top-left aligned with it.
  let minX = Infinity;
  let minY = Infinity;
  for (const b of layout.boxes.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
  }
  const dx = launcher.x - (isFinite(minX) ? minX : 0);
  const dy =
    launcher.y + launcher.height + GRAPH_OFFSET_Y - (isFinite(minY) ? minY : 0);

  const entries = new Map<
    string,
    { id: string; x: number; y: number; data: NodeData; expanded: boolean }
  >();
  const created: SceneNode[] = [];
  for (const p of placements) {
    const b = layout.boxes.get(p.id) as Box;
    const data = dataByPlacement.get(p.id) as NodeData;
    const expanded = startsExpanded(p.id);
    const node = launcher.cloneWidget({ role: "node", node: data, expanded });
    node.x = b.x + dx;
    node.y = b.y + dy;
    created.push(node);
    entries.set(p.id, { id: node.id, x: node.x, y: node.y, data, expanded });
  }

  const connectors =
    figma.editorType === "figjam"
      ? drawEdges(edges, geometryFor(entries))
      : edges.map(() => []);
  edges.forEach((edge, i) => {
    saveEdge(graphId, i, {
      edge,
      connectorIds: connectors[i].map((c) => c.id),
    });
    for (const c of connectors[i]) {
      created.push(c);
    }
  });
  figma.root.setPluginData(edgeCountKey(graphId), String(edges.length));

  figma.viewport.scrollAndZoomIntoView(created);
  figma.ui.postMessage({
    type: "done",
    placements: placements.length,
    edges: edges.length,
  });
  figma.notify(`CodeGraph: rendered ${placements.length} boxes`);
}

// ---------------------------------------------------------------------------
// Annotations: anything the user draws on top of a node (pen strokes, shapes,
// stickies, text…) moves with it when its column shifts, and is hidden while
// the node is collapsed. Ownership is geometric and decided at toggle time, so
// nothing has to be registered when it's drawn: a node owns each sibling that
// sits above it in z-order and whose bounding-box center falls on its card.
// What a collapsed node hid is remembered (by id) in its plugin data.

const HIDDEN_ANNOTATIONS_KEY = "hiddenAnnotations";

type Annotation = SceneNode & { x: number; y: number };

function isAnnotation(n: SceneNode): n is Annotation {
  return (
    n.visible &&
    n.type !== "WIDGET" &&
    // Connectors follow what they're attached to (and the graph's own are
    // redrawn); sections are containers, not marks on a node.
    n.type !== "CONNECTOR" &&
    n.type !== "SECTION" &&
    "x" in n
  );
}

function attachedAnnotations(
  nodes: { node: WidgetNode; expanded: boolean }[]
): Map<string, Annotation[]> {
  const out = new Map<string, Annotation[]>();
  const claimed = new Set<string>();
  const siblingsByParent = new Map<BaseNode, readonly SceneNode[]>();
  for (const { node, expanded } of nodes) {
    const parent = node.parent;
    const bb = node.absoluteBoundingBox;
    if (!parent || !("children" in parent) || !bb) {
      continue;
    }
    let siblings = siblingsByParent.get(parent);
    if (!siblings) {
      siblings = parent.children;
      siblingsByParent.set(parent, siblings);
    }
    // Size from the data, not the widget, in case it has already re-rendered.
    const data = node.widgetSyncedState.node as NodeData;
    const right = bb.x + widthOf(data, expanded);
    const bottom = bb.y + heightOf(data, expanded);
    const mine: Annotation[] = [];
    for (let i = siblings.indexOf(node) + 1; i < siblings.length; i++) {
      const a = siblings[i];
      const abb = a.absoluteBoundingBox;
      if (claimed.has(a.id) || !abb || !isAnnotation(a)) {
        continue;
      }
      const cx = abb.x + abb.width / 2;
      const cy = abb.y + abb.height / 2;
      if (cx >= bb.x && cx <= right && cy >= bb.y && cy <= bottom) {
        mine.push(a);
        claimed.add(a.id);
      }
    }
    out.set(node.id, mine);
  }
  return out;
}

// The annotations a collapsed node hid (any the user has since deleted are
// dropped).
async function hiddenAnnotations(node: WidgetNode): Promise<Annotation[]> {
  const raw = node.getPluginData(HIDDEN_ANNOTATIONS_KEY);
  const out: Annotation[] = [];
  for (const id of raw ? (JSON.parse(raw) as string[]) : []) {
    const a = await figma.getNodeByIdAsync(id);
    if (a && !a.removed && "x" in a) {
      out.push(a as Annotation);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Node: expand/collapse + make room in its column.

async function toggleNode(selfId: string, data: NodeData, next: boolean) {
  const self = (await figma.getNodeByIdAsync(selfId)) as WidgetNode | null;
  if (!self) {
    return;
  }
  await figma.currentPage.loadAsync();
  const graphNodes = figma.currentPage
    .findWidgetNodesByWidgetId(figma.widgetId as string)
    .filter((n) => {
      const d = n.widgetSyncedState.node as NodeData | undefined;
      return n.widgetSyncedState.role === "node" && !!d && d.graphId === data.graphId;
    });

  // Grow around the center: the node's top moves up by half the change, its
  // bottom down by half, and every other node in the column shifts the same
  // half-amount away from it, so the gaps between boxes are preserved.
  const delta = data.height - COLLAPSED_H;
  const half = (next ? delta : -delta) / 2;
  const level = levelOf(data.placementId);
  const column = graphNodes.filter(
    (n) => levelOf((n.widgetSyncedState.node as NodeData).placementId) === level
  );
  // Annotations ride along with the node they sit on. Find them all before
  // anything moves, against each node's pre-toggle rect (`!next` for this one —
  // its synced state hasn't re-rendered yet).
  const attached = attachedAnnotations(
    column.map((n) => ({
      node: n,
      expanded: n.id === self.id ? !next : !!n.widgetSyncedState.expanded,
    }))
  );
  // Fetch every await up front: an `await` inside a `for…of` head compiles
  // (via TS's generator downlevel + terser) to `for (x of yield …)`, which
  // Figma's QuickJS rejects with "stack underflow" and the widget won't load.
  const hidden = new Map<string, Annotation[]>();
  for (const n of column) {
    hidden.set(n.id, await hiddenAnnotations(n));
  }
  const selfY = self.y;
  for (const n of column) {
    const dy = n.id === self.id || n.y < selfY ? -half : half;
    n.y += dy;
    const owned = (attached.get(n.id) || []).concat(hidden.get(n.id) || []);
    for (const a of owned) {
      a.y += dy;
    }
  }

  // Collapsing hides what was drawn on the snapshot; expanding brings it back.
  const selfHidden = hidden.get(self.id) || [];
  if (next) {
    for (const a of selfHidden) {
      a.visible = true;
    }
    self.setPluginData(HIDDEN_ANNOTATIONS_KEY, "");
  } else {
    const hide = attached.get(self.id) || [];
    for (const a of hide) {
      a.visible = false;
    }
    const ids = selfHidden.concat(hide).map((a) => a.id);
    self.setPluginData(HIDDEN_ANNOTATIONS_KEY, JSON.stringify(ids));
  }

  if (figma.editorType !== "figjam") {
    return;
  }
  const stored = loadEdges(data.graphId);

  // Redraw every connector that touches this column, plus every forward edge
  // in the corridors on either side of it (lanes are assigned per corridor, so
  // a corridor must be redrawn as a whole).
  // TODO(node-relative-connectors): with node-relative endpoints this shrinks
  // to just the edges incident to the toggled node.
  const affected: number[] = [];
  stored.forEach(({ edge: e }, i) => {
    const from = levelOf(e.from);
    if (from === level - 1 || from === level || levelOf(e.to) === level) {
      affected.push(i);
    }
  });
  for (const i of affected) {
    for (const id of stored[i].connectorIds) {
      const c = await figma.getNodeByIdAsync(id);
      if (c && !c.removed) {
        c.remove();
      }
    }
  }

  // This node's synced state hasn't re-rendered yet, so use `next` for it.
  const entries = new Map<
    string,
    { id: string; x: number; y: number; data: NodeData; expanded: boolean }
  >();
  for (const n of graphNodes) {
    const d = n.widgetSyncedState.node as NodeData;
    entries.set(d.placementId, {
      id: n.id,
      x: n.x,
      y: n.y,
      data: d,
      expanded: n.id === self.id ? next : !!n.widgetSyncedState.expanded,
    });
  }
  const redrawn = drawEdges(
    affected.map((i) => stored[i].edge),
    geometryFor(entries)
  );
  affected.forEach((edgeIndex, j) => {
    saveEdge(data.graphId, edgeIndex, {
      edge: stored[edgeIndex].edge,
      connectorIds: redrawn[j].map((c) => c.id),
    });
  });
}

// ---------------------------------------------------------------------------
// Rendering

function Launcher() {
  const widgetId = useWidgetNodeId();
  return (
    <AutoLayout
      name="CodeGraph"
      direction="vertical"
      spacing={10}
      padding={16}
      cornerRadius={8}
      fill={WHITE}
      stroke="#D0D0D6"
      width={300}
    >
      <Text fontSize={16} fontWeight={700}>
        CodeGraph
      </Text>
      <Text fontSize={12} fill="#555555" width="fill-parent">
        Load a graph made by the CodeGraph extension for VS Code. Click a node's
        header to expand or collapse it.
      </Text>
      <AutoLayout
        padding={{ vertical: 6, horizontal: 12 }}
        cornerRadius={6}
        fill="#18A0FB"
        hoverStyle={{ fill: "#0D8DE3" }}
        onClick={() => openLoader(widgetId)}
      >
        <Text fontSize={12} fontWeight={600} fill={WHITE}>
          Load graph
        </Text>
      </AutoLayout>
    </AutoLayout>
  );
}

function SnapshotNode({
  data,
  expanded,
  onToggle,
  notes,
  setNotes,
}: {
  data: NodeData;
  expanded: boolean;
  onToggle: () => Promise<void>;
  notes: string;
  setNotes: (v: string) => void;
}) {
  const w = widthOf(data, expanded);
  const h = heightOf(data, expanded);
  const tiles = data.tiles || [];
  const notesH = Math.max(1, data.height - HEADER_BAND_H - CARD_PAD);
  const { info } = data;
  const header = expanded
    ? data.headerText === data.name
      ? data.name
      : `${data.name} · ${data.headerText}`
    : info.name;
  const detail = `${info.path ?? "unknown file"} · ${info.instanceCount} ${
    info.instanceCount === 1 ? "instance" : "instances"
  }`;
  return (
    <Frame
      name={data.name}
      width={w}
      height={h}
      cornerRadius={4}
      fill={toColor(data.color)}
    >
      {/* Clickable header band (the whole card width, so it's easy to hit). */}
      <AutoLayout
        x={0}
        y={0}
        width={w}
        height={HEADER_BAND_H}
        padding={{ horizontal: CARD_PAD }}
        spacing={6}
        verticalAlignItems="center"
        hoverStyle={{ opacity: 0.85 }}
        tooltip={expanded ? "Collapse" : "Expand"}
        onClick={onToggle}
      >
        <Text fontSize={12} fill={WHITE} width={12}>
          {expanded ? "▾" : "▸"}
        </Text>
        <Text
          fontSize={11}
          fontWeight={500}
          fill={WHITE}
          width={Math.max(1, headerLabelWidth(w) - 18)}
          truncate={1}
        >
          {header}
        </Text>
        <Text
          fontSize={12}
          fontWeight={500}
          fill={WHITE}
          width={BADGE_W}
          horizontalAlignText="right"
        >
          {data.badge}
        </Text>
      </AutoLayout>
      {expanded ? null : (
        <Text
          x={CARD_PAD}
          y={HEADER_BAND_H - 2}
          fontSize={10}
          fill={WHITE}
          opacity={0.85}
          width={Math.max(1, w - 2 * CARD_PAD)}
          truncate={1}
        >
          {detail}
        </Text>
      )}
      {expanded ? (
        <Frame
          name="Notes"
          x={CARD_PAD}
          y={HEADER_BAND_H}
          width={NOTES_W}
          height={notesH}
          cornerRadius={4}
          fill={PAPER}
        >
          {/* Ruled lines, one per text line, plus a red margin rule. */}
          {Array.from({ length: Math.floor((notesH - 28) / NOTE_LINE_H) + 1 }).map(
            (_, k) => (
              <Rectangle
                key={k}
                x={0}
                y={28 + k * NOTE_LINE_H}
                width={NOTES_W}
                height={1}
                fill={PAPER_RULE}
              />
            )
          )}
          <Rectangle x={26} y={0} width={1} height={notesH} fill={PAPER_MARGIN} />
          <Input
            value={notes}
            placeholder="Notes…"
            onTextEditEnd={(e) => setNotes(e.characters)}
            inputBehavior="multiline"
            fontSize={12}
            lineHeight={NOTE_LINE_H}
            fill="#3A3A3A"
            x={34}
            y={8}
            width={NOTES_W - 34 - 8}
            inputFrameProps={{ fill: "#00000000", padding: 0 }}
          />
        </Frame>
      ) : null}
      {expanded
        ? tiles.map((tile, i) => {
            // One image per tile, laid out by its normalized rect so the tiles
            // abut and together fill the image box at full resolution.
            const img = imageBoxAt(0, 0, data);
            return (
              <Image
                key={i}
                name={`${data.name} (snapshot)`}
                src={tile.ref}
                x={img.x + tile.x * img.w}
                y={img.y + tile.y * img.h}
                width={Math.max(1, tile.width * img.w)}
                height={Math.max(1, tile.height * img.h)}
                cornerRadius={2}
              />
            );
          })
        : null}
    </Frame>
  );
}

// No snapshot (or an undecodable one): a tinted, labelled box, never collapsed.
function LabelNode({ data }: { data: NodeData }) {
  return (
    <AutoLayout
      name={data.name}
      direction="vertical"
      spacing={4}
      padding={12}
      width={data.width}
      height={data.height}
      cornerRadius={4}
      fill={toColor(data.bg)}
      stroke={toColor(data.stroke)}
      strokeWidth={data.failure ? 2 : 1}
    >
      <Text
        fontSize={15}
        fontWeight={500}
        fill={data.failure ? toColor(FAILURE_TITLE_COLOR) : "#000000"}
        width="fill-parent"
      >
        {data.title}
      </Text>
      <Text fontSize={12} fontWeight={500} width="fill-parent">
        {data.name}
      </Text>
    </AutoLayout>
  );
}

function CodeGraphWidget() {
  const widgetId = useWidgetNodeId();
  const [role] = useSyncedState<"launcher" | "node">("role", "launcher");
  const [node] = useSyncedState<NodeData | null>("node", null);
  const [expanded, setExpanded] = useSyncedState<boolean>("expanded", false);
  const [notes, setNotes] = useSyncedState<string>("notes", "");

  const canToggle = role === "node" && !!node && expandable(node);
  const onToggle = async () => {
    if (!node) {
      return;
    }
    const next = !expanded;
    setExpanded(next);
    await toggleNode(widgetId, node, next);
  };

  // Toolbar action shown when the node is selected — a touch/pencil-friendly
  // alternative to tapping the header (taps on widget onClick can be unreliable
  // on iPad). Must be called unconditionally (hook), so it's empty otherwise.
  usePropertyMenu(
    canToggle
      ? [
          {
            itemType: "action",
            propertyName: "toggle",
            tooltip: expanded ? "Collapse" : "Expand",
          },
        ]
      : [],
    () => onToggle()
  );

  if (role !== "node" || !node) {
    return <Launcher />;
  }
  if (!expandable(node)) {
    return <LabelNode data={node} />;
  }
  return (
    <SnapshotNode
      data={node}
      expanded={expanded}
      onToggle={onToggle}
      notes={notes}
      setNotes={setNotes}
    />
  );
}

widget.register(CodeGraphWidget);
