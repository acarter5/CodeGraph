// Serves a recorded graph fixture (graph.json + PNGs) on localhost so the
// widget/plugin can be tested without running the extension. Mirrors the
// extension's CodeGraphServer: loopback only, permissive CORS (the Figma UI
// iframe has a null origin).
//
//   npm run serve-fixture [-- <fixture-name>] [--port 3939]
//
// The port must match networkAccess.allowedDomains in the Figma manifests.
const http = require("http");
const fs = require("fs");
const path = require("path");

const FIXTURES = path.resolve(__dirname, "../test/fixtures");
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args.splice(portIdx, 2)[1]) : 3939;
const name = args[0] || "zod-createToJSONSchemaMethod";
const root = path.join(FIXTURES, name);

if (!fs.existsSync(path.join(root, "graph.json"))) {
  console.error(`No graph.json in ${root}`);
  console.error(`Available: ${fs.readdirSync(FIXTURES).join(", ")}`);
  process.exit(1);
}

const TYPES = { ".json": "application/json; charset=utf-8", ".png": "image/png" };

http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    let rel;
    try {
      rel = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname.replace(
          /%(?![0-9a-fA-F]{2})/g,
          "%25"
        )
      );
    } catch (e) {
      res.writeHead(400);
      return res.end("bad request");
    }
    // Fixture files live at the root, but accept the extension's URL shape too
    // (/<graphDir>/graph.json) by serving by basename.
    const file = path.join(root, path.basename(rel));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.setHeader(
      "Content-Type",
      TYPES[path.extname(file).toLowerCase()] || "application/octet-stream"
    );
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`Serving ${name} — paste into the widget:`);
    console.log(`  http://localhost:${port}/graph.json`);
  });
