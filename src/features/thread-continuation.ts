/**
 * Ordinary thread continuation (design.md §5, task 8.5). Every normal message
 * in an adapter-owned thread submits through `session.prompt` with
 * `mode: 'queue'` — the queue is what makes idle and busy sessions equally
 * safe, and ordinary messages never improvise steer or stop semantics
 * (those are the explicit `/steer` and `/stop` commands).
 */

export interface DshPromptPort {
  submit(request: {
    requestId: string
    sessionId: string
    prompt: string
    mode: 'queue'
  }): Promise<
    | { outcome: 'queued'; position: number }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export type ContinuationResult =
  | { outcome: 'queued'; position: number }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }

export async function continueThread(
  prompts: DshPromptPort,
  request: { sessionId: string; messageId: string; content: string },
): Promise<ContinuationResult> {
  const submitted = await prompts.submit({
    requestId: request.messageId,
    sessionId: request.sessionId,
    prompt: request.content,
    mode: 'queue',
  })
  if (submitted.outcome === 'queued') return { outcome: 'queued', position: submitted.position }
  return submitted.outcome === 'rejected' ? { outcome: 'rejected' } : { outcome: 'unknown' }
}
