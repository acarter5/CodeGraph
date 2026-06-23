import * as http from "http";
import * as fs from "fs";
import * as path from "path";

// Content types for the only two things we serve: the manifest and the PNGs.
const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

/*
  A tiny static file server over the graph output directory. The FigJam plugin
  runs in a sandboxed iframe with no filesystem access, so it can't read
  graph.json or the snapshot PNGs off disk — instead it `fetch()`es them from
  this server on localhost. (This replaced the inline-base64 transport, which
  bloated graph.json; see CLAUDE.md "Client ↔ backend integration".)

  Built on Node's `http` so we add no dependency. One long-lived instance is
  reused across `makeGraph` runs and disposed when the extension deactivates;
  `setRootDir` re-points it if the output directory changes between runs.
*/
export default class CodeGraphServer {
  private server: http.Server | undefined;
  private rootDir: string;
  private readonly port: number;
  private boundPort: number | undefined;

  constructor(rootDir: string, port: number) {
    this.rootDir = rootDir;
    this.port = port;
  }

  public setRootDir(rootDir: string) {
    this.rootDir = rootDir;
  }

  // The base URL once listening, e.g. "http://localhost:3939". Undefined until
  // start() resolves.
  public get url(): string | undefined {
    return this.boundPort ? `http://localhost:${this.boundPort}` : undefined;
  }

  // Starts listening (idempotent — returns the existing URL if already up).
  public start(): Promise<string> {
    if (this.server && this.url) {
      return Promise.resolve(this.url);
    }

    const server = http.createServer((req, res) => this._handle(req, res));
    this.server = server;

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = undefined;
        reject(err);
      };
      server.once("error", onError);
      // Bind to loopback only — this serves local source snapshots and should
      // never be reachable off the machine.
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const address = server.address();
        this.boundPort =
          typeof address === "object" && address ? address.port : this.port;
        resolve(this.url as string);
      });
    });
  }

  public dispose() {
    this.server?.close();
    this.server = undefined;
    this.boundPort = undefined;
  }

  /*
    Decode a URL path to a filesystem path. Graph dir/file names embed a literal
    "%" (View turns the file extension's "." into "%", e.g. "cluster%js"), so a
    request path can contain a bare "%" that isn't a valid percent-escape.
    `decodeURIComponent` throws `URIError: URI malformed` on those, which would
    otherwise crash the request handler. Browsers/Figma's fetch send such a "%"
    unencoded, so before decoding we re-encode any "%" not already followed by
    two hex digits to "%25". Real escapes (e.g. "%20" for spaces) still decode.
  */
  private _decodePath(pathname: string): string {
    const safe = pathname.replace(/%(?![0-9a-fA-F]{2})/g, "%25");
    try {
      return decodeURIComponent(safe);
    } catch {
      return pathname;
    }
  }

  private _handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // The Figma plugin UI iframe has a `null` origin, so permit any origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end("method not allowed");
      return;
    }

    const requestPath = this._decodePath(
      new URL(req.url ?? "/", "http://localhost").pathname
    );
    // Resolve under the root and reject anything that escapes it (path
    // traversal). Leading "." keeps the join relative to rootDir.
    const resolved = path.resolve(this.rootDir, "." + requestPath);
    if (
      resolved !== this.rootDir &&
      !resolved.startsWith(this.rootDir + path.sep)
    ) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    fs.stat(resolved, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const type =
        CONTENT_TYPES[path.extname(resolved).toLowerCase()] ??
        "application/octet-stream";
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Length", stats.size);
      const stream = fs.createReadStream(resolved);
      stream.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
      stream.pipe(res);
    });
  }
}
