/**
 * The adapter's own package version, read at load time from the
 * package.json that always sits next to lib/ in the installed tree.
 * Surfaced by /info and the settings-card RPC for support and discovery.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json')
export const ADAPTER_VERSION: string = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version
export const REPO_URL = 'https://github.com/addozhang/dsh-discord' as const
