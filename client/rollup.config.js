import svelte from 'rollup-plugin-svelte';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import livereload from 'rollup-plugin-livereload';
import { terser } from 'rollup-plugin-terser';
// Needed for figma-plugin-ds-svelte, whose components import .svg icon files.
import svg from 'rollup-plugin-svg';
import typescript from 'rollup-plugin-typescript';
// rollup-plugin-typescript v1 can't drive TS 5 ("hostOrText.readFile is not a
// function"), so it transpiles with a pinned TS 3.8 alias. It only strips types
// (no type-check) — `npx tsc --noEmit` uses the real TS 5 for that.
const transpiler = require('typescript-transpile');

/* Post CSS */
import postcss from 'rollup-plugin-postcss';
import cssnano from 'cssnano';

/* Inline to single html */
import htmlBundle from 'rollup-plugin-html-bundle';

const production = !process.env.ROLLUP_WATCH;

export default [{
	input: 'src/main.js',
	output: {
		format: 'iife',
		name: 'ui',
		file: 'src/build/bundle.js'
	},
	plugins: [
		svelte({
			// enable run-time checks when not in production
			dev: !production
		}),

		// If you have external dependencies installed from
		// npm, you'll most likely need these plugins. In
		// some cases you'll need additional configuration —
		// consult the documentation for details:¡
		// https://github.com/rollup/plugins/tree/master/packages/commonjs
		resolve({
			browser: true,
			dedupe: importee => importee === 'svelte' || importee.startsWith('svelte/'),
			extensions: ['.svelte', '.mjs', '.js', '.json', '.node']
		}),
		commonjs(),
		svg(),
		postcss({
			extensions: ['.css'],
			plugins: [cssnano()]
		}),
		htmlBundle({
			template: 'src/template.html',
			target: 'public/index.html',
			inline: true
		}),

		// In dev mode, call `npm run start` once
		// the bundle has been generated
		!production && serve(),

		// Watch the `dist` directory and refresh the
		// browser on changes when not in production
		!production && livereload('public'),

		// If we're building for production (npm run build
		// instead of npm run dev), minify
		production && terser()
	],
	watch: {
		clearScreen: false
	}
},
{
	input: 'src/code.ts',
	output: {
		file: 'public/code.js',
		format: 'cjs',
		name: 'code'
	},
	plugins: [
		typescript({ typescript: transpiler }),
		// Resolve + bundle node_modules deps (e.g. @dagrejs/dagre) into the
		// sandbox bundle; commonjs() converts their CJS to ESM for Rollup.
		resolve({
			browser: true,
			extensions: ['.ts', '.mjs', '.js', '.json', '.node']
		}),
		commonjs(),
		production && terser()
	]
},
{
	// The CodeGraph widget (interactive, collapsible nodes). Shares ./shared
	// with the plugin and reuses the plugin's UI iframe, copied in as
	// widget/ui.html once it's built (the UI config above runs first).
	input: 'src/widget/code.tsx',
	output: {
		file: 'widget/code.js',
		format: 'cjs',
		name: 'code'
	},
	plugins: [
		typescript({ typescript: transpiler }),
		resolve({
			browser: true,
			extensions: ['.ts', '.tsx', '.mjs', '.js', '.json', '.node']
		}),
		commonjs(),
		production && terser(),
		copyFile('public/index.html', 'widget/ui.html')
	]
}];

function copyFile(from, to) {
	return {
		writeBundle() {
			require('fs').copyFileSync(from, to);
		}
	};
}

function serve() {
	let started = false;

	return {
		writeBundle() {
			if (!started) {
				started = true;

				require('child_process').spawn('npm', ['run', 'start', '--', '--dev'], {
					stdio: ['ignore', 'inherit', 'inherit'],
					shell: true
				});
			}
		}
	};
}
