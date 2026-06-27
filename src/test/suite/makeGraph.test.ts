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

  // Regression: a class-method entry (MethodDeclaration) used to fall through
  // the parser's function-kind search and get replaced by the first nested
  // ArrowFunction in the body, so only that callback's calls were scanned. The
  // method-level calls (`first`, `second`) were silently dropped — only
  // `double` (inside the arrow) survived. Verify all three are captured now.
  test("scans all calls in a class-method entry, not just a nested arrow's", async function () {
    this.timeout(180000);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-method-"));
    const outDir = path.join(tmpRoot, "out");
    const fixturePath = path.join(tmpRoot, "service.ts");

    // The arrow `(x) => double(x)` is the first function-like descendant of the
    // method body, so the pre-fix parser would have picked it and seen only
    // `double`. `first()` and `second()` are method-level calls that the fix
    // must now reach.
    const source = [
      "class Service {",
      "  run() {",
      "    const cb = (x: number) => double(x);",
      "    const a = first();",
      "    return second(a, cb);",
      "  }",
      "}",
      "",
      "function double(x: number) {",
      "  return x * 2;",
      "}",
      "",
      "function first() {",
      "  return 1;",
      "}",
      "",
      "function second(a: number, cb: (x: number) => number) {",
      "  return a;",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(fixturePath, source, "utf8");

    await vscode.workspace
      .getConfiguration("codegraph")
      .update("outputDirectory", outDir, vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument(fixturePath);
    const editor = await vscode.window.showTextDocument(doc);

    // Cursor on the `run` method name (line 1): "  run() {".
    const entryPosition = new vscode.Position(1, 3);
    await waitForDefinition(doc.uri, entryPosition, 90000);
    editor.selection = new vscode.Selection(entryPosition, entryPosition);

    await vscode.commands.executeCommand("codegraph.makeGraph");

    const manifestPath = findGraphJson(outDir);
    assert.ok(manifestPath, `graph.json not found under ${outDir}`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const defNames = new Set(
      manifest.definitions.map((d: { name: string }) => d.name)
    );

    for (const name of ["double", "first", "second"]) {
      assert.ok(
        defNames.has(name),
        `expected '${name}' among definitions, got [${[...defNames].join(
          ", "
        )}]`
      );
    }

    // The entry method makes three resolvable calls, so its placement should
    // emit three forward edges (all anchored at their call sites).
    const entryPlacement = `${manifest.entryDefinitionId}@0`;
    const forwardFromEntry = manifest.edges.filter(
      (e: { from: string; recursion?: boolean }) =>
        e.from === entryPlacement && !e.recursion
    );
    assert.strictEqual(
      forwardFromEntry.length,
      3,
      `expected 3 forward edges from the method entry, got ${forwardFromEntry.length}`
    );
  });

  // Calls whose receiver is a bare-module (node_modules) import or a JS builtin
  // are skipped before the definition lookup — no FindDefinitionFail node, no
  // connector. Genuine unresolved calls still become fail nodes, but labelled
  // with the call text instead of the anonymous "Find Definition Fail".
  test("skips external calls (bare import / builtin) and labels genuine fails", async function () {
    this.timeout(180000);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-ext-"));
    const outDir = path.join(tmpRoot, "out");
    const fixturePath = path.join(tmpRoot, "calls.ts");

    const source = [
      'import ext from "some-external-pkg";', // bare → node_modules
      "",
      "export function entry(x: any) {",
      "  helper();", // local → resolves
      "  ext.run();", // bare-import receiver → skipped, no fail
      "  JSON.stringify(x);", // builtin → skipped, no fail
      "  x.doThing();", // method on `any` → genuine fail, labelled "doThing"
      "}",
      "",
      "function helper() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(fixturePath, source, "utf8");

    await vscode.workspace
      .getConfiguration("codegraph")
      .update("outputDirectory", outDir, vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument(fixturePath);
    const editor = await vscode.window.showTextDocument(doc);

    // Cursor on `entry` (line 2): "export function entry".
    const entryPosition = new vscode.Position(2, 16);
    await waitForDefinition(doc.uri, entryPosition, 90000);
    editor.selection = new vscode.Selection(entryPosition, entryPosition);

    await vscode.commands.executeCommand("codegraph.makeGraph");

    const manifestPath = findGraphJson(outDir);
    assert.ok(manifestPath, `graph.json not found under ${outDir}`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const defNames = manifest.definitions.map((d: { name: string }) => d.name);

    // `helper` resolved.
    assert.ok(defNames.includes("helper"), `helper missing: [${defNames}]`);

    // `ext.run` and `JSON.stringify` were skipped — they produce no node at all.
    assert.ok(!defNames.includes("run"), "ext.run should be skipped");
    assert.ok(!defNames.includes("stringify"), "JSON.stringify should be skipped");

    // Exactly one genuine fail, labelled with the call text (not the generic
    // placeholder).
    const fails = manifest.definitions.filter(
      (d: { kind: string }) => d.kind === "findDefinitionFail"
    );
    assert.strictEqual(
      fails.length,
      1,
      `expected exactly one fail node, got ${fails.length}: [${fails
        .map((f: { name: string }) => f.name)
        .join(", ")}]`
    );
    assert.strictEqual(fails[0].name, "doThing", "fail node should be labelled");
  });

  // A call whose definition is a value backed by a node_modules callee (e.g.
  // `const db = knex(config)` — the SneakerBot db case) is skipped: no node, no
  // connector, and crucially NOT a "Parse Fail". A value backed by *user* code
  // is not skipped.
  test("skips a value backed by a node_modules callee, but not a user-code value", async function () {
    this.timeout(180000);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-val-"));
    const outDir = path.join(tmpRoot, "out");
    const fixturePath = path.join(tmpRoot, "models.ts");

    const source = [
      'import knex from "knex";', // bare → node_modules
      "",
      "const db = knex({});", // value backed by a node_modules callee
      "function localFactory() {", // user code
      "  return { run() {} };",
      "}",
      "const helperObj = localFactory();", // value backed by user code
      "",
      "export function entry() {",
      '  db("table");', // → resolves to `const db = knex({})` → SKIP
      "  helperObj.run();", // → user-code value → not skipped
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(fixturePath, source, "utf8");

    await vscode.workspace
      .getConfiguration("codegraph")
      .update("outputDirectory", outDir, vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument(fixturePath);
    const editor = await vscode.window.showTextDocument(doc);

    // Cursor on `entry` (line 8): "export function entry".
    const entryPosition = new vscode.Position(8, 16);
    await waitForDefinition(doc.uri, entryPosition, 90000);
    editor.selection = new vscode.Selection(entryPosition, entryPosition);

    await vscode.commands.executeCommand("codegraph.makeGraph");

    const manifestPath = findGraphJson(outDir);
    assert.ok(manifestPath, `graph.json not found under ${outDir}`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    // The knex-backed `db("table")` call must NOT leave a parseFail/notAFunction
    // node — it's skipped entirely.
    const parseFails = manifest.definitions.filter(
      (d: { kind: string }) => d.kind === "parseFail"
    );
    assert.strictEqual(
      parseFails.length,
      0,
      `expected no parseFail nodes, got ${parseFails.length}`
    );

    // The entry calls two things; only the user-code value survives as an edge,
    // so the knex-backed call produced strictly fewer forward edges than calls.
    const entryPlacement = `${manifest.entryDefinitionId}@0`;
    const forwardFromEntry = manifest.edges.filter(
      (e: { from: string; recursion?: boolean }) =>
        e.from === entryPlacement && !e.recursion
    );
    assert.ok(
      forwardFromEntry.length <= 1,
      `knex-backed call should be skipped, leaving ≤1 edge, got ${forwardFromEntry.length}`
    );
  });
});
