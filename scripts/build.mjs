/**
 * Build script for the DSH session-trash plugin.
 *
 * Two artifacts, mirroring how a first-party DSH client package is built:
 *
 * - `lib/index.js`  — the Host half, plain ESM for Node (no bundling needed).
 * - `lib/client.js` — the browser half, emitted as the DSH module-table
 *   closure factory: a CommonJS-style body wrapped in
 *   `window.__ModuleLoader__.load({ id, factory })`, which is exactly what
 *   `@deepseek-ai/dsh-client-modules` serves at `/plugins/<id>/client.js`.
 *
 * The client half pulls only React from the module table, because the
 * 「会话删除」settings section is an ordinary slot component.
 */
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'lib')
const PACKAGE_NAME = 'dsh-session-trash'

/**
 * Browser half wrapper. DSH materializes a bundle by calling this factory with a
 * module-table `require`; the emitted CommonJS body needs `module`/`exports` in
 * scope, so they are declared inside the factory rather than relying on any
 * global. (esbuild has no `intro` option, hence the two-part banner.)
 *
 * esbuild erases the entry's own ESM exports when bundling to IIFE/CJS, but
 * Cordis activates the entry through `exports.apply`/`exports.inject`, so the
 * footer returns a fresh object carrying them explicitly. Do NOT `Object.assign`
 * onto `module.exports`: esbuild emits live-binding getters there, and defining
 * over a getter-only property throws at activation. Keep the exported names in
 * sync with `src/client/index.js`.
 *
 * React stays external: it is a DSH platform module, so `require('react')`
 * inside the factory resolves to the host's own instance through the module
 * table. The factory parameter is published on a global because the settings
 * section lives in another module of this bundle and cannot see the parameter
 * directly (esbuild rewrites factory-local identifiers in CJS output).
 */
const banner = {
  js: [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require, module, exports) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
    'globalThis.__dshSessionTrashRequire = require;',
  ].join('\n'),
}
const footer = { js: 'return { apply: apply, inject: inject }; } });' }

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'src/host/index.js')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Stay a real import so the profile's node_modules resolves the one helper
  // the Host half shares with the rest of DSH.
  external: ['@deepseek-ai/dsh-home-paths', '@deepseek-ai/cordis'],
  logLevel: 'info',
})

await build({
  entryPoints: [join(root, 'src/client/index.js')],
  outfile: join(outDir, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // React comes from the shell's frozen module table, never from this bundle:
  // two React copies would break hooks and the renderer's bindings.
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  banner,
  footer,
  logLevel: 'info',
})

console.log(`[build] ${PACKAGE_NAME}: lib/index.js + lib/client.js`)
