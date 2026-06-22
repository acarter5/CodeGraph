---
name: figma-createimage-blank-pngs
description: Figma createImage accepts dom-to-image PNGs but renders them blank — must re-encode through a canvas
metadata:
  type: project
---

`figma.createImage(bytes)` in the FigJam plugin **accepts the original `dom-to-image-more` snapshot PNGs (returns a valid hash, so the image-filled box gets the right size) but renders them BLANK**. The fix: round-trip every PNG through `<img>` → `<canvas>` → `canvas.toBlob('image/png')` in the plugin UI iframe before sending bytes to the sandbox (`fitImageBytes` in `client/src/PluginUI.svelte`). Re-encode **all** images, not just oversized ones.

**Why (verified 2026-06-20 with real data):** a re-encoded 4096px image rendered fine while an un-re-encoded 3363px original rendered blank — so it's not size, it's the original PNG encoding. Two related gotchas found the same day:
- Decode with an `<img>` element, **not `createImageBitmap`** — the latter silently returns a blank/transparent bitmap for very large images in the Figma iframe.
- `figma.createImage` hard-caps at **4096px** in either dimension ("Image is too large"); snapshots of long functions at `scale: 3` exceed it (e.g. a real entry fn was 2142×7980), so downscale during the same re-encode.

**How to apply:** never feed raw snapshot bytes straight to `createImage`. If boxes render blank in FigJam, suspect the PNG encoding first. The real long-term fix for huge functions is tiling / a lower capture scale (see [[manifest-base64-size]]).
