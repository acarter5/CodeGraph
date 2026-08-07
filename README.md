# CodeGraph

**See a whole code path at once, instead of clicking through fifteen files to reconstruct it.**

Point CodeGraph at a function and it snapshots that function, then every function
it calls, then every function *those* call — recursively, until it runs out of
first-party code. The result is laid out as a diagram in [FigJam](https://www.figma.com/figjam/):
one column per level of the call graph, with a line drawn from each **call site**
to the **definition** it resolves to.

Because it lands in FigJam, you can annotate on top of it — circle the branch that
matters, leave notes for a code review, sketch the refactor next to the code it
affects.

<!--
  TODO(readme): retake this capture with nothing selected (Esc before
  screenshotting) — the current one has FigJam's selection toolbar floating over
  the middle of the graph. A second, zoomed-in shot showing legible code and a
  call-site connector would also help; this one only conveys scale.
-->

![A CodeGraph diagram in FigJam: a seven-column call graph of colour-outlined
code snapshots, connected left to right from each call site to the definition it
resolves to](images/screenshot.png)

---

## Requirements

- **VS Code 1.75+** (or Cursor).
- **A TypeScript project.** TypeScript is the only supported language today — see
  [Limitations](#limitations).
- **The CodeGraph FigJam plugin**, which does the actual drawing. The extension
  produces the data; the plugin renders it.

> The two halves talk over a local HTTP server bound to `127.0.0.1`. Nothing is
> uploaded, and no code leaves your machine.

### Installing the FigJam plugin

<!-- TODO(readme): replace with the Figma Community link once the plugin is published. -->

The plugin isn't on the Figma Community yet. Until it is, build and side-load it:

```bash
git clone https://github.com/acarter5/CodeGraph.git
cd CodeGraph/client
npm install
npm run build
```

Then in the Figma **desktop app**: **Plugins → Development → Import plugin from
manifest…** and choose `client/public/manifest.json`.

## Getting started

1. Open a TypeScript file and **put your cursor on a function** — either its
   declaration or a call to it.
2. Run **`Codegraph: Make a codegraph`** from the Command Palette
   (<kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>).
3. A **CodeGraph** panel opens beside your editor and flickers through each
   function as it captures snapshots.
   Let it run — large graphs take a while, and the capture is deliberately
   serialized. When it finishes, a notification reports how many definitions were
   found and **copies a URL to your clipboard**.
4. Open a **FigJam** file, run the **CodeGraph** plugin, **paste the URL**, and
   click **Render graph**.

The snapshots and a `graph.json` manifest are written to `.codegraph/` in your
workspace (configurable). You'll probably want to add that to `.gitignore`.

### The plugin window

- **Graph URL** — paste what the extension copied. It must be a `localhost:3939`
  URL; see the note on `codegraph.serverPort` below.
- **Hide failure nodes** — omit functions CodeGraph couldn't resolve (and any
  connectors to them), leaving only the call flow it's confident about. Useful on
  messy graphs.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `codegraph.outputDirectory` | `""` | Where snapshots and `graph.json` are written. Absolute paths are used as-is; relative paths resolve against the workspace root. Empty means `.codegraph` in the workspace root. |
| `codegraph.serverPort` | `3939` | Port for the local server the plugin fetches from. Bound to `127.0.0.1` only. **Leave this alone** — see below. |
| `codegraph.includePaths` | `[]` | When non-empty, only graph definitions living under these paths. |
| `codegraph.excludePaths` | `[]` | Never graph definitions living under these paths. Wins over `includePaths`. |

> ⚠️ **`codegraph.serverPort` is effectively fixed at 3939.** Figma requires plugins
> to declare every host they contact in the plugin manifest, and it has no wildcard
> syntax for ports — so the published plugin can only reach `localhost:3939`. Change
> this setting and the plugin will refuse the URL. (It says so explicitly rather
> than failing silently.) Only change it if you're building the plugin yourself,
> and edit `client/public/manifest.json` to match.

### Scoping the graph

`includePaths` / `excludePaths` keep the graph focused on the code you care about.
Both take a list of **workspace-relative directories** (`src/services`), **absolute
paths**, **tsconfig `paths` aliases** (`@shared`, `@shared/*`, `@/services`), or
**workspace package names**. Because they're project-specific, a workspace
`.vscode/settings.json` is the natural home:

```jsonc
{
  "codegraph.includePaths": ["src/core", "@shared"],
  "codegraph.excludePaths": ["src/legacy"]
}
```

Behavior worth knowing:

- **`node_modules` is always excluded**, regardless of these settings. They only
  scope your own code.
- **The function you selected is always graphed** — the filter only prunes calls
  it recurses into.
- A filtered-out call is a **silent drop**: no box, no connector, and recursion
  stops there. Exactly like a call into `node_modules`.
- Aliases resolve against the `tsconfig.json` that governs the file being
  considered, so per-package aliases in a monorepo resolve correctly.
- A typo'd entry matches nothing and drops nothing — it won't silently prune your
  whole graph.

## How it works

For each function, CodeGraph reads the file, parses it with
[ts-morph](https://ts-morph.com/), finds every call expression, and asks VS Code's
definition provider where each one leads. Definitions inside `node_modules` (and
anything your path filters exclude) stop the recursion; everything else becomes
the next level of the graph.

Snapshots are **images of syntax-highlighted code**, rendered with
[Prism](https://prismjs.com/) inside a hidden webview and captured as PNGs. This
means they use Prism's `tomorrow` theme rather than your editor's colors —
consistent across machines, but not a match for your setup.

While capturing, CodeGraph also measures the on-screen rectangle of each call
token. That's what lets the FigJam plugin start a connector *inside* the caller's
snapshot, on the exact call, rather than at the edge of the box.

## Limitations

- **TypeScript only.** JavaScript may partly work; other languages won't. Python
  is on the roadmap.
- **A function can appear more than once**, at different levels of the graph
  (never twice within one level). Collapsing to a single instance with back-edges
  is planned.
- **Definition resolution isn't perfect.** VS Code's definition provider misses
  some cases — notably methods passed as arguments. Those become labelled
  failure boxes rather than silently vanishing, so you can see exactly where the
  graph gave up. Use **Hide failure nodes** to tidy them away.
- **Connectors are FigJam-only.** The plugin will render boxes in a regular Figma
  design file, but `createConnector` doesn't exist there, so you get no lines.
- **Connector start points don't follow dragged boxes.** A connector anchored to a
  call site uses a fixed position, so moving a box by hand leaves that end behind.
- **Very large functions are tiled.** Snapshots over Figma's 4096px image limit are
  sliced into a grid and reassembled at full resolution — occasionally you can see
  a seam.

## Contributing

Issues and PRs welcome: <https://github.com/acarter5/CodeGraph>.

The repo holds both halves. The extension builds with webpack from the root
(`npm run compile`, F5 to launch an Extension Development Host); the FigJam plugin
builds with Rollup from `client/` (`npm run build`). They're separate toolchains —
install and build each on its own.

## Release notes

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). The `client/` directory was scaffolded from
[figma-plugin-ds-svelte](https://github.com/thomas-lowry/figma-plugin-ds-svelte),
which carries its own MIT license (`client/LICENSE`).
