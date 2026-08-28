/**
 * Bundle the plugin's browser half into a dsh client-module: a lazy CJS
 * factory registered on the browser's __ModuleLoader__ (the loader imports
 * /plugins/<pkg>/client.js and expects exactly one load() call). Cross-plugin
 * packages stay external — the browser module graph resolves them at
 * runtime; libraries (immer) are inlined.
 */

import { writeFile } from 'node:fs/promises'

import { build } from 'esbuild'

const loaderId = '@addozhang/dsh-discord'

const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  minify: false,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-settings',
    'react',
  ],
  write: false,
  legalComments: 'none',
})

const bundled = result.outputFiles?.[0]?.text
if (bundled === undefined) throw new Error('esbuild did not produce a client bundle')

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`

await writeFile('lib/client.js', wrapped, 'utf8')
console.log(`Wrote lib/client.js (loader id: ${loaderId})`)
