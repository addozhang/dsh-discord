/**
 * Per-route delivery queues with nonce delivery identity. Writes to one
 * Discord route (a channel, an interaction token) serialize FIFO so edits can
 * never reorder terminal output; distinct routes proceed concurrently. A
 * nonce identifies one in-process delivery claim and cannot be reused while
 * known, which turns a double-send race into a loud local failure instead of
 * duplicate Discord output.
 */

/** A unique in-process delivery identity; the durable layer binds it to intent records. */
export interface DeliveryIdentity {
  nonce: string
}

export interface RouteQueues {
  /**
   * Run `op` serialized after every unsettled op previously enqueued on the
   * same route. Rejects when `identity.nonce` collides with an op that has
   * not settled yet.
   */
  enqueue<T>(route: string, op: () => Promise<T>, identity: DeliveryIdentity): Promise<T>
}

export function createRouteQueues(): RouteQueues {
  const activeNonces = new Map<string, Promise<unknown>>()
  const tails = new Map<string, Promise<void>>()

  function enqueue<T>(route: string, op: () => Promise<T>, identity: DeliveryIdentity): Promise<T> {
    if (activeNonces.has(identity.nonce)) {
      throw new TypeError(`delivery nonce '${identity.nonce}' is still known; duplicate claims are refused`)
    }

    const tail = tails.get(route) ?? Promise.resolve()
    const run = tail.then(op, op)
    // A failed op must not poison its route's tail.
    tails.set(route, run.then(() => undefined, () => undefined))

    // The release is registered before the caller can observe `run`, so a
    // nonce is always forgettable by the time the caller's await resumes.
    const release = () => {
      if (activeNonces.get(identity.nonce) === run) activeNonces.delete(identity.nonce)
    }
    void run.then(release, release)
    activeNonces.set(identity.nonce, run)
    return run
  }

  return { enqueue }
}
