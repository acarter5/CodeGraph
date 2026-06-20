export const placeholders = [
  { key: "__CSS_BASE_PATH__", value: "app.css" },
  { key: "__JS_BASE_PATH__", value: "app.js" },
  {
    key: "__LIB_BASE_PATH__",
    value: "../node_modules/dom-to-image-more/dist/dom-to-image-more.min.js",
  },
  // Prism is the new (client-side) syntax highlighter; it replaces the old
  // pipeline that depended on the system clipboard + vscode's copy command,
  // which was unreliable once the webview was visible (BUGS.md #20).
  {
    key: "__PRISM_JS_PATH__",
    value: "../node_modules/prismjs/prism.js",
  },
  {
    key: "__PRISM_TS_PATH__",
    value: "../node_modules/prismjs/components/prism-typescript.min.js",
  },
  {
    key: "__PRISM_JSX_PATH__",
    value: "../node_modules/prismjs/components/prism-jsx.min.js",
  },
  {
    key: "__PRISM_TSX_PATH__",
    value: "../node_modules/prismjs/components/prism-tsx.min.js",
  },
  {
    key: "__PRISM_CSS_PATH__",
    value: "../node_modules/prismjs/themes/prism-tomorrow.min.css",
  },
  { key: "__IMAGE__", value: "" },
];

export enum MESSAGES {
  snapshotTaken = "snapshotTaken",
}