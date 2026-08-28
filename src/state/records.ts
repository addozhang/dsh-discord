/**
 * Binding record schemas, validated by zod at the durable boundary. The
 * schemas are strict: unknown fields reject, so state written by a newer
 * format fails closed instead of silently half-decoding.
 */

import { z } from 'zod'

/** One channel-to-workspace binding; `revision` fences stale writes (6.2). */
export const ChannelBindingRecord = z.strictObject({
  workspaceId: z.string().min(1),
  revision: z.number().int().min(1),
  /** Discord user id that performed the bind. */
  boundBy: z.string().min(1),
  boundAtMs: z.number().int().min(0),
})

export type ChannelBinding = z.infer<typeof ChannelBindingRecord>

/** One thread-to-session writable binding; `revision` fences stale writes. */
export const ThreadBindingRecord = z.strictObject({
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  revision: z.number().int().min(1),
  createdBy: z.string().min(1),
  createdAtMs: z.number().int().min(0),
})

export type ThreadBinding = z.infer<typeof ThreadBindingRecord>
