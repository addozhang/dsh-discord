## ADDED Requirements

### Requirement: Channel-scoped Workspace binding
The adapter SHALL persist each Workspace binding by Discord application, guild, and project-channel identity rather than by bot identity alone.

#### Scenario: Independent project channels
- **WHEN** two Discord project channels are bound to different Workspaces through the same bot
- **THEN** creating or continuing work in either channel uses only that channel's Workspace

### Requirement: Thread-scoped Session binding
The adapter SHALL persist each ordinary DSH Session binding by Discord application, guild, and thread identity.

#### Scenario: Continue a bound thread
- **WHEN** a message arrives in a Thread with a valid Session binding
- **THEN** the adapter submits it to that exact Session without consulting another channel's current Workspace

### Requirement: Single writable Discord owner
The adapter SHALL permit at most one writable Discord Thread binding for an ordinary Session. Additional Discord surfaces SHALL be rejected or explicitly registered as read-only observers until ownership is transferred.

#### Scenario: Session is already writable elsewhere
- **WHEN** a user attempts to resume a Session already owned by another writable Thread
- **THEN** the adapter refuses the binding or offers an explicit authorized takeover flow rather than silently creating two writers

### Requirement: Durable inbound idempotency
The adapter SHALL atomically claim each Discord event/message identity before starting an external effect and SHALL durably bind that intent to a preallocated DSH Session ID when Session creation is needed and to a stable DSH request ID before prompt submission. The adapter SHALL prefer at-most-once DSH submission when recovery cannot prove whether a prior attempt was accepted.

#### Scenario: Gateway replays an accepted message
- **WHEN** Discord redelivers a message whose durable submission record already exists with the same payload hash
- **THEN** the adapter does not submit a second prompt or create a second Session and reuses the recorded state

#### Scenario: Message identity is reused with different content
- **WHEN** an existing Discord message identity arrives with a different normalized payload hash
- **THEN** the adapter rejects the conflicting delivery without reusing or replacing the prior intent

#### Scenario: Prompt admission outcome is unknown
- **WHEN** a DSH prompt call may have been accepted but no conclusive response or matching queue/history evidence is available
- **THEN** the adapter records `unknown-needs-user-resolution`, does not automatically resubmit, and offers an explicit retry that creates a new intent

### Requirement: Revision-fenced binding transitions
The adapter SHALL use a monotonic binding revision so an asynchronous operation started under an old Channel or Thread binding cannot commit into a newer binding.

#### Scenario: Workspace changes during Session creation
- **WHEN** Session creation for an old Channel binding finishes after that Channel was rebound
- **THEN** the stale result is not installed as the Thread's active Session

### Requirement: Bounded retained state
The adapter SHALL retain completed inbound intents and delivery records for 30 days and resolved interactions for 7 days by default. Configured retention SHALL NOT be shorter than 7 days. Active mappings and unresolved or unknown records SHALL NOT expire automatically. The adapter SHALL provide a Guild-forget operation that removes that Guild's adapter-owned identifiers and mappings without deleting DSH Workspaces or Sessions.

#### Scenario: Guild is forgotten
- **WHEN** an authorized administrator confirms the Guild-forget operation
- **THEN** the adapter removes that Guild's channel, thread, user, role, delivery, and interaction records while leaving DSH state untouched

#### Scenario: Retention deadline passes
- **WHEN** a completed idempotency or interaction record exceeds its applicable retention period and is no longer needed by the seven-day minimum reconciliation horizon
- **THEN** the adapter removes it without removing active mappings or unconfirmed delivery state

### Requirement: Corrupt state fails closed
The adapter SHALL validate its persisted state before use and SHALL NOT accept Discord-triggered DSH writes when the applicable state cannot be read or validated.

#### Scenario: State database is corrupt
- **WHEN** the adapter cannot validate or open its durable state database
- **THEN** it leaves the Discord runtime unavailable, reports an actionable local diagnostic, and does not replace the database or start with empty mappings automatically
