/**
 * Opaque component-id correlation for Discord components and modals. The
 * custom_id Discord echoes back carries none of the adapter's DSH identifiers
 * — only a registry key — so session, approval, question, and request data
 * never appear on the Discord wire. Resolution returns the exact pending
 * context idempotently until its expiry; actor and business validation stay
 * with the callers, who own what they register.
 */

/** Arbitrary JSON-safe correlation context. */
export type ComponentContext = Record<string, unknown>

export interface RegistryOptions {
  /** Injectable opaque-id source for deterministic tests. */
  idFactory?: () => string
  /** custom_id prefix; Discord allows 100 characters total. */
  prefix?: string
}

export type ComponentResolution =
  | { found: true; context: ComponentContext }
  | { found: false }

interface RegisteredComponent {
  context: ComponentContext
  expiresAtMs: number
}

const DEFAULT_PREFIX = 'dc'
const DISCORD_CUSTOM_ID_MAX = 100

export function createComponentRegistry(options: RegistryOptions = {}): {
  register(context: ComponentContext): string
  resolve(customId: string, atMs: number): ComponentResolution
  purgeExpired(atMs: number): number
} {
  const prefix = options.prefix ?? DEFAULT_PREFIX
  let fallbackCounter = 0
  const nextId = options.idFactory ?? (() => {
    fallbackCounter += 1
    return `${Date.now().toString(36)}-${String(fallbackCounter)}`
  })

  const entries = new Map<string, RegisteredComponent>()

  function register(context: ComponentContext): string {
    let customId = `${prefix}:${nextId()}`
    while (entries.has(customId)) customId = `${prefix}:${nextId()}`
    if (customId.length > DISCORD_CUSTOM_ID_MAX) {
      throw new TypeError(`custom_id exceeds Discord's ${String(DISCORD_CUSTOM_ID_MAX)}-character limit`)
    }
    const expiresAtMs = context['expiresAtMs']
    if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) {
      throw new TypeError('component context requires a numeric expiresAtMs')
    }
    entries.set(customId, { context, expiresAtMs })
    return customId
  }

  function resolve(customId: string, atMs: number): ComponentResolution {
    const entry = entries.get(customId)
    if (entry === undefined) return { found: false }
    if (atMs >= entry.expiresAtMs) {
      // Lazy expiry: the first observation past the deadline retires the
      // entry, so a stale clock can never resurrect a consumed control.
      entries.delete(customId)
      return { found: false }
    }
    return { found: true, context: entry.context }
  }

  function purgeExpired(atMs: number): number {
    let purged = 0
    for (const [customId, entry] of entries) {
      if (atMs >= entry.expiresAtMs) {
        entries.delete(customId)
        purged += 1
      }
    }
    return purged
  }

  return { register, resolve, purgeExpired }
}
