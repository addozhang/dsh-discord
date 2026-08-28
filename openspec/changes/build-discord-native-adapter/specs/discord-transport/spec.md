## ADDED Requirements

### Requirement: Discord Gateway lifecycle
The adapter SHALL maintain a Discord Gateway connection with heartbeat acknowledgement, resumable reconnect when Discord permits it, bounded exponential backoff, and clean disposal with the owning Cordis fiber.

#### Scenario: Recoverable disconnect
- **WHEN** the Discord Gateway connection closes with a recoverable condition
- **THEN** the adapter reconnects with bounded backoff and resumes the prior Gateway session when possible

#### Scenario: Plugin disposal
- **WHEN** the Cordis plugin is disposed
- **THEN** Gateway connections, timers, pending REST operations, and reconnect attempts are cancelled and no new Discord event is accepted

### Requirement: Native Discord command surface
The adapter SHALL expose supported operations through Discord application commands and SHALL use autocomplete, buttons, select menus, or modals where they improve selection or confirmation.

#### Scenario: Long operation command
- **WHEN** a command cannot complete within Discord's initial interaction response window
- **THEN** the adapter acknowledges or defers the interaction before continuing asynchronously

#### Scenario: Selection exceeds one component page
- **WHEN** more choices exist than a Discord autocomplete or select component can represent
- **THEN** the adapter provides query filtering or pagination without dropping valid choices

### Requirement: Normalized inbound messages
The adapter SHALL validate and normalize untrusted Discord messages, interactions, mentions, replies, supported image attachments, guild/channel/thread identity, and actor identity before routing them to business logic.

#### Scenario: Bot-authored event
- **WHEN** an inbound message was authored by any bot, including the adapter itself
- **THEN** the adapter ignores it without creating a Session or response loop

#### Scenario: Malformed Gateway payload
- **WHEN** a Gateway event lacks required identity fields or contains an unsupported payload shape
- **THEN** the adapter rejects the event without invoking DSH or throwing out of the Gateway dispatch loop

### Requirement: Required Discord capabilities
The adapter SHALL require the Gateway intents and guild/channel permissions needed for guild commands, message content, channel visibility, Thread creation, Thread replies, and history reads, and SHALL expose a sanitized readiness error when they are absent. Optional capabilities SHALL degrade without blocking unrelated core behavior.

#### Scenario: Message Content Intent is disabled
- **WHEN** Discord rejects or withholds the configured message-content capability
- **THEN** the adapter reports the missing intent and does not advertise the message-driven Session flow as ready

#### Scenario: Thread permission is missing
- **WHEN** the bot can read a project channel but cannot create or send in its Threads
- **THEN** the adapter refuses new-task creation in that channel and reports the missing permission without creating a DSH Session

### Requirement: Rate-limit-aware delivery
The adapter SHALL serialize Discord writes per route, coalesce replaceable updates, honor Discord retry information, and bound retries.

#### Scenario: Discord rate limit
- **WHEN** Discord rate-limits an edit or send operation
- **THEN** the adapter delays according to the returned retry policy without reordering terminal output or issuing an unbounded retry loop
