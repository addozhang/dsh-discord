## ADDED Requirements

### Requirement: Event-driven assistant-message streaming
The adapter SHALL derive Discord answer output from DSH Session events. Each DSH `assistant/message` in a Turn SHALL own one logical Discord answer message, and its preceding `assistant/chunk` events SHALL update only that logical message. A later Step SHALL NOT overwrite an earlier completed assistant message.

#### Scenario: Assistant streams rapidly
- **WHEN** multiple text-delta chunks for one assistant message arrive within the configured update interval
- **THEN** the adapter publishes only the latest accumulated text in one ordered edit operation

#### Scenario: Turn contains multiple assistant messages
- **WHEN** a tool-using Turn produces an assistant message before a tool call and another assistant message in a later Step
- **THEN** the adapter preserves the completed earlier message and streams the later message into a separate logical answer message

#### Scenario: Interrupted assistant message
- **WHEN** DSH finalizes an `assistant/message` with `interrupted: true`
- **THEN** the adapter preserves its emitted text prefix and marks it interrupted rather than discarding or presenting it as a normal completion

### Requirement: Minimal tool progress presentation
The adapter SHALL present `tool/call` and `tool/result` as bounded progress keyed by `callId`. Milestone 1 SHALL expose only a sanitized title/category and running, succeeded, or failed status; it SHALL NOT expose raw arguments, terminal output, absolute cwd, full file content, or full diffs.

#### Scenario: Tool has a presentation view
- **WHEN** a tool event includes a Host-computed presentation view
- **THEN** the adapter derives only an allowlisted title/category and terminal status from that view

#### Scenario: Tool has no presentation view
- **WHEN** a tool event has no recognized presentation view
- **THEN** the adapter shows a generic bounded status using the escaped tool name and does not dump raw arguments or results

#### Scenario: Parallel tool calls
- **WHEN** multiple tool calls overlap or finish out of order
- **THEN** each visible status remains correlated by `callId` and one result cannot complete another call's row

### Requirement: Discord-safe content splitting
The adapter SHALL split final output within Discord limits while preserving Unicode code points and maintaining balanced Markdown code fences. Every outbound message SHALL disable automatic mention parsing.

#### Scenario: Long fenced-code response
- **WHEN** a final assistant message exceeds one Discord message and contains a fenced code block across a split point
- **THEN** every emitted Discord message is within the configured limit and has valid closed/reopened fences

#### Scenario: Output contains mentions
- **WHEN** assistant or tool text contains `@everyone`, `@here`, a role mention, or a user mention
- **THEN** Discord renders the content without generating those notifications

### Requirement: Authoritative message and Turn finalization
The adapter SHALL treat `assistant/message` as the authoritative completion of its logical message and `turn/end` as the terminal boundary for the Turn. All edits and sends for a Thread SHALL be serialized and guarded by a render generation.

#### Scenario: Late chunk races message completion
- **WHEN** a delayed chunk callback settles after the corresponding `assistant/message` was finalized
- **THEN** it cannot overwrite that finalized Discord message or create a duplicate

#### Scenario: Turn ends without visible assistant text
- **WHEN** a Turn ends after only tool or lifecycle events
- **THEN** the adapter closes typing and activity state exactly once without inventing an assistant answer

### Requirement: Typing lifecycle
The adapter SHALL refresh Discord typing state while a Turn is actively producing work and SHALL stop refreshing it on terminal completion, cancellation, interaction wait, failure, or plugin disposal.

#### Scenario: Agent waits for approval
- **WHEN** DSH emits an approval or question request
- **THEN** typing refresh stops while the interactive component is awaiting the user

### Requirement: Configurable verbosity
The adapter SHALL allow a project channel to choose between text-only, essential-tool, and full-tool progress without changing the DSH Session log.

#### Scenario: Text-only mode
- **WHEN** a channel uses text-only verbosity
- **THEN** tool progress is omitted from Discord while assistant text and terminal status remain available
