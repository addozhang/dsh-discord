/**
 * `/host status` and the process-management refusal (design.md Non-Goals,
 * task 10.5). The adapter reports connectivity and version metadata and does
 * nothing else to its host: start/stop/restart/upgrade requests refuse
 * explicitly and ephemerally — the embedded adapter cannot manage the
 * process it lives in.
 */

export interface DshHostPort {
  status(): Promise<
    | { outcome: 'completed'; connected: boolean; version: string | undefined }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
}

export type HostStatusView =
  | { outcome: 'ok'; connected: boolean; version: string | undefined }
  | { outcome: 'failed'; reason: 'host-status-unavailable' | 'host-status-unknown' }

export async function hostStatus(port: DshHostPort): Promise<HostStatusView> {
  const status = await port.status()
  if (status.outcome === 'failed') return { outcome: 'failed', reason: 'host-status-unavailable' }
  if (status.outcome === 'unknown') return { outcome: 'failed', reason: 'host-status-unknown' }
  return { outcome: 'ok', connected: status.connected, version: status.version }
}

export type ProcessActionResult = {
  outcome: 'refused'
  reason: 'process-management-unavailable'
  response: 'ephemeral'
}

/**
 * Refuse any host process action. The optional control surface exists only
 * so tests can prove the refusal never reaches for it.
 */
export function planProcessAction(
  request: { action: 'start' | 'stop' | 'restart' | 'upgrade' },
  deps: { processControl?: (...args: never[]) => unknown } = {},
): Promise<ProcessActionResult> {
  void request
  void deps
  return Promise.resolve({ outcome: 'refused', reason: 'process-management-unavailable', response: 'ephemeral' })
}
