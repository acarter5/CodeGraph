import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  findTsConfig,
  isExternalModuleSpecifier,
} from "../../utils/moduleResolution";

/*
  Regression coverage for the "graph terminates early" bug: a first-party import
  written as a bare specifier — a tsconfig `paths` alias, a `baseUrl`-rooted
  path, or a workspace package — used to be classified as node_modules purely
  from the specifier's shape. The Builder then skipped the definition lookup
  entirely, so the call produced no node, no fail node and no connector, and the
  recursion stopped at every alias boundary.
*/
suite("module resolution: internal vs node_modules", () => {
  let root: string;

  suiteSetup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-modres-"));

    fs.mkdirSync(path.join(root, "src", "utils"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "services"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "left-pad"), {
      recursive: true,
    });

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

    fs.writeFileSync(
      path.join(root, "src", "entry.ts"),
      "export function entry() { return 1; }"
    );
    fs.writeFileSync(
      path.join(root, "src", "utils", "format.ts"),
      "export function decorate(s: string) { return s; }"
    );
    fs.writeFileSync(
      path.join(root, "src", "services", "greeter.ts"),
      "export function greetVia(s: string) { return s; }"
    );

    // A real (if tiny) node_modules package, so the external case resolves for
    // the same reason it would in a user's project rather than by falling back.
    fs.writeFileSync(
      path.join(root, "node_modules", "left-pad", "package.json"),
      JSON.stringify({ name: "left-pad", version: "1.0.0", main: "index.js" })
    );
    fs.writeFileSync(
      path.join(root, "node_modules", "left-pad", "index.js"),
      "module.exports = function leftPad() {};"
    );
    fs.writeFileSync(
      path.join(root, "node_modules", "left-pad", "index.d.ts"),
      "export default function leftPad(): void;"
    );
  });

  suiteTeardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const classify = (specifier: string) =>
    isExternalModuleSpecifier(specifier, path.join(root, "src", "entry.ts"));

  test("treats tsconfig `paths` aliases as first-party, not node_modules", () => {
    assert.strictEqual(classify("@/services/greeter"), false);
    assert.strictEqual(classify("@shared/format"), false);
  });

  test("treats baseUrl-rooted specifiers as first-party", () => {
    assert.strictEqual(classify("src/utils/format"), false);
  });

  test("still treats real node_modules imports as external", () => {
    assert.strictEqual(classify("left-pad"), true);
  });

  test("still treats relative imports as first-party", () => {
    assert.strictEqual(classify("./utils/format"), false);
  });

  test("falls back to the shape heuristic for unresolvable specifiers", () => {
    // Nothing on disk to resolve to: a bare specifier is assumed external (so
    // it isn't turned into a noisy definition lookup), a relative one internal.
    assert.strictEqual(classify("does-not-exist-anywhere"), true);
    assert.strictEqual(classify("./does-not-exist-anywhere"), false);
  });

  suite("tsconfig lookup boundary", () => {
    test("finds a tsconfig several levels above the file", () => {
      assert.strictEqual(
        findTsConfig(path.join(root, "src", "services")),
        path.join(root, "tsconfig.json")
      );
    });

    test("stops at the workspace root instead of escaping upward", () => {
      // A nested project with no tsconfig of its own. Unbounded, the walk would
      // climb out and adopt the outer tsconfig; bounded at `nested`, it must not.
      const nested = path.join(root, "nested-project");
      fs.mkdirSync(path.join(nested, "src"), { recursive: true });

      assert.strictEqual(
        findTsConfig(path.join(nested, "src")),
        path.join(root, "tsconfig.json"),
        "unbounded walk should reach the outer tsconfig"
      );
      assert.strictEqual(
        findTsConfig(path.join(nested, "src"), nested),
        null,
        "walk bounded at the workspace root must not adopt a foreign tsconfig"
      );
    });

    test("checks the stop dir itself (inclusive bound)", () => {
      assert.strictEqual(
        findTsConfig(path.join(root, "src", "utils"), root),
        path.join(root, "tsconfig.json")
      );
    });

    test("ignores a stop dir that isn't an ancestor of the start dir", () => {
      assert.strictEqual(
        findTsConfig(path.join(root, "src"), path.join(os.tmpdir(), "unrelated")),
        path.join(root, "tsconfig.json")
      );
    });
  });
});
