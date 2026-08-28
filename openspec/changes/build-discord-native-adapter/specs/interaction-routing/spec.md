## ADDED Requirements

### Requirement: One-shot approval controls
The adapter SHALL render pending DSH approvals as Discord Allow once and Reject buttons and SHALL submit only `allowed-once` or `rejected` through the original request `rpcId`.

#### Scenario: Authorized user allows once
- **WHEN** an authorized interaction owner clicks Allow once on a pending approval
- **THEN** the adapter atomically claims the interaction, sends the matching `sessionId`, `approvalId`, and outcome through `apiProxy.respond`, and disables the controls

#### Scenario: Unsupported persistent approval
- **WHEN** a user requests an always-allow decision
- **THEN** the adapter states that persistent approval is unavailable in this milestone and does not synthesize one from repeated one-shot approvals

### Requirement: Native question controls
The adapter SHALL render DSH questions using select menus for bounded choices and modals or controlled text replies for custom answers, preserving question IDs, selected labels, custom text, and multi-select semantics.

#### Scenario: Multi-question request
- **WHEN** DSH asks multiple questions in one request
- **THEN** the adapter collects a valid answer for every required question before submitting one complete response

### Requirement: Interaction ownership
The adapter SHALL bind every pending interaction to the DSH Session, Discord Thread, originating request/Turn, and the Discord user who submitted that Turn. Only that originating user SHALL answer it in Milestone 1; unrelated Threads, other authorized members, and administrators SHALL NOT answer it.

#### Scenario: Unauthorized component click
- **WHEN** anyone other than the Discord user who submitted the owning Turn clicks a pending approval or question component
- **THEN** the adapter returns an ephemeral denial and leaves the interaction pending

### Requirement: Atomic resolution
The adapter SHALL ensure only one answer wins and SHALL handle already-resolved requests idempotently.

#### Scenario: Concurrent button clicks
- **WHEN** two valid component submissions race for the same pending interaction
- **THEN** only one reaches DSH and the other receives an already-resolved response

#### Scenario: Interaction is resolved elsewhere
- **WHEN** DSH reports that a pending interaction was resolved by another client
- **THEN** the adapter disables its local controls and does not submit another response

### Requirement: Approval timeout fails closed
The adapter SHALL apply a bounded lifetime to an unanswered approval and SHALL attempt to reject it before expiring local controls.

#### Scenario: Approval expires
- **WHEN** the configured approval deadline passes while the request remains pending
- **THEN** the adapter atomically claims it, submits `rejected`, and marks the Discord controls expired only after the response outcome is recorded

### Requirement: Question timeout cancels the Turn
The adapter SHALL NOT discard an unanswered question while leaving its DSH tool call waiting. On question timeout, it SHALL request cancellation of the owning adapter-controlled Turn and then expire the Discord controls.

#### Scenario: Question expires
- **WHEN** the configured question deadline passes while the request remains pending
- **THEN** the adapter requests cancellation of the owning Turn, records whether cancellation was accepted, and disables the controls without claiming that an answer was submitted

### Requirement: Host restart invalidates unrecoverable interactions
The adapter SHALL distinguish a stream reconnect, where DSH may replay pending interactions, from a Host process restart, where pending questions may no longer be answerable.

#### Scenario: Host restart invalidates pending request
- **WHEN** the Host generation changes and a prior interaction is not present in the new pending baseline
- **THEN** the adapter disables or expires its Discord controls and does not claim that a response was applied
