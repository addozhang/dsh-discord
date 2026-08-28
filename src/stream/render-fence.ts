/**
 * Render generation and terminal fences (design.md §8, task 11.4). Every
 * async edit belongs to a generation; a late chunk from a superseded
 * generation is dropped, never overwriting newer output. `finalize` is the
 * terminal fence: it freezes the final content, and after it nothing —
 * stale or current — mutates what Discord saw.
 */

export interface PublishResult {
  published: boolean
  visible: string
}

export type FinalizeResult =
  | { ok: true }
  | { ok: false; error: 'stale-generation' | 'already-final' }

export interface RenderFence {
  /** Open a new generation and return its id. */
  beginGeneration(): number
  current(): number
  visible(): string
  isFinal(): boolean
  publish(content: string, generation: number): PublishResult
  finalize(generation: number, finalContent: string): FinalizeResult
}

export function createRenderFence(): RenderFence {
  let generation = 0
  let visible = ''
  let final = false

  return {
    beginGeneration() {
      generation += 1
      return generation
    },
    current: () => generation,
    visible: () => visible,
    isFinal: () => final,

    publish(content, gen) {
      if (final || gen !== generation) {
        return { published: false, visible }
      }
      visible = content
      return { published: true, visible }
    },

    finalize(gen, finalContent) {
      if (final) return { ok: false, error: 'already-final' }
      if (gen !== generation) return { ok: false, error: 'stale-generation' }
      visible = finalContent
      final = true
      return { ok: true }
    },
  }
}
