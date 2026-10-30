/**
 * Packaging guards (16.106): the published plugin must never carry a
 * `@deepseek-ai/dsh-*` host-internal package as a runtime dependency.
 *
 * History: shipping `@deepseek-ai/dsh-storage-domain` as a hard dependency
 * let pnpm hoist a plugin-owned copy over the profile tree. Since 0.2.1-rc.5
 * the host disables any profile row whose version does not exactly match the
 * runtime, so every host patch release cascaded `storageDomain` away and
 * pended the workspace/session graph. `dsh-base` already provides the row at
 * the host's exact version; the plugin must consume the service, not ship a
 * second copy of it.
 *
 * Two guards:
 *  1. `dependencies` contains no `@deepseek-ai/dsh-*` entry (host-internal
 *     packages only ever appear as devDependencies for types and drift tests).
 *  2. `src/` imports of `@deepseek-ai/dsh-*` are `import type`/`export type`
 *     only — erased at build time, never resolved from the profile tree.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}

const DSH_INTERNAL = /^@deepseek-ai\/dsh-/

describe('host-internal packages stay out of the published dependency set', () => {
  it('declares no @deepseek-ai/dsh-* runtime dependency', () => {
    const offenders = Object.keys(pkg.dependencies ?? {}).filter((name) => DSH_INTERNAL.test(name))
    expect(
      offenders,
      'host-internal packages in dependencies shadow the host profile rows and ' +
        'trip the exact-version compatibility gate on every host upgrade; ' +
        'move them to devDependencies and consume the service instead',
    ).toEqual([])
  })
})

function walkSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walkSources(full, found)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      found.push(full)
    }
  }
  return found
}

interface SourceImport {
  file: string
  module: string
  runtime: boolean
}

/** Collect every import/export-from of a @deepseek-ai/dsh-* module in src/. */
function scanSourceImports(): SourceImport[] {
  const imports: SourceImport[] = []
  /** One import-statement pattern: which group is the module, which the `type ` flag. */
  interface ImportPattern {
    re: RegExp
    moduleGroup: number
    typeGroup: number | undefined
  }
  const patterns: ImportPattern[] = [
    // `import … from '…'` (possibly multiline) — runtime unless led by `type`.
    // The clause excludes quotes/semicolons so it cannot absorb a previous
    // import statement and misread a later type-only import as runtime.
    { re: /import\s+(type\s+)?[^;'"]*from\s+['"](@deepseek-ai\/dsh-[^'"]+)['"]/g, moduleGroup: 2, typeGroup: 1 },
    // Side-effect import — always runtime.
    { re: /import\s+['"](@deepseek-ai\/dsh-[^'"]+)['"]/g, moduleGroup: 1, typeGroup: undefined },
    // `export … from '…'` re-export — runtime unless led by `type`.
    { re: /export\s+(type\s+)?[^;'"]*from\s+['"](@deepseek-ai\/dsh-[^'"]+)['"]/g, moduleGroup: 2, typeGroup: 1 },
  ]
  for (const { re, moduleGroup, typeGroup } of patterns) {
    for (const file of walkSources(join(repoRoot, 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(re)) {
        const module = match[moduleGroup]
        if (module === undefined) continue
        imports.push({
          file: file.slice(repoRoot.length),
          module,
          runtime: typeGroup === undefined || match[typeGroup] !== 'type ',
        })
      }
    }
  }
  return imports
}

describe('src keeps @deepseek-ai/dsh-* imports type-only', () => {
  it('resolves no host-internal package at plugin runtime', () => {
    const runtime = scanSourceImports().filter((entry) => entry.runtime)
    expect(
      runtime.map((entry) => `${entry.file}: ${entry.module}`),
      'runtime imports of host-internal packages resolve to whatever copy pnpm ' +
        'places in the profile tree and break under the exact-version gate; ' +
        'inline the runtime values (see src/state/domain.ts) and import types only',
    ).toEqual([])
  })
})
