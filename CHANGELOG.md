# Changelog

All notable changes to the CodeGraph extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- TODO(changelog): on publish day, move the 0.1.0 heading's date to the real
     release date and start a fresh [Unreleased] section above it. -->

## [0.1.0] — Unreleased

First public release. TypeScript only; see the README for current limitations.

### Added

- **`Codegraph: Make a codegraph` command.** Put the cursor on a function, run
  the command, and CodeGraph walks the call graph outward from that function —
  resolving every call to its definition, then recursing into those definitions
  until it reaches `node_modules` or runs out of new calls.
- **Syntax-highlighted code snapshots.** Each function is rendered with Prism
  (`tomorrow` theme) in a webview and captured as a PNG at a pixel density that
  keeps the code readable when zoomed.
- **FigJam rendering**, via the companion CodeGraph plugin:
  - Layered-DAG layout, one column per level of the call graph, with
    crossing-minimization so definitions sit near the functions that call them.
  - **Call-site-anchored connectors** — a line starts inside the caller's
    snapshot, on the exact call token, and ends at the definition it resolves
    to. Each edge gets its own colour, and edges crossing the same column gap
    are staggered into separate lanes so they don't overlap.
  - Recursive calls are drawn as dashed back-edges rather than being expanded
    forever.
  - Functions CodeGraph couldn't resolve become labelled, colour-coded boxes
    naming the reason, so gaps in the graph are visible instead of silent. A
    **Hide failure nodes** toggle removes them and their connectors.
  - Snapshots larger than Figma's 4096px image limit are sliced into a grid of
    tiles and reassembled at full capture resolution, so long functions stay
    readable rather than being downscaled to mush.
- **`graph.json` manifest** written alongside the PNGs, describing definitions,
  per-level placements, and edges — served to the plugin over a loopback-only
  HTTP server on `127.0.0.1`. No code leaves the machine.
- **Graph scoping** via `codegraph.includePaths` / `codegraph.excludePaths`.
  Entries may be workspace-relative directories, absolute paths, tsconfig
  `paths` aliases, or workspace package names; aliases resolve against the
  tsconfig governing each candidate file, so per-package aliases work in a
  monorepo. `node_modules` is always excluded regardless, and the function you
  selected is always graphed.
- **`codegraph.outputDirectory`** setting controlling where snapshots and the
  manifest are written (default: `.codegraph` in the workspace root).
- **`codegraph.serverPort`** setting (default `3939`). Note that the published
  FigJam plugin can only reach port 3939 — Figma requires plugins to declare
  every host they contact and offers no port wildcard — so changing this
  requires building the plugin yourself.

[Unreleased]: https://github.com/acarter5/CodeGraph/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/acarter5/CodeGraph/releases/tag/v0.1.0
