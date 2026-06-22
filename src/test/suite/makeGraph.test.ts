import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import CodeGraphServer from "../../server/index";

// Drives the real `codegraph.makeGraph` command end-to-end against a tiny TS
// fixture, verifies the emitted graph.json references PNGs by filename, and
// confirms the local server actually serves the manifest + an image (the FigJam
// plugin transport).
suite("makeGraph integration", () => {
  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Minimal GET helper — fetch may not exist on the harness's Node runtime.
  function httpGet(
    url: string
  ): Promise<{ status: number; contentType?: string; bytes: Buffer }> {
    return new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: res.headers["content-type"],
              bytes: Buffer.concat(chunks),
            })
          );
        })
        .on("error", reject);
    });
  }

  // The TS definition provider needs the language server to spin up and analyze
  // the file before it returns anything; poll until it does (or give up).
  async function waitForDefinition(
    uri: vscode.Uri,
    position: vscode.Position,
    timeoutMs: number
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const defs = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >("vscode.executeDefinitionProvider", uri, position);
      if (Array.isArray(defs) && defs.length > 0) {
        return;
      }
      await delay(500);
    }
    throw new Error("definition provider never resolved the entry function");
  }

  function findGraphJson(dir: string): string | null {
    if (!fs.existsSync(dir)) {
      return null;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findGraphJson(full);
        if (found) {
          return found;
        }
      } else if (entry.name === "graph.json") {
        return full;
      }
    }
    return null;
  }

  test("writes graph.json and serves it + images over the local server", async function () {
    this.timeout(180000);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-test-"));
    const outDir = path.join(tmpRoot, "out");
    const fixturePath = path.join(tmpRoot, "sample.ts");

    const source = [
      "export function entry() {",
      "  return helper(1);",
      "}",
      "",
      "function helper(n: number) {",
      "  return n + 1;",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(fixturePath, source, "utf8");

    await vscode.workspace
      .getConfiguration("codegraph")
      .update("outputDirectory", outDir, vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument(fixturePath);
    const editor = await vscode.window.showTextDocument(doc);

    // Cursor on the `entry` identifier (line 0): "export function entry".
    const entryPosition = new vscode.Position(0, 16);
    await waitForDefinition(doc.uri, entryPosition, 90000);
    editor.selection = new vscode.Selection(entryPosition, entryPosition);

    await vscode.commands.executeCommand("codegraph.makeGraph");

    const manifestPath = findGraphJson(outDir);
    assert.ok(manifestPath, `graph.json not found under ${outDir}`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.strictEqual(manifest.version, 1, "manifest version");
    assert.ok(
      manifest.definitions.length >= 2,
      `expected >= 2 definitions, got ${manifest.definitions.length}`
    );

    // Images are referenced by filename (no base64 inlined into the manifest).
    const withImages = manifest.definitions.filter(
      (d: { image: { file?: unknown; data?: unknown } | null }) =>
        d.image && typeof d.image.file === "string"
    );
    assert.ok(
      withImages.length >= 1,
      "no definition recorded an image file"
    );
    for (const d of withImages) {
      assert.ok(!("data" in d.image), "manifest should not inline base64 data");
      assert.match(d.image.file, /\.png$/);
      const onDisk = path.join(path.dirname(manifestPath), d.image.file);
      assert.ok(fs.existsSync(onDisk), `image not on disk: ${d.image.file}`);
    }

    // The fixture's `entry` calls `helper` once, so there should be exactly one
    // forward edge, anchored at the measured call site (normalized [0..1]).
    const anchored = manifest.edges.filter(
      (e: { callSiteRect?: unknown }) => e.callSiteRect
    );
    assert.ok(
      anchored.length >= 1,
      "expected at least one edge with a measured callSiteRect"
    );
    for (const e of anchored) {
      const r = e.callSiteRect;
      for (const k of ["x", "y", "width", "height"]) {
        assert.ok(
          typeof r[k] === "number" && r[k] >= 0 && r[k] <= 1,
          `callSiteRect.${k} out of [0,1]: ${r[k]}`
        );
      }
      assert.ok(r.width > 0 && r.height > 0, "callSiteRect has zero area");
    }

    // The plugin can't read disk — verify the local server actually serves the
    // manifest and a snapshot PNG over http with sane content types.
    const graphDir = path.basename(path.dirname(manifestPath));
    const sampleImage = withImages[0].image.file as string;
    const server = new CodeGraphServer(outDir, 0); // port 0 → ephemeral
    try {
      const baseUrl = await server.start();

      const manifestRes = await httpGet(
        `${baseUrl}/${encodeURIComponent(graphDir)}/graph.json`
      );
      assert.strictEqual(manifestRes.status, 200, "manifest http status");
      assert.match(manifestRes.contentType ?? "", /application\/json/);
      assert.strictEqual(
        JSON.parse(manifestRes.bytes.toString("utf8")).version,
        1
      );

      const imageRes = await httpGet(
        `${baseUrl}/${encodeURIComponent(graphDir)}/${encodeURIComponent(
          sampleImage
        )}`
      );
      assert.strictEqual(imageRes.status, 200, "image http status");
      assert.strictEqual(imageRes.contentType, "image/png");
      // PNG magic number.
      assert.deepStrictEqual(
        [...imageRes.bytes.subarray(0, 4)],
        [0x89, 0x50, 0x4e, 0x47]
      );

      // Path traversal must be rejected.
      const escape = await httpGet(`${baseUrl}/../../etc/hosts`);
      assert.ok(
        escape.status === 403 || escape.status === 404,
        `traversal not blocked (status ${escape.status})`
      );
    } finally {
      server.dispose();
    }

    // eslint-disable-next-line no-console
    console.log(
      `[makeGraph.test] ${manifest.definitions.length} definitions, ` +
        `${withImages.length} images, served from ${outDir}`
    );
  });
});
