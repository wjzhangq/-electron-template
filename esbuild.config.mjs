/**
 * Unified esbuild build configuration for the Electron template.
 *
 * Replaces the previous rollup + @vercel/ncc toolchain. Bundles all third-party
 * runtime dependencies (lodash, iconv-lite, shell-env, adm-zip) into the output
 * artifacts so that `dependencies` in package.json can stay empty.
 *
 * Entry points:
 *   src/main.js    -> main.js      (main process, CJS, minified)
 *   src/preload.js -> preload.js   (preload script,  CJS, minified)
 *
 * `electron` and Node.js builtins are kept external (provided by the runtime).
 *
 * Usage:
 *   node esbuild.config.mjs           production build (minified, no sourcemap)
 *   node esbuild.config.mjs --dev     dev build (not minified, with sourcemap)
 *   node esbuild.config.mjs --watch   watch mode (incremental rebuilds)
 */
import * as esbuild from "esbuild";

const argv = process.argv.slice(2);
const isWatch = argv.includes("--watch");
// watch mode implies a dev (non-minified, sourcemap) build for debuggability
const isDev = argv.includes("--dev") || isWatch;

/** Shared options for every entry point. */
const shared = {
  bundle: true,
  platform: "node", // Node.js builtins are auto-externalized
  format: "cjs",
  target: "node18",
  logLevel: "info",
  minify: !isDev,
  sourcemap: isDev,
};

/** Per-entry build configurations (T012 main, T013 preload). */
const builds = [
  {
    ...shared,
    entryPoints: ["src/main.js"],
    outfile: "main.js",
    external: ["electron"],
  },
  {
    ...shared,
    entryPoints: ["src/preload.js"],
    outfile: "preload.js",
    external: ["electron"],
  },
];

if (isWatch) {
  const contexts = await Promise.all(builds.map((cfg) => esbuild.context(cfg)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("[esbuild] watching for changes...");
} else {
  await Promise.all(builds.map((cfg) => esbuild.build(cfg)));
  console.log(`[esbuild] build complete (${isDev ? "dev" : "prod"})`);
}
