## ADDED Requirements

### Requirement: Authoritative startup reconciliation
The adapter SHALL reconcile persisted mappings against current Discord resources and DSH `workspace.list` and `session.list` results before accepting writes for those mappings.

#### Scenario: Persisted Session no longer exists
- **WHEN** startup finds a Thread mapping whose Session is absent from DSH
- **THEN** the mapping is marked detached and the adapter does not silently create a replacement Session

#### Scenario: Persisted Thread no longer exists
- **WHEN** startup finds a Session mapping whose Discord Thread is confirmed deleted
- **THEN** the adapter retires the writable binding without deleting the DSH Session

#### Scenario: Discord resource check is inconclusive
- **WHEN** Discord temporarily refuses or times out while checking a persisted Channel or Thread
- **THEN** the adapter retains the mapping as unverified, blocks unsafe writes for it, and retries reconciliation instead of treating the resource as deleted

### Requirement: Stream reconnection and history compensation
The adapter SHALL reopen DSH event streams after disconnect and SHALL use `session.history` plus persisted sequence watermarks to recover missed durable events.

#### Scenario: Events occur while mux is disconnected
- **WHEN** a bound Session produces durable events during a mux outage
- **THEN** reconnect reconciliation reads history, emits each missing visible effect at most once, and advances the watermark only after its Discord delivery outcome is durably recorded

#### Scenario: History contains an accepted Discord prompt
- **WHEN** reconciliation finds a `user/message` whose source `rpcId` equals a persisted uncertain Discord submission
- **THEN** the adapter marks that submission accepted and does not submit it again

### Requirement: Uncertain DSH prompt admission
The adapter SHALL preserve an inconclusive DSH prompt call as `unknown-needs-user-resolution` until history or queue evidence proves acceptance. It SHALL NOT automatically resubmit the prompt.

#### Scenario: Prompt times out after DSH may have accepted it
- **WHEN** a DSH prompt request ends without a conclusive response and no matching history or queue evidence is available
- **THEN** the adapter records the unknown state, avoids automatic resubmission, and offers an explicit retry that creates a new intent

### Requirement: Uncertain Discord delivery handling
The adapter SHALL distinguish confirmed success, confirmed failure, and unknown Discord delivery outcomes and SHALL NOT blindly resend after an unknown result.

#### Scenario: Send times out after Discord may have accepted it
- **WHEN** a Discord send request ends without a known provider result
- **THEN** the adapter records an uncertain delivery and attempts bounded lookup or reconciliation before any replacement send

### Requirement: Pending interaction reconciliation
The adapter SHALL reconcile replayed DSH question and approval requests with local ownership and current Discord controls.

#### Scenario: Interaction was resolved elsewhere
- **WHEN** a resolved frame or a rejected `respond` receipt shows that another client answered the request
- **THEN** the adapter disables its stale controls and reports the request as already resolved

### Requirement: Bounded recovery
The adapter SHALL bound history pages, retries, concurrent reconciliations, and retained delivery records.

#### Scenario: Large history gap
- **WHEN** a Session has more missed events than the configured recovery event or page limit
- **THEN** reconciliation stops at the bound, preserves its last confirmed watermark, marks the Thread recovery incomplete, and requires an explicit continuation or fresh bounded pass
