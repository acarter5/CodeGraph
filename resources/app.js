(function () {
  // acquireVsCodeApi is a global the webview injects exactly once per page.
  // Capture it first so the global error handlers below can use it to forward
  // diagnostics back to the extension host — that's the only way we ever see
  // a script error in the host console (the webview's own console lives in
  // its own DevTools panel).
  const vscode = acquireVsCodeApi();

  function hostLog(label, info) {
    try {
      vscode.postMessage({
        type: "webviewLog",
        data: { label, info },
      });
    } catch (_) {
      /* ignore — best-effort logging */
    }
  }

  window.addEventListener("error", (e) => {
    hostLog("window.error", {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error && e.error.stack,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    hostLog("unhandledrejection", {
      reason: String(e.reason),
      stack: e.reason && e.reason.stack,
    });
  });

  hostLog("script start", {
    hasPrism: typeof window.Prism !== "undefined",
    hasDomToImage: typeof window.domtoimage !== "undefined",
    dataKeys: window.__data__ ? Object.keys(window.__data__) : null,
  });

  const node = document.getElementById("output");

  const copyButton = document.querySelector("#copy");
  const tweetButton = document.querySelector("#tweet");
  const beerButton = document.querySelector("#beer");

  const downloadButton = document.querySelector("#download");
  const footer = document.querySelector("#footer");

  copyButton.addEventListener("click", () => copyImage(false));
  downloadButton.addEventListener("click", downloadImage);
  tweetButton.addEventListener("click", composeTweet);
  beerButton.addEventListener("click", buyMeABeer);

  const contentNode = document.getElementById("content");
  const containerNode = document.getElementById("container");

  const { code, language, start, end, nodeId } = window.__data__;

  // Line height has to be applied identically to the rendered code AND to the
  // line-number gutter so they line up vertically. 19px is the size vscode's
  // copy command used to emit, kept here so the snapshots look the same.
  const LINE_HEIGHT_PX = 19;

  function base64ToBlob(b64Data, contentType = "", sliceSize = 1024) {
    const byteCharacters = atob(b64Data);
    const byteArrays = [];

    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
      const slice = byteCharacters.slice(offset, offset + sliceSize);

      const byteNumbers = new Array(slice.length);

      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }

      byteArrays.push(new Uint8Array(byteNumbers));
    }

    return new Blob(byteArrays, { type: contentType });
  }

  async function copyImage(omitMessage) {
    const url = await domtoimage.toPng(contentNode, {
      bgColor: "transparent",
      scale: 3,
    });

    const blob = base64ToBlob(url.slice(url.indexOf(",") + 1), "image/png");
    const item = new ClipboardItem({ "image/png": blob });

    navigator.clipboard.write([item]);

    if (!omitMessage) {
      vscode.postMessage({ type: "copied" });
    }

    containerNode.classList.add("bounce");
  }

  async function toSvg() {
    const data = await domtoimage.toSvg(contentNode);
    return data.replace(/%0A/g, "\n").replace(/%23/g, "#").replace(/%25/g, "%");
  }

  async function downloadImage() {
    const { enablePng, scale } = window.__data__;

    const data = enablePng
      ? await domtoimage.toPng(contentNode, {
          bgColor: "transparent",
          scale: Math.min(4, Math.max(1, scale || 0)),
        })
      : await toSvg();

    containerNode.classList.add("bounce");

    vscode.postMessage({
      type: "download",
      data: data.slice(data.indexOf(",") + 1),
    });
  }

  async function composeTweet() {
    await copyImage(true);
    vscode.postMessage({ type: "tweet" });
  }

  function buyMeABeer() {
    vscode.postMessage({ type: "beer" });
  }

  // Render the code with Prism, then capture the rendered DOM as PNG and ship
  // it to the host. Replaces the old paste-the-clipboard pipeline — see
  // BUGS.md #20 for why that pipeline had to go.
  function render() {
    if (!window.Prism) {
      hostLog("render-error", { reason: "Prism global missing" });
      throw new Error("Prism global missing");
    }
    const grammar =
      window.Prism.languages[language] || window.Prism.languages.javascript;
    const highlighted = window.Prism.highlight(code || "", grammar, language);

    hostLog("render", {
      nodeId,
      language,
      codeLen: (code || "").length,
      grammarFound: !!window.Prism.languages[language],
      highlightedLen: highlighted.length,
    });

    // Inline styles on the <pre> rather than relying on app.css so the
    // resulting DOM is self-contained for dom-to-image's snapshot.
    node.innerHTML = `<pre id="code" class="language-${language}" style="margin: 0; padding: 12px 16px; font-family: 'Cascadia Code', Menlo, Monaco, monospace; font-size: 13px; line-height: ${LINE_HEIGHT_PX}px; white-space: pre; background: #2d2d2d;"><code class="language-${language}">${highlighted}</code></pre>`;

    const linesNode = document.getElementById("lines");
    const titleNode = document.getElementById("title");
    titleNode.innerHTML = "fileName";

    // Match the code's line height exactly so the gutter stays aligned even
    // if a future theme change shifts the code block's height.
    for (let i = start; i <= end + 1; i++) {
      const newNodeChild = document.createElement("span");
      newNodeChild.innerHTML = i;
      newNodeChild.style.lineHeight = `${LINE_HEIGHT_PX}px`;
      linesNode.appendChild(newNodeChild);
    }

    containerNode.style.opacity = 1;
    footer.style.display = "flex";
  }

  async function capture() {
    const scale = 3;
    const pngData = await domtoimage.toPng(contentNode, {
      bgColor: "transparent",
      scale,
    });
    const img = pngData.slice(pngData.indexOf(",") + 1);

    // Read the rendered PNG's true pixel dimensions so the manifest can size
    // the image and anchor connectors when rendering into FigJam.
    const { width, height } = await new Promise((res) => {
      const image = new Image();
      image.onload = () =>
        res({ width: image.naturalWidth, height: image.naturalHeight });
      image.src = pngData;
    });

    hostLog("snapshotTaken", { nodeId, width, height });

    vscode.postMessage({
      type: "snapshotTaken",
      data: {
        snapshotedNode: nodeId,
        img,
        width,
        height,
        scale,
      },
    });
  }

  // Render synchronously, then capture on the next paint so styles + font
  // metrics are committed before dom-to-image walks the tree. Wrap in
  // try/catch so a thrown error makes it back to the host rather than
  // disappearing into the webview-only console.
  try {
    render();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        capture().catch((err) =>
          hostLog("capture-error", { message: String(err), stack: err.stack })
        );
      })
    );
  } catch (err) {
    hostLog("render-throw", { message: String(err), stack: err.stack });
  }
})();
