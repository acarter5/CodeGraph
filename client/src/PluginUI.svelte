<script>
	// Import global CSS from the Figma Svelte boilerplate (color/spacing vars).
	import { GlobalCSS } from 'figma-plugin-ds-svelte';
	import { Button, Input, Label, Checkbox } from 'figma-plugin-ds-svelte';

	// The graph.json URL the VS Code extension copies to the clipboard when it
	// finishes a build (e.g. http://localhost:3939/<graph>/graph.json).
	let url = '';
	let status = 'Paste the graph URL copied by the CodeGraph extension.';
	let busy = false;
	// Omit failure nodes (and connectors to them) from the rendered graph.
	let hideFailures = false;

	// figma.createImage rejects images larger than 4096px in either dimension
	// ("Image is too large"). Snapshots of long functions (captured at scale 3)
	// blow past that, so downscale oversized PNGs to fit before sending the
	// bytes to the sandbox. Aspect ratio is preserved; the box is still sized
	// from the manifest's logical dimensions, so only resolution drops.
	const MAX_IMAGE_DIM = 4096;

	// Decode via an <img> element rather than createImageBitmap — the latter can
	// return a blank/transparent bitmap for very large images in the Figma
	// iframe (which is exactly the root/entry snapshot), yielding a silently
	// empty downscaled image.
	function decodeImage(bytes) {
		return new Promise((resolve, reject) => {
			const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
			const img = new Image();
			img.onload = () => {
				URL.revokeObjectURL(objectUrl);
				if (!img.naturalWidth || !img.naturalHeight) {
					reject(new Error('decoded image has zero size'));
				} else {
					resolve(img);
				}
			};
			img.onerror = () => {
				URL.revokeObjectURL(objectUrl);
				reject(new Error('image failed to decode (too large?)'));
			};
			img.src = objectUrl;
		});
	}

	// Returns clean PNG bytes for figma.createImage, or throws if the image can't
	// be processed (so the caller marks it failed rather than sending blank bytes).
	//
	// We ALWAYS re-encode through a canvas, not just when downscaling. Figma's
	// createImage accepts the original dom-to-image PNGs (they get a hash) but
	// renders them *blank*; round-tripping every image through canvas → toPng
	// produces a normalized PNG Figma renders reliably. Downscale only when over
	// the 4096px hard limit.
	async function fitImageBytes(bytes) {
		const img = await decodeImage(bytes);
		const largest = Math.max(img.naturalWidth, img.naturalHeight);
		const ratio = largest > MAX_IMAGE_DIM ? MAX_IMAGE_DIM / largest : 1;
		const w = Math.max(1, Math.round(img.naturalWidth * ratio));
		const h = Math.max(1, Math.round(img.naturalHeight * ratio));
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		canvas.getContext('2d').drawImage(img, 0, 0, w, h);
		const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
		if (!blob) {
			throw new Error('canvas.toBlob returned null re-encoding image');
		}
		return new Uint8Array(await blob.arrayBuffer());
	}

	// The plugin sandbox (code.ts) has no `fetch`, so the UI iframe does all the
	// network work, then posts the manifest + raw PNG bytes across.
	async function load() {
		if (!url) {
			status = 'Enter the graph.json URL first.';
			return;
		}
		busy = true;
		try {
			status = 'Fetching manifest…';
			const res = await fetch(url);
			if (!res.ok) {
				throw new Error(`manifest HTTP ${res.status}`);
			}
			const manifest = await res.json();

			// Images are siblings of graph.json; resolve each by filename.
			const base = url.replace(/graph\.json(\?.*)?$/, '');
			const defs = manifest.definitions.filter((d) => d.image && d.image.file);

			const images = [];
			let failedImages = 0;
			for (let i = 0; i < defs.length; i++) {
				const def = defs[i];
				status = `Fetching image ${i + 1}/${defs.length}…`;
				const imgRes = await fetch(base + encodeURIComponent(def.image.file));
				if (!imgRes.ok) {
					throw new Error(`image HTTP ${imgRes.status}: ${def.image.file}`);
				}
				const buf = await imgRes.arrayBuffer();
				// A single oversized/undecodable image shouldn't blank-out or abort
				// the whole render — send bytes:null so the sandbox draws a labeled
				// "image too large" box for just that definition.
				try {
					const bytes = await fitImageBytes(new Uint8Array(buf));
					images.push({ definitionId: def.id, bytes });
				} catch (imgErr) {
					failedImages += 1;
					images.push({ definitionId: def.id, bytes: null });
				}
			}
			if (failedImages > 0) {
				status = `Rendering… (${failedImages} image(s) too large to display)`;
			}

			status = 'Rendering…';
			parent.postMessage(
				{ pluginMessage: { type: 'render-graph', manifest, images, hideFailures } },
				'*'
			);
		} catch (err) {
			status = 'Error: ' + (err && err.message ? err.message : String(err));
			busy = false;
		}
	}

	function cancel() {
		parent.postMessage({ pluginMessage: { type: 'cancel' } }, '*');
	}

	// Messages back from the sandbox (code.ts).
	window.onmessage = (event) => {
		const msg = event.data && event.data.pluginMessage;
		if (!msg) {
			return;
		}
		if (msg.type === 'done') {
			status = `Rendered ${msg.placements} boxes, ${msg.edges} connectors.`;
			busy = false;
		} else if (msg.type === 'error') {
			status = 'Render error: ' + msg.message;
			busy = false;
		}
	};
</script>

<div class="wrapper p-xxsmall">
	<Label>Graph URL</Label>
	<Input
		bind:value={url}
		placeholder="http://localhost:3939/…/graph.json"
		class="mb-xxsmall"
	/>

	<Label>{status}</Label>

	<Checkbox bind:checked={hideFailures} class="mb-xxsmall">
		Hide failure nodes
	</Checkbox>

	<div class="flex p-xxsmall mb-xsmall">
		<Button on:click={cancel} variant="secondary" class="mr-xsmall">Close</Button>
		<Button on:click={load} bind:disabled={busy}>Render graph</Button>
	</div>
</div>

<style>
	/* Add additional global or scoped styles here */
</style>
