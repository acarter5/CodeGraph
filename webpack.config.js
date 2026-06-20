//@ts-check

'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: "node", // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
  mode: "none", // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: "./src/extension.ts", // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  externals: {
    vscode: "commonjs vscode", // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    alias: {
      src: path.resolve(__dirname, "src"),
      types: path.resolve(__dirname, "src/types"),
    },
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
    ],
  },
  plugins: [
    // The snapshot webview loads Prism + dom-to-image via plain <script>/<link>
    // URLs (not imports), so webpack never bundles them. `.vscodeignore`
    // excludes node_modules/** from the .vsix, so referencing them there 404s
    // once installed (BUGS.md #21). Mirror just the files the webview needs into
    // dist/vendor/ — which ships — and point the placeholders there instead.
    new CopyPlugin({
      // Only the files the webview actually loads (see src/constants/index.ts) —
      // not the whole prismjs package, which would ship ~600 unused language
      // grammars. Adding a language (e.g. Python for M3) means adding its
      // component file here and a placeholder in constants.
      patterns: [
        {
          from: "node_modules/prismjs/prism.js",
          to: "vendor/prismjs/prism.js",
        },
        {
          from: "node_modules/prismjs/components/prism-typescript.min.js",
          to: "vendor/prismjs/components/prism-typescript.min.js",
        },
        {
          from: "node_modules/prismjs/components/prism-jsx.min.js",
          to: "vendor/prismjs/components/prism-jsx.min.js",
        },
        {
          from: "node_modules/prismjs/components/prism-tsx.min.js",
          to: "vendor/prismjs/components/prism-tsx.min.js",
        },
        {
          from: "node_modules/prismjs/themes/prism-tomorrow.min.css",
          to: "vendor/prismjs/themes/prism-tomorrow.min.css",
        },
        {
          from: "node_modules/dom-to-image-more/dist/dom-to-image-more.min.js",
          to: "vendor/dom-to-image-more/dom-to-image-more.min.js",
        },
      ],
    }),
  ],
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
};
module.exports = [ extensionConfig ];