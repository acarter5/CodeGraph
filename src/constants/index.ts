export const placeholders = [
  { key: "__CSS_BASE_PATH__", value: "app.css" },
  { key: "__JS_BASE_PATH__", value: "app.js" },
  // Webview asset paths resolve against `<extensionPath>/resources/` (see
  // `View._generateInternalUri`). They point at `../dist/vendor/...` rather than
  // `../node_modules/...` because copy-webpack-plugin mirrors these files into
  // dist/ at build time — dist/ ships in the .vsix, node_modules/ does not
  // (BUGS.md #21). dom-to-image + Prism (client-side highlighter, replaced the
  // clipboard pipeline — BUGS.md #20).
  {
    key: "__LIB_BASE_PATH__",
    value: "../dist/vendor/dom-to-image-more/dom-to-image-more.min.js",
  },
  {
    key: "__PRISM_JS_PATH__",
    value: "../dist/vendor/prismjs/prism.js",
  },
  {
    key: "__PRISM_TS_PATH__",
    value: "../dist/vendor/prismjs/components/prism-typescript.min.js",
  },
  {
    key: "__PRISM_JSX_PATH__",
    value: "../dist/vendor/prismjs/components/prism-jsx.min.js",
  },
  {
    key: "__PRISM_TSX_PATH__",
    value: "../dist/vendor/prismjs/components/prism-tsx.min.js",
  },
  {
    key: "__PRISM_CSS_PATH__",
    value: "../dist/vendor/prismjs/themes/prism-tomorrow.min.css",
  },
  { key: "__IMAGE__", value: "" },
];

export enum MESSAGES {
  snapshotTaken = "snapshotTaken",
}