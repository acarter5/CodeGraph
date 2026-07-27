import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import PathFilter, { resolvePathsAlias } from "../../utils/pathFilter";
import { getCompilerOptions } from "../../utils/moduleResolution";

/*
  Coverage for the include/exclude path scoping (codegraph.includePaths /
  excludePaths). Matching runs on a resolved definition's real file path, so the
  fixture mirrors a small project with a tsconfig declaring `paths` aliases —
  the same shape the module-resolution tests use — and asserts which files a
  filter keeps or drops.
*/
suite("path filter: include/exclude scoping", () => {
  let root: string;

  const coreFile = () => path.join(root, "src", "core", "engine.ts");
  const utilsFile = () => path.join(root, "src", "utils", "format.ts");
  const servicesFile = () => path.join(root, "src", "services", "greeter.ts");
  const legacyFile = () => path.join(root, "src", "legacy", "old.ts");

  suiteSetup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-pathfilter-"));

    for (const dir of ["core", "utils", "services", "legacy"]) {
      fs.mkdirSync(path.join(root, "src", dir), { recursive: true });
    }

    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2020",
          module: "commonjs",
          baseUrl: ".",
          paths: { "@/*": ["src/*"], "@shared/*": ["src/utils/*"] },
        },
        include: ["src"],
      })
    );

    fs.writeFileSync(coreFile(), "export function engine() { return 1; }");
    fs.writeFileSync(utilsFile(), "export function format(s: string) { return s; }");
    fs.writeFileSync(servicesFile(), "export function greet(s: string) { return s; }");
    fs.writeFileSync(legacyFile(), "export function old() { return 0; }");
  });

  suiteTeardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const make = (include: string[], exclude: string[]) =>
    new PathFilter({ include, exclude, workspaceRoot: root });

  test("an empty filter grafts everything (inactive)", () => {
    const filter = make([], []);
    assert.strictEqual(filter.isActive, false);
    assert.strictEqual(filter.shouldGraphDefinition(coreFile()), true);
    assert.strictEqual(filter.shouldGraphDefinition(legacyFile()), true);
  });

  test("excludes a workspace-relative directory", () => {
    const filter = make([], ["src/legacy"]);
    assert.strictEqual(filter.shouldGraphDefinition(legacyFile()), false);
    assert.strictEqual(filter.shouldGraphDefinition(coreFile()), true);
  });

  test("include list restricts to the listed directory", () => {
    const filter = make(["src/core"], []);
    assert.strictEqual(filter.shouldGraphDefinition(coreFile()), true);
    assert.strictEqual(filter.shouldGraphDefinition(utilsFile()), false);
    assert.strictEqual(filter.shouldGraphDefinition(servicesFile()), false);
  });

  test("excludes via a bare tsconfig alias (@shared -> src/utils)", () => {
    const filter = make([], ["@shared"]);
    assert.strictEqual(filter.shouldGraphDefinition(utilsFile()), false);
    assert.strictEqual(filter.shouldGraphDefinition(coreFile()), true);
  });

  test("excludes via a wildcard alias form (@shared/*)", () => {
    const filter = make([], ["@shared/*"]);
    assert.strictEqual(filter.shouldGraphDefinition(utilsFile()), false);
  });

  test("includes via an alias subpath (@/services -> src/services)", () => {
    const filter = make(["@/services"], []);
    assert.strictEqual(filter.shouldGraphDefinition(servicesFile()), true);
    assert.strictEqual(filter.shouldGraphDefinition(utilsFile()), false);
    assert.strictEqual(filter.shouldGraphDefinition(coreFile()), false);
  });

  test("exclude takes precedence over include", () => {
    // Include all of src, but carve out utils via its alias.
    const filter = make(["src"], ["@shared"]);
    assert.strictEqual(filter.shouldGraphDefinition(coreFile()), true);
    assert.strictEqual(filter.shouldGraphDefinition(utilsFile()), false);
  });

  test("supports absolute-path entries", () => {
    const filter = make([], [path.join(root, "src", "legacy")]);
    assert.strictEqual(filter.shouldGraphDefinition(legacyFile()), false);
    assert.strictEqual(filter.shouldGraphDefinition(coreFile()), true);
  });

  test("a non-matching / typo entry drops nothing on its own", () => {
    // Exclude a directory that doesn't exist and isn't an alias — resolves to
    // no prefix, so it excludes nothing.
    const filter = make([], ["src/does-not-exist"]);
    assert.strictEqual(filter.shouldGraphDefinition(coreFile()), true);
  });

  suite("resolvePathsAlias", () => {
    const optionsFor = () => getCompilerOptions(coreFile());

    test("maps a bare alias to its target directory", () => {
      const prefixes = resolvePathsAlias("@shared", optionsFor(), root);
      assert.deepStrictEqual(prefixes, [path.join(root, "src", "utils")]);
    });

    test("maps an alias subpath through the wildcard", () => {
      const prefixes = resolvePathsAlias("@/services", optionsFor(), root);
      assert.deepStrictEqual(prefixes, [path.join(root, "src", "services")]);
    });

    test("strips a trailing wildcard from the entry", () => {
      const prefixes = resolvePathsAlias("@shared/*", optionsFor(), root);
      assert.deepStrictEqual(prefixes, [path.join(root, "src", "utils")]);
    });

    test("returns nothing for a non-alias entry", () => {
      assert.deepStrictEqual(resolvePathsAlias("nope", optionsFor(), root), []);
    });
  });
});
