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

// What the UI iframe posts to the plugin sandbox: the manifest plus each
// definition's PNG bytes (fetched in the iframe, where `fetch` lives).
export interface RenderGraphMessage {
  type: "render-graph";
  manifest: GraphManifest;
  // bytes is null when the UI couldn't downscale the PNG to within Figma's
  // image-size limit — the sandbox then draws a labeled "image too large" box.
  images: { definitionId: string; bytes: Uint8Array | null }[];
  // When true, the sandbox omits failure-kind definitions (findDefinitionFail /
  // parseFail / positionFail / notAFunction) and any connectors touching them.
  hideFailures?: boolean;
}
