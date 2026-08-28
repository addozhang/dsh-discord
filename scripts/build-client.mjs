/**
 * Bundle the plugin's browser half. Cross-plugin packages stay external —
 * the browser module graph resolves them at runtime; libraries (immer) are
 * inlined.
 */

import { build } from 'esbuild'

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'esm',
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
})
