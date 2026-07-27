import * as path from "path";
import * as fs from "fs";
import { ts } from "ts-morph";

import { findTsConfig, getCompilerOptions } from "./moduleResolution";

/*
  Scopes which resolved function definitions get graphed, driven by the
  `codegraph.includePaths` / `codegraph.excludePaths` settings.

  Filtering runs on the *resolved definition's real file path* (after VS Code's
  definition provider has located it), at the same points the Builder already
  drops node_modules definitions. node_modules stays excluded independently of
  these settings, and the entry node the user selected is always graphed — this
  only prunes recursed children (and, transitively, their subtrees).

  Each include/exclude entry is turned into one or more absolute directory
  prefixes; a definition is "within" an entry when its file path sits at or
  below one of those prefixes. Supported entry forms:

    - absolute path                 → used as-is
    - workspace-relative directory  (`src/services`, `./src/services`) that
                                      exists on disk → resolved against the
                                      workspace root
    - tsconfig `paths` alias         (`@shared`, `@shared/*`, `@/services`) →
                                      resolved through the candidate file's own
                                      tsconfig `paths`/`baseUrl` (monorepo-safe)
    - workspace-package / module name → resolved via TypeScript module
                                      resolution to its source directory (only
                                      when it lands outside node_modules)

  Because aliases are interpreted in the *candidate file's* tsconfig context,
  a monorepo where different packages declare different aliases still resolves
  each definition correctly. Resolution is cached per (tsconfig, entry).
*/

// Is `filePath` at or below directory `prefix`?
function isWithin(filePath: string, prefix: string): boolean {
  const relative = path.relative(prefix, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/*
  Resolve an alias entry against a tsconfig's `paths`/`baseUrl` to absolute
  directory prefixes. Handles wildcard patterns: for a pattern `@/*` → `src/*`,
  the entry `@/services` maps to `<baseUrl>/src/services`, and the bare alias
  `@shared` matches the pattern `@shared/*`. Exported for tests.
*/
export function resolvePathsAlias(
  entry: string,
  options: ts.CompilerOptions,
  tsconfigDir: string
): string[] {
  const { paths } = options;
  if (!paths) {
    return [];
  }

  // Normalise a trailing wildcard off the user's entry (`@shared/*` → `@shared`).
  const cleanEntry = entry.replace(/\/?\*$/, "");

  const baseUrlAbs = options.baseUrl
    ? path.isAbsolute(options.baseUrl)
      ? options.baseUrl
      : path.resolve(tsconfigDir, options.baseUrl)
    : tsconfigDir;

  const out: string[] = [];
  for (const pattern of Object.keys(paths)) {
    const targets = paths[pattern];
    const hasWildcard = pattern.endsWith("*");
    // `@/*` → prefix `@/`; `@shared` (exact) → prefix `@shared`.
    const patternPrefix = pattern.replace(/\*$/, "");

    let remainder: string | null = null;
    if (hasWildcard) {
      if (cleanEntry.startsWith(patternPrefix)) {
        remainder = cleanEntry.slice(patternPrefix.length);
      } else if (
        patternPrefix.endsWith("/") &&
        cleanEntry === patternPrefix.slice(0, -1)
      ) {
        // Bare alias (`@shared`) against a wildcard pattern (`@shared/*`).
        remainder = "";
      }
    } else if (cleanEntry === patternPrefix) {
      remainder = "";
    }

    if (remainder === null) {
      continue;
    }

    for (const target of targets) {
      const targetPrefix = target.replace(/\*$/, "");
      out.push(path.resolve(baseUrlAbs, targetPrefix, remainder));
    }
  }
  return out;
}

export interface PathFilterConfig {
  include: string[];
  exclude: string[];
  workspaceRoot?: string;
}

export default class PathFilter {
  private include: string[];
  private exclude: string[];
  private workspaceRoot: string | undefined;
  // Cache resolved prefixes; keyed so context-independent (absolute/relative)
  // entries share one entry and alias/module entries key on their tsconfig.
  private prefixCache = new Map<string, string[]>();

  constructor(config: PathFilterConfig) {
    this.include = config.include.map((e) => e.trim()).filter(Boolean);
    this.exclude = config.exclude.map((e) => e.trim()).filter(Boolean);
    this.workspaceRoot = config.workspaceRoot
      ? path.resolve(config.workspaceRoot)
      : undefined;
  }

  // No settings → filter is a no-op and callers can skip the work entirely.
  get isActive(): boolean {
    return this.include.length > 0 || this.exclude.length > 0;
  }

  /*
    Should the definition at `filePath` be graphed? Exclude wins over include;
    when includePaths is set, a definition must fall under one to be kept.
    node_modules is handled separately by the Builder, not here.
  */
  shouldGraphDefinition(filePath: string): boolean {
    if (!this.isActive) {
      return true;
    }
    const normalized = path.resolve(filePath);

    if (this.matchesAny(normalized, this.exclude)) {
      return false;
    }
    if (this.include.length === 0) {
      return true;
    }
    return this.matchesAny(normalized, this.include);
  }

  private matchesAny(filePath: string, entries: string[]): boolean {
    for (const entry of entries) {
      for (const prefix of this.resolveEntry(entry, filePath)) {
        if (isWithin(filePath, prefix)) {
          return true;
        }
      }
    }
    return false;
  }

  private resolveEntry(entry: string, contextFile: string): string[] {
    // Absolute path — context-independent.
    if (path.isAbsolute(entry)) {
      return this.cached(`abs::${entry}`, () => [path.resolve(entry)]);
    }

    // Workspace-relative directory that actually exists on disk.
    if (this.workspaceRoot) {
      const candidate = path.resolve(this.workspaceRoot, entry);
      const cached = this.prefixCache.get(`rel::${candidate}`);
      if (cached) {
        return cached;
      }
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          const result = [candidate];
          this.prefixCache.set(`rel::${candidate}`, result);
          return result;
        }
      } catch {
        // Unreadable path — fall through to alias/module resolution.
      }
    }

    // Alias or module — resolved in the candidate file's tsconfig context.
    const tsconfigPath =
      findTsConfig(path.dirname(contextFile), this.workspaceRoot) ?? "<none>";
    return this.cached(`alias::${tsconfigPath}::${entry}`, () =>
      this.resolveAliasOrModule(entry, contextFile, tsconfigPath)
    );
  }

  private resolveAliasOrModule(
    entry: string,
    contextFile: string,
    tsconfigPath: string
  ): string[] {
    const options = getCompilerOptions(contextFile);
    const tsconfigDir =
      tsconfigPath !== "<none>"
        ? path.dirname(tsconfigPath)
        : this.workspaceRoot ?? path.dirname(contextFile);

    const aliasPrefixes = resolvePathsAlias(entry, options, tsconfigDir);
    if (aliasPrefixes.length) {
      return aliasPrefixes;
    }

    // Fall back to real module resolution for workspace packages / bare
    // specifiers. Only keep first-party landings — node_modules is excluded
    // regardless, so there's nothing to scope in there.
    try {
      const resolved = ts.resolveModuleName(
        entry,
        contextFile,
        options,
        ts.sys
      ).resolvedModule;
      if (resolved && !resolved.resolvedFileName.includes("node_modules")) {
        return [path.dirname(resolved.resolvedFileName)];
      }
    } catch {
      // Unresolvable — no prefix, so the entry matches nothing.
    }
    return [];
  }

  private cached(key: string, compute: () => string[]): string[] {
    const hit = this.prefixCache.get(key);
    if (hit) {
      return hit;
    }
    const value = compute();
    this.prefixCache.set(key, value);
    return value;
  }
}
