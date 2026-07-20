import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { ts } from "ts-morph";

import { isBareModuleSpecifier } from "./tsMorph";

/*
  Deciding whether a call is "external" (node_modules → not graphed) can't be
  done from the module specifier's shape alone. A bare specifier like
  `@/services/greeter`, `~/lib/x`, `src/utils/x` (baseUrl) or `@myorg/shared`
  (workspace package) is *first-party* code, but doesn't start with "." or "/".
  Treating those as external silently dropped the call — no node, no fail node,
  no connector — so the graph terminated early at every alias boundary.

  Instead we run TypeScript's own module resolution against the file's real
  tsconfig, which understands `paths`/`baseUrl`, and classify by where the
  specifier actually lands. Resolution realpaths through symlinks by default, so
  a pnpm/yarn workspace package resolves to `packages/shared/...` rather than
  the `node_modules/@myorg/shared` symlink, and is correctly kept as internal.
*/

// tsconfig lookup is filesystem-walking, and resolution is called once per call
// expression per node, so both are cached for the life of the extension host.
// The dir cache is keyed by stop dir too, since the same dir resolves
// differently under a different boundary.
const tsconfigForDir = new Map<string, string | null>();
const optionsForTsconfig = new Map<string, ts.CompilerOptions>();

function dirCacheKey(dir: string, stopDir: string | undefined): string {
  return `${stopDir ?? ""}::${dir}`;
}

// Workspace folder containing the file, which bounds the tsconfig walk.
// undefined for a file outside any open folder (then the walk is unbounded, as
// there's no project boundary to respect).
function workspaceRootFor(filePath: string): string | undefined {
  try {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri
      .fsPath;
  } catch {
    // `vscode` is unavailable outside the extension host (e.g. a bare unit
    // test); fall back to an unbounded walk rather than failing resolution.
    return undefined;
  }
}

// Is `dir` at or below `ancestor`?
function isAtOrBelow(dir: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, dir);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/*
  Nearest tsconfig.json at or above `startDir`, or null if there isn't one.

  `stopDir` (the workspace root) bounds the walk: without it, a project with no
  tsconfig anywhere would keep climbing past the workspace into the user's home
  directory and silently adopt an unrelated project's `paths`/`baseUrl`, which
  would then misclassify calls with no visible error. The bound is inclusive —
  `stopDir` itself is checked, nothing above it is.

  Exported for tests; callers should prefer `getCompilerOptions`.
*/
export function findTsConfig(
  startDir: string,
  stopDir?: string
): string | null {
  // A stop dir that isn't an ancestor of startDir can't bound the walk, and
  // honouring it would just disable the fs-root fallback — ignore it.
  const boundary =
    stopDir && isAtOrBelow(startDir, stopDir)
      ? path.resolve(stopDir)
      : undefined;

  const cached = tsconfigForDir.get(dirCacheKey(startDir, boundary));
  if (cached !== undefined) {
    return cached;
  }

  // Every dir visited resolves to the same answer, so memoize the whole chain
  // rather than only the dir we started from.
  const visited: string[] = [];
  let dir = path.resolve(startDir);
  let found: string | null = null;

  while (true) {
    visited.push(dir);
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) {
      found = candidate;
      break;
    }
    if (boundary && dir === boundary) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  for (const visitedDir of visited) {
    tsconfigForDir.set(dirCacheKey(visitedDir, boundary), found);
  }
  return found;
}

// Compiler options for the file, from its nearest tsconfig. `{}` when there
// isn't one (or it can't be read) — resolution then falls back to plain node
// resolution, which is still correct for relative + node_modules specifiers.
export function getCompilerOptions(
  containingFilePath: string
): ts.CompilerOptions {
  const tsconfigPath = findTsConfig(
    path.dirname(containingFilePath),
    workspaceRootFor(containingFilePath)
  );
  if (!tsconfigPath) {
    return {};
  }

  const cached = optionsForTsconfig.get(tsconfigPath);
  if (cached) {
    return cached;
  }

  let options: ts.CompilerOptions = {};
  try {
    // readConfigFile/parseJsonConfigFileContent handle comments and `extends`
    // chains, which a plain JSON.parse would choke on.
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!configFile.error && configFile.config) {
      options = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath)
      ).options;
    }
  } catch (error) {
    console.error("[codegraph] failed to read tsconfig", {
      tsconfigPath,
      error,
    });
  }

  optionsForTsconfig.set(tsconfigPath, options);
  return options;
}

/*
  True when `specifier`, imported from `containingFilePath`, resolves into
  node_modules. Falls back to the old shape heuristic only when TypeScript
  can't resolve the specifier at all, so an unresolvable bare import is still
  treated as external rather than becoming a noisy definition lookup.
*/
export function isExternalModuleSpecifier(
  specifier: string,
  containingFilePath: string
): boolean {
  try {
    const resolved = ts.resolveModuleName(
      specifier,
      containingFilePath,
      getCompilerOptions(containingFilePath),
      ts.sys
    ).resolvedModule;

    if (!resolved) {
      return isBareModuleSpecifier(specifier);
    }

    // Classify by the resolved path, not `isExternalLibraryImport`: the latter
    // is true for anything reached *through* node_modules, which would wrongly
    // mark symlinked workspace packages external.
    return resolved.resolvedFileName.includes("node_modules");
  } catch (error) {
    console.error("[codegraph] module resolution failed", {
      specifier,
      containingFilePath,
      error,
    });
    return isBareModuleSpecifier(specifier);
  }
}
