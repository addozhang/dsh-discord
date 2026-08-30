/**
 * Sanitized adapter status for the settings surface (design.md §3, task 2.3;
 * plugin-foundation spec). The Host distills credential presence and Gateway
 * observations into one small value — machine-readable condition plus a
 * stable hint key the card resolves to copy — that by construction has no
 * slot for the token or any raw provider response. The value reaches the Web
 * card through the plugin's loopback RPC channel, the same seam dsh
 * establishes for plugin management surfaces.
 */

/** Credential presence for the fixed bot-token reference (never its value). */
export type TokenPresence = 'configured' | 'unconfigured'

/** What the Gateway is doing, distilled from the composition layer's watches. */
export type GatewayObservation =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | { kind: 'terminal-close'; code: number }

/** Non-connection facts worth surfacing (channel permissions, 5.x territory). */
export type StatusDetail = 'missing-channel-permissions'

/** The conditions the settings surface can name. */
export type ConnectionCondition =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'invalid-token'
  | 'intents-blocked'
  | 'permissions-blocked'

/** Stable hint keys; the card owns the human copy. */
export type StatusHint =
  | 'configure-token'
  | 'token-rejected'
  | 'enable-intents'
  | 'gateway-closed'
  | 'channel-permissions'

export interface AdapterStatusView {
  token: TokenPresence
  connection: ConnectionCondition
  hint?: StatusHint | undefined
}

export interface AdapterStatusInput {
  token: TokenPresence
  gateway: GatewayObservation
  detail?: StatusDetail | undefined
}

/** Discord's authentication-failure close: the token itself is rejected. */
const AUTH_FAILURE_CLOSE = 4004
/** Discord's invalid/disallowed-intent closes: the config, not the token. */
const INTENT_REJECTION_CLOSES: ReadonlySet<number> = new Set([4013, 4014])

export function projectAdapterStatus(input: AdapterStatusInput): AdapterStatusView {
  if (input.token === 'unconfigured') {
    return { token: input.token, connection: 'disconnected', hint: 'configure-token' }
  }

  if (input.detail === 'missing-channel-permissions' && input.gateway !== 'connected') {
    return { token: input.token, connection: 'permissions-blocked', hint: 'channel-permissions' }
  }

  if (typeof input.gateway === 'object') {
    if (input.gateway.code === AUTH_FAILURE_CLOSE) {
      return { token: input.token, connection: 'invalid-token', hint: 'token-rejected' }
    }
    if (INTENT_REJECTION_CLOSES.has(input.gateway.code)) {
      return { token: input.token, connection: 'intents-blocked', hint: 'enable-intents' }
    }
    return { token: input.token, connection: 'disconnected', hint: 'gateway-closed' }
  }

  // connected / connecting / disconnected-by-observation carry no hint of
  // their own: nothing actionable has been observed yet.
  return { token: input.token, connection: input.gateway }
}

/** Latest observed facts; the projection is always derivable on demand. */
export interface AdapterStatusTracker {
  setCredential(view: { configured: boolean; source?: string; writable?: boolean }): void
  setGateway(observation: GatewayObservation): void
  setDetail(detail: StatusDetail | undefined): void
  project(): AdapterStatusView
}

export function createAdapterStatusTracker(): AdapterStatusTracker {
  let token: TokenPresence = 'unconfigured'
  let gateway: GatewayObservation = 'disconnected'
  let detail: StatusDetail | undefined = undefined

  return {
    setCredential(view) {
      token = view.configured ? 'configured' : 'unconfigured'
    },
    setGateway(observation) {
      gateway = observation
    },
    setDetail(next) {
      detail = next
    },
    project() {
      return projectAdapterStatus({ token, gateway, ...(detail === undefined ? {} : { detail }) })
    },
  }
}

/** The plugin RPC channel; the client bundle calls the same constant. */
export const DISCORD_RPC_CHANNEL = '/dsh-discord'
/** The one endpoint this channel serves. */
export const STATUS_ENDPOINT = 'adapter.status'

/** The Host connection service's RPC face (duck-typed; dsh owns the real type). */
export interface ConnectionRpc {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: { aborted: boolean } | undefined) => Promise<
        | { ok: true; value: unknown }
        | { ok: false; error: { code: string; message: string } }
      >,
      options: { authority: 'loopback' | 'trusted-host' },
    ): () => void
  }
}

type RpcAnswer =
  | { ok: true; value: AdapterStatusView | Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } }

/**
 * The channel's handler: exactly one endpoint, value-shaped failures, and no
 * access to anything beyond the projection.
 */
export function createAdapterStatusRpcHandler(tracker: AdapterStatusTracker) {
  return createAdapterManagementHandler({ tracker })
}

/** Extra host faces the management channel can exercise. */
export interface ManagementChannelDeps {
  tracker: AdapterStatusTracker
  /** Store the bot token into the writable credential layer. */
  setToken?: ((value: string) => Promise<void>) | undefined
  /** Re-run the adapter start chain (the card's Connect button). */
  connect?: (() => void) | undefined
  /** Operator-initiated offline (the card's Disconnect button). */
  disconnect?: (() => void) | undefined
  /** Guilds the bot is a member of, sanitized (id + name only). */
  guilds?: (() => Promise<Array<{ id: string; name: string }>>) | undefined
}

/**
 * The management channel's handler: status (with guild names when
 * discoverable), credential write, and a connect trigger. Unknown endpoints
 * fail as values; nothing here can read the token back.
 */
export function createAdapterManagementHandler(deps: ManagementChannelDeps) {
  return (
    endpoint: string,
    payload: unknown,
    signal: { aborted: boolean } | undefined,
  ): Promise<RpcAnswer> => {
    if (signal?.aborted) {
      return Promise.resolve({ ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } })
    }
    if (endpoint === STATUS_ENDPOINT) {
      if (deps.guilds === undefined) return Promise.resolve({ ok: true, value: deps.tracker.project() })
      return deps.guilds().then(
        (guilds) => ({ ok: true as const, value: { ...deps.tracker.project(), guilds } }),
        () => ({ ok: true as const, value: deps.tracker.project() }),
      )
    }
    if (endpoint === 'adapter.connect' && deps.connect !== undefined) {
      deps.connect()
      return Promise.resolve({ ok: true, value: { connecting: true } })
    }
    if (endpoint === 'adapter.disconnect' && deps.disconnect !== undefined) {
      deps.disconnect()
      return Promise.resolve({ ok: true, value: { stopped: true } })
    }
    if (endpoint === 'credentials.set' && deps.setToken !== undefined) {
      const value = (payload as { value?: unknown } | undefined)?.value
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') {
        return Promise.resolve({ ok: false, error: { code: 'bad-request', message: 'empty token' } })
      }
      return deps.setToken(text).then(
        () => ({ ok: true as const, value: { saved: true } }),
        (cause: unknown) => ({ ok: false as const, error: { code: 'credential-rejected', message: String(cause) } }),
      )
    }
    return Promise.resolve({ ok: false, error: { code: 'bad-request', message: `Unknown ${DISCORD_RPC_CHANNEL} endpoint.` } })
  }
}

/** Register the management channel; returns the connection service's disposer. */
export function installAdapterStatusRpc(
  connection: ConnectionRpc,
  tracker: AdapterStatusTracker,
  deps: ManagementChannelDeps = { tracker },
): () => void {
  return connection.rpc.handle(DISCORD_RPC_CHANNEL, createAdapterManagementHandler(deps), {
    authority: 'loopback',
  })
}
