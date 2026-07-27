// Client-side mirror of the backend's graph.json shape (see `GraphManifest` in
// the extension's src/types/index.ts). Kept as plain JSON types — the manifest
// the plugin fetches carries no VS Code objects. Keep in sync with the backend.

export type ManifestNodeKind =
  | "function"
  | "parseFail"
  | "positionFail"
  | "findDefinitionFail"
  | "notAFunction";

export interface ManifestImage {
  file: string;
  width: number;
  height: number;
  scale: number;
}

export interface ManifestDefinition {
  id: string;
  name: string;
  kind: ManifestNodeKind;
  image: ManifestImage | null;
  source: { uri: string; range: unknown } | null;
  // Workspace-relative path of the source file, shown above the snapshot.
  path: string | null;
}

export interface ManifestPlacement {
  id: string; // `${definitionId}@${level}`
  definitionId: string;
  level: number;
}

// A rectangle normalized to [0..1] relative to a definition's snapshot image.
export interface ManifestRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ManifestEdge {
  from: string; // placement id (caller)
  to: string; // placement id (definition)
  // Normalized box of the call token within the caller's image. When present,
  // anchor the connector at the call site instead of the box edge.
  callSiteRect?: ManifestRect;
  recursion?: true;
}

export interface GraphManifest {
  version: 1;
  entryDefinitionId: string;
  source: { name: string; uri: string };
  definitions: ManifestDefinition[];
  placements: ManifestPlacement[];
  edges: ManifestEdge[];
}

// One tile of a snapshot image. A tall/wide snapshot is sliced into a grid of
// tiles each ≤ Figma's 4096px createImage limit, so it renders at full capture
// resolution instead of being downscaled to fit one image. `x/y/width/height`
// are the tile's normalized [0..1] position/size within the full snapshot, so
// the sandbox can lay the tiles back out to exactly fill the image box.
export interface ImageTile {
  bytes: Uint8Array;
  x: number;
  y: number;
  width: number;
  height: number;
}

// What the UI iframe posts to the plugin sandbox: the manifest plus each
// definition's snapshot, sliced into tiles (fetched + sliced in the iframe,
// where `fetch` and canvas live).
export interface RenderGraphMessage {
  type: "render-graph";
  manifest: GraphManifest;
  // tiles is null when the UI couldn't decode/slice the PNG at all — the sandbox
  // then draws a labeled "image too large" box. Otherwise it's ≥1 tile that
  // together tile the definition's image box at full capture resolution.
  images: { definitionId: string; tiles: ImageTile[] | null }[];
  // When true, the sandbox omits failure-kind definitions (findDefinitionFail /
  // parseFail / positionFail / notAFunction) and any connectors touching them.
  hideFailures?: boolean;
}
