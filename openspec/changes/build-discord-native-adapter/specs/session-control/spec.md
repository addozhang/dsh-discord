## ADDED Requirements

### Requirement: Create Session from project channel
The adapter SHALL create a Discord Thread and an ordinary DSH Session in the parent Channel's bound Workspace only for an authorized message that explicitly mentions the bot.

#### Scenario: Mentioned task in a bound channel
- **WHEN** an authorized user explicitly mentions the bot with non-empty text and/or at least one supported image in a bound project channel
- **THEN** the adapter creates or recovers one Thread, creates or recovers one Session with the bound `workspaceId`, persists the binding, and submits the task at most once

#### Scenario: Unmentioned message in a project channel
- **WHEN** a message in a bound project channel does not explicitly mention the bot
- **THEN** the adapter ignores it without creating a Thread or Session

#### Scenario: Empty mention in a project channel
- **WHEN** a user mentions the bot without non-empty text or a supported image
- **THEN** the adapter returns a usage hint and creates no DSH Session

#### Scenario: New task in an unbound channel
- **WHEN** an authorized user mentions the bot with a task in a channel without a Workspace binding
- **THEN** the adapter creates no Session and posts a minimal non-sensitive notice directing a Workspace administrator to invoke the ephemeral `/project bind` flow

### Requirement: Kimaki thread surface
The adapter SHALL create a new task's Thread independently under the parent channel (not anchored to the source message), named after the deterministic task title, and SHALL mirror the author's channel message once into the fresh Thread as its opener through a webhook that renders as the author. Mirrored content SHALL suppress automatic mention parsing. The mirror SHALL be best-effort: a failed mirror SHALL NOT fail the task. Crash-window recovery SHALL match the task's Thread deterministically among the parent's active threads by its task title. When DSH publishes a model-generated Session title (derived from the user's first input), the adapter SHALL rename the Thread to it at most once per distinct title.

#### Scenario: Thread opens with the author's task
- **WHEN** an authorized user's mention creates a new Thread
- **THEN** the Thread's first message shows the author's own identity and their task text, and the source channel keeps the original message

#### Scenario: Session title renames the Thread
- **WHEN** DSH's session-title projection lands a non-empty title different from the Thread's current one
- **THEN** the adapter renames the Thread to that title exactly once per distinct title

#### Scenario: Title projection without a bound thread
- **WHEN** a title projection arrives for a Session with no bound Discord Thread
- **THEN** the adapter drops it without touching Discord

### Requirement: Resume Sessions
The adapter SHALL list resumable ordinary Sessions within the current Channel's Workspace and SHALL create a new Discord Thread when one is resumed. Milestone 1 SHALL filter the bounded Workspace Session list by ID and title only and SHALL NOT promise full-text content search.

#### Scenario: Resume a cold Session
- **WHEN** an authorized user selects a persisted ordinary Session that has no live Agent
- **THEN** the adapter adopts the Session through DSH, creates and binds a Thread, and shows a bounded history without prompting the model

#### Scenario: Filter Session selector
- **WHEN** a user enters autocomplete text while choosing a Session
- **THEN** the adapter filters the current Workspace's available Session IDs and titles without exposing conversation snippets

#### Scenario: Subagent Session selected
- **WHEN** a selected Session has `origin: subagent`
- **THEN** the adapter refuses to bind it as a top-level writable Thread

### Requirement: Queue by default
The adapter SHALL submit ordinary messages in a bound Thread using DSH `queue` mode and SHALL NOT automatically cancel an active Turn.

#### Scenario: Message arrives during an active Turn
- **WHEN** an authorized user sends an ordinary message while the Session is running
- **THEN** the message remains queued for a later Turn and the adapter shows its queued state

### Requirement: Explicit steering and stopping
The adapter SHALL expose explicit Discord commands for steering an adapter-owned active Turn and cancelling an adapter-owned active Turn while retaining pending queued messages.

#### Scenario: Authorized steer
- **WHEN** an authorized member invokes `/steer` with non-empty text in the writable Thread that submitted the active Turn
- **THEN** the adapter submits that text using DSH `steer` mode

#### Scenario: Authorized stop
- **WHEN** an authorized member invokes `/stop` in the writable Thread that submitted the active Turn
- **THEN** the adapter calls DSH cancellation and leaves pending queue items intact

#### Scenario: Turn belongs to another client
- **WHEN** the bound Session is running but the current Turn was not submitted by this Discord Thread
- **THEN** `/steer` and `/stop` refuse to control it

### Requirement: Model selection follows DSH native semantics
The adapter SHALL allow only an explicitly configured Host operator to change a bound Session's model or reasoning effort. A successful selection SHALL be presented as changing the current Session and causing DSH to attempt to persist that selection as the Host default for Sessions created later; the adapter SHALL NOT claim that default persistence succeeded because DSH `0.1.1-rc.2` does not expose that outcome.

#### Scenario: Administrator changes model
- **WHEN** a Host operator confirms a valid provider, model, and optional reasoning effort
- **THEN** the adapter confirms the current Session selection and explicitly states that DSH also attempted to save it as the Host default for future Sessions

#### Scenario: Non-operator attempts model change
- **WHEN** a member or Guild administrator outside the Host operator user-ID allowlist invokes the model-selection mutation
- **THEN** the adapter denies the mutation without changing Session or Host defaults

### Requirement: Project-channel default Agent Preset
The adapter SHALL let a Workspace administrator configure an Agent Preset default on a project channel. The adapter SHALL pass that preset to future `session.create` calls for the Channel and SHALL NOT modify existing Sessions or the DSH Host default.

#### Scenario: Channel default is selected
- **WHEN** a Workspace administrator selects an available Agent Preset in a project channel
- **THEN** the adapter persists the channel preference and uses it for Sessions subsequently created in that Channel

#### Scenario: Channel default follows Host
- **WHEN** a Workspace administrator resets the project channel's Preset preference
- **THEN** future `session.create` calls omit `agentPreset` so DSH resolves its current Host default

#### Scenario: Preset command in Session Thread
- **WHEN** a user attempts to change Preset from an existing Session Thread
- **THEN** the adapter refuses and directs the user to configure the project channel default for future Sessions

### Requirement: Skill invocation
The adapter SHALL list Skills visible to a bound Session and invoke a selected Skill by submitting its canonical slash command through `session.prompt`.

#### Scenario: Skill invocation
- **WHEN** an authorized member selects a Skill visible for the bound Session
- **THEN** the adapter queues the canonical slash invocation rather than creating a separate execution protocol

### Requirement: Host status visibility
The adapter SHALL expose the connection state and DSH version returned by the current Host, without offering Host process management.

#### Scenario: User requests Host status
- **WHEN** an authorized member invokes `/host status`
- **THEN** the adapter reports current connectivity and version without starting, stopping, restarting, or upgrading DSH
