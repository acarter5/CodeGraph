import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import CodeGraphServer from "../../server/index";

// CodeGraphServer serves graph dirs whose names embed a literal "%" (View turns
// the file extension's "." into "%", e.g. "cluster%js"). The plugin's browser
// fetch can send that "%" unencoded, which used to throw `URIError: URI
// malformed` in the server's decode and break the request. These tests pin the
// transport down for the awkward characters in real graph dir names.
suite("CodeGraphServer path handling", () => {
  // Issue a GET with an exact request-target string so we can send a bare "%"
  // (a real fetch/browser does this for an unencoded "%") — http.get would
  // re-parse and mangle it.
  function rawGet(
    port: number,
    requestPath: string
  ): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      http
        .request(
          { host: "127.0.0.1", port, method: "GET", path: requestPath },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          }
        )
        .on("error", reject)
        .end();
    });
  }

  test("serves a graph dir whose name contains '%' and spaces, however the '%' is encoded", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-srv-"));
    // Mirrors the real layout: "<name> <a-b-file%ext> <hash>".
    const graphDir = "build SneakerBot-helpers-cluster%js deadbeef";
    fs.mkdirSync(path.join(root, graphDir));
    fs.writeFileSync(
      path.join(root, graphDir, "graph.json"),
      JSON.stringify({ version: 1 }),
      "utf8"
    );

    const server = new CodeGraphServer(root, 0);
    try {
      const baseUrl = await server.start();
      const port = Number(new URL(baseUrl).port);

      // 1) Properly encoded ("%" -> "%25", " " -> "%20"): the URL the extension
      //    copies to the clipboard.
      const encoded = `/${encodeURIComponent(graphDir)}/graph.json`;
      assert.strictEqual((await rawGet(port, encoded)).status, 200, "encoded");

      // 2) Bare, unencoded "%" with "%20" spaces — what a browser fetch sends
      //    for an unescaped "%". Previously crashed the handler (URIError).
      const bare = `/${graphDir.replace(/ /g, "%20")}/graph.json`;
      assert.strictEqual((await rawGet(port, bare)).status, 200, "bare %");

      // 3) A genuinely missing file is still a clean 404 (not a crash).
      assert.strictEqual(
        (await rawGet(port, "/does-not-exist/graph.json")).status,
        404,
        "missing -> 404"
      );

      // 4) Path traversal is still rejected.
      const escape = (await rawGet(port, "/../../etc/hosts")).status;
      assert.ok(escape === 403 || escape === 404, `traversal (${escape})`);
    } finally {
      server.dispose();
    }
  });
});
