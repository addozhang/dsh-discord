/**
 * The Discord Gateway state machine, driven entirely through an injected
 * socket factory so every behavior is testable with fake sockets and fake
 * clocks. One instance owns at most one live socket; every generation change
 * (reconnect or replacement) invalidates all callbacks captured by the
 * previous socket, so a stale close can never schedule duplicate reconnects
 * or deliver events after disposal.
 */

/** The subset of the WebSocket face the machine uses. */
export interface GatewaySocket {
  readonly url: string
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  onopen: (() => void) | null
  onmessage: ((data: string) => void) | null
  onclose: ((code: number) => void) | null
  onerror: ((error: Error) => void) | null
}

export type GatewaySocketFactory = (url: string) => GatewaySocket

/** One forwarded Gateway dispatch frame (opcode 0). */
export interface GatewayDispatch {
  t: string
  s: number | null
  op: number
  d: unknown
}

export interface GatewayOptions {
  url: string
  /** Resolved per connection attempt; never retained between attempts. */
  tokenProvider: () => Promise<string>
  /** Gateway intent bitmask to identify with. */
  intents: number
  socketFactory: GatewaySocketFactory
  /** Every validated opcode-0 dispatch, including READY. */
  onDispatch(event: GatewayDispatch): void
  /** A terminal close code was received; the machine will not reconnect. */
  onTerminalClose(code: number): void
  /** A reconnect was scheduled; attempt is 1-based. */
  onBackoffScheduled?(attempt: number, delayMs: number): void
  /** First retry delay; doubles per attempt up to `backoffCapMs`. */
  backoffBaseMs?: number
  backoffCapMs?: number
}

/** Close codes Discord defines as non-recoverable for this session shape. */
export const TERMINAL_CLOSE_CODES: readonly number[] = [4004, 4010, 4011, 4012, 4013, 4014]

const OPCODE_DISPATCH = 0
const OPCODE_HEARTBEAT = 1
const OPCODE_IDENTIFY = 2
const OPCODE_RESUME = 6
const OPCODE_RECONNECT = 7
const OPCODE_INVALID_SESSION = 9
const OPCODE_HELLO = 10
const OPCODE_HEARTBEAT_ACK = 11

/** A recoverable close code: Discord allows session resume. */
const RECOVERABLE_CLOSE = 4000

interface WireFrame {
  op?: unknown
  t?: unknown
  s?: unknown
  d?: unknown
}

export interface GatewayHandle {
  dispose(): void
}

export function startGateway(options: GatewayOptions): GatewayHandle {
  const backoffBaseMs = options.backoffBaseMs ?? 1_000
  const backoffCapMs = options.backoffCapMs ?? 60_000

  let disposed = false
  let generation = 0
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatAcked = true
  let lastSeq: number | null = null
  let sessionId: string | undefined
  let backoffAttempt = 0
  let currentSocket: GatewaySocket | undefined

  function clearTimers(): void {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
  }

  function send(socket: GatewaySocket, op: number, d: unknown): void {
    socket.send(JSON.stringify({ op, d }))
  }

  function connect(): void {
    if (disposed) return
    generation += 1
    const liveGeneration = generation
    heartbeatAcked = true

    void options.tokenProvider().then((token) => {
      if (disposed || liveGeneration !== generation) return
      const socket = options.socketFactory(options.url)
      currentSocket = socket

      socket.onopen = () => {
        if (disposed || liveGeneration !== generation) return
      }
      socket.onmessage = (data) => {
        if (disposed || liveGeneration !== generation) return
        handleFrame(socket, data, token, liveGeneration)
      }
      socket.onclose = (code) => {
        if (disposed || liveGeneration !== generation) return
        handleClose(code)
      }
      socket.onerror = () => {
        if (disposed || liveGeneration !== generation) return
        // The close frame follows with the real code; nothing to do here.
      }
    }).catch(() => {
      // Token resolution failed: recoverable, retry through the same backoff.
      if (disposed || liveGeneration !== generation) return
      handleClose(RECOVERABLE_CLOSE)
    })
  }

  function handleFrame(socket: GatewaySocket, data: string, token: string, liveGeneration: number): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const frame = parsed as WireFrame
    if (typeof frame['op'] !== 'number') return

    switch (frame['op']) {
      case OPCODE_HELLO: {
        const hello = frame['d']
        if (typeof hello !== 'object' || hello === null) return
        const interval = (hello as Record<string, unknown>)['heartbeat_interval']
        if (typeof interval !== 'number' || interval <= 0) return
        heartbeatAcked = true
        // A resumed session re-receives HELLO: retire the old timer first so
        // intervals never stack.
        if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
        heartbeatTimer = setInterval(() => {
          if (disposed || liveGeneration !== generation) return
          if (!heartbeatAcked) {
            currentSocket?.terminate()
            return
          }
          heartbeatAcked = false
          send(socket, OPCODE_HEARTBEAT, lastSeq)
        }, interval)
        if (sessionId !== undefined) {
          send(socket, OPCODE_RESUME, { token, session_id: sessionId, seq: lastSeq })
        } else {
          send(socket, OPCODE_IDENTIFY, { token, intents: options.intents })
        }
        return
      }
      case OPCODE_HEARTBEAT_ACK: {
        heartbeatAcked = true
        return
      }
      case OPCODE_DISPATCH: {
        const seq = frame['s']
        if (typeof seq === 'number') lastSeq = seq
        const type = frame['t']
        const payload = frame['d']
        if (type === 'READY' && typeof payload === 'object' && payload !== null) {
          const id = (payload as Record<string, unknown>)['session_id']
          if (typeof id === 'string') sessionId = id
          backoffAttempt = 0
        }
        options.onDispatch({
          t: typeof type === 'string' ? type : '',
          s: typeof seq === 'number' ? seq : null,
          op: OPCODE_DISPATCH,
          d: payload,
        })
        return
      }
      case OPCODE_RECONNECT: {
        // Server-requested recycle: closing drives the resume path.
        currentSocket?.close(RECOVERABLE_CLOSE)
        return
      }
      case OPCODE_INVALID_SESSION: {
        if (frame['d'] !== true) {
          // Not resumable: forget the session so the next HELLO identifies fresh.
          sessionId = undefined
          lastSeq = null
        }
        // Discord closes the socket right after op 9; that close reconnects.
        currentSocket?.close(RECOVERABLE_CLOSE)
        return
      }
      default:
    }
  }

  function handleClose(code: number): void {
    clearTimers()
    if (disposed) return
    if (TERMINAL_CLOSE_CODES.includes(code)) {
      options.onTerminalClose(code)
      return
    }
    backoffAttempt += 1
    const delayMs = Math.min(backoffBaseMs * 2 ** (backoffAttempt - 1), backoffCapMs)
    options.onBackoffScheduled?.(backoffAttempt, delayMs)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delayMs)
  }

  connect()

  return {
    dispose() {
      if (disposed) return
      disposed = true
      clearTimers()
      generation += 1
      currentSocket?.close(1000, 'plugin disposal')
      currentSocket = undefined
    },
  }
}
