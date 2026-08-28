/**
 * Minimal snapshot store matching the client runtime's `SnapshotStore`
 * contract. The runtime's `/client` artifact is a browser-only lazy-CJS
 * factory, so the card implements the same interface locally and imports the
 * contract type only.
 */

import { produce } from 'immer'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Create an immutable-snapshot store with synchronous notification. */
export function createLocalSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let current = initial
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(mutator) {
      const next = produce(current, mutator)
      if (next !== current) {
        current = next
        notify()
      }
    },
    set(next) {
      current = next
      notify()
    },
  }
}
