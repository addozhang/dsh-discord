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
The adapter SHALL present `tool/call` and `tool/result` as one bounded activity message per turn, keyed by `callId`. A row's content SHALL be the Host-computed presentation view's title (for a terminal call, the command itself; otherwise the call title) next to the category icon, truncated to the adapter's row budget; rows SHALL NOT carry run-state marks. The adapter SHALL NOT expose raw arguments beyond the Host-presented title, terminal output, absolute cwd, full file content, or full diffs, and SHALL delete the activity message when the Turn ends — the durable record of what happened is the Session log and the assistant's answer, not a live status message.

#### Scenario: Tool has a presentation view
- **WHEN** a tool event includes a Host-computed presentation view
- **THEN** the row shows the view's title (for a terminal call, the command) beside the category icon, sanitized and truncated

#### Scenario: Tool has no presentation view
- **WHEN** a tool event has no recognized presentation view
- **THEN** the row shows the generic category icon with the escaped tool label and never dumps raw arguments or results

#### Scenario: Parallel tool calls
- **WHEN** multiple tool calls overlap or finish out of order
- **THEN** each row stays correlated by `callId` and one result cannot mutate another call's row

#### Scenario: Activity message is removed at Turn end
- **WHEN** the Turn ends
- **THEN** the adapter deletes the turn's activity message exactly once; a turn with no tool activity deletes nothing

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
The adapter SHALL refresh Discord typing state while a Turn is actively producing work and also while a submitted prompt is queued for one (the admission-to-first-event window), and SHALL stop refreshing it on terminal completion, cancellation, interaction wait, failure, or plugin disposal.

#### Scenario: Prompt queues before the turn starts
- **WHEN** DSH accepts a prompt and its queue snapshot becomes non-empty with no turn open
- **THEN** typing refresh starts immediately and keeps the processing state visible until the turn starts or the queue drains

#### Scenario: Agent waits for approval
- **WHEN** DSH emits an approval or question request
- **THEN** typing refresh stops while the interactive component is awaiting the user

### Requirement: Configurable verbosity
The adapter SHALL allow a project channel to choose between text-only, essential-tool, and full-tool progress without changing the DSH Session log.

#### Scenario: Text-only mode
- **WHEN** a channel uses text-only verbosity
- **THEN** tool progress is omitted from Discord while assistant text and terminal status remain available

### Requirement: Fixed adapter-owned iconography
Adapter notices SHALL carry fixed emoji prefixes chosen from an adapter-owned constant table (⚠️ failure/unknown, 💡 guidance, 🛑 stop, ↪️ steer, ⏳ queued). Tool activity rows carry a single category icon per row — Shell 💻, Read 📖, Write ✍️, Edit ✏️, Search 🔍, Find 🗂️, Web 🌐, generic fallback 🧩 — and never a run-state mark: state flips would require one message edit per tool transition, which does not survive Discord's edit budget under parallel tools. Assistant answer text SHALL NOT carry icon prefixes. The table SHALL live in one module and SHALL be the only source of iconography; icons SHALL never be derived from model output, tool output, or Host presentation views, and the sanitized text labels SHALL remain unchanged beside them.

#### Scenario: Rows carry only the category icon
- **WHEN** a tool activity row is rendered
- **THEN** the row is the category icon followed by the presentation-view title (or generic label), with no state mark of any kind

#### Scenario: Unknown tool falls back
- **WHEN** a tool name is outside the category allowlist
- **THEN** the row uses the generic category icon with the generic label

#### Scenario: Icons are never model-controlled
- **WHEN** model or tool output contains emoji or characters resembling the icon table
- **THEN** they are rendered as escaped content like any other text and never interpreted as adapter iconography

#### Scenario: Text-only verbosity
- **WHEN** a channel uses text-only verbosity
- **THEN** icon-prefixed tool rows are omitted entirely, consistent with the verbosity requirement above
