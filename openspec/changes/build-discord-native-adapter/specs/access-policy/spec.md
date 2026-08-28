## ADDED Requirements

### Requirement: Guild allowlist is the outer authorization boundary
The adapter SHALL process guild messages and interactions only when their `guildId` is present in the configured Guild allowlist. Guild ownership, Administrator permission, Manage Guild permission, or an allowed role SHALL NOT bypass this outer boundary.

#### Scenario: Bot is invited to an unconfigured Guild
- **WHEN** any member of a Guild absent from the configured Guild allowlist sends a message or invokes an adapter interaction
- **THEN** the adapter silently performs no DSH operation and discloses no Workspace or Session metadata

### Requirement: Deny-by-default member authorization
Inside an allowed Guild, the adapter SHALL authorize every message, command, autocomplete request, component interaction, and modal submission before invoking DSH. Member access SHALL require an explicitly allowed user ID, an explicitly allowed role ID, or Workspace-administrator authority. Workspace-administrator authority SHALL include the Guild owner, Administrator, Manage Guild, and explicitly configured administrator user or role IDs. A matching deny-user or deny-role ID SHALL take precedence over every member, administrator, and Host-operator allow rule.

#### Scenario: Unauthorized user invokes a command
- **WHEN** a user inside an allowed Guild has no applicable allow rule
- **THEN** the adapter performs no DSH operation and returns an ephemeral denial for interactions or silently ignores ordinary messages

#### Scenario: Deny overrides administrative permission
- **WHEN** a user matches both an allowed administrative condition and a deny rule
- **THEN** the adapter denies the operation

### Requirement: Direct messages are unsupported
The adapter SHALL ignore Discord direct messages in Milestone 1 and SHALL NOT create a Workspace or Session binding for a DM channel.

#### Scenario: User sends a direct message
- **WHEN** any user sends a direct message to the bot
- **THEN** the adapter performs no DSH operation and returns at most a static notice that DM operation is unsupported

### Requirement: Three authorization levels
The adapter SHALL distinguish member, Workspace administrator, and Host operator authority. Member and Workspace-administrator authority SHALL be derived within an allowed Guild from stable Discord user and role IDs plus the Guild owner, Administrator, and Manage Guild permissions. Host operator authority SHALL require an explicit global Discord user-ID allowlist and SHALL NOT be granted by a Guild-local role or administrator permission alone. Deny rules SHALL still take precedence.

#### Scenario: Guild administrator attempts a Host-global mutation
- **WHEN** a Guild administrator who is not in the Host operator user-ID allowlist invokes an operation that changes Host-global state
- **THEN** the adapter denies the operation

### Requirement: All registered Workspaces are selectable by authorized members
The adapter SHALL make every Workspace returned by the current DSH Host's `workspace.list` eligible for discovery by an authorized Guild member; binding one to a Channel still requires Workspace-administrator authority. The Host registry is the Milestone 1 Workspace-selection boundary.

#### Scenario: Authorized member searches Workspaces
- **WHEN** an authorized Guild member opens the Workspace selector
- **THEN** every matching Workspace currently registered on that DSH Host is eligible for selection

### Requirement: Kimaki-style path display in ephemeral surfaces
The adapter SHALL show Workspace titles and opaque Workspace IDs as selection values. Absolute Host paths MAY appear in the adapter's responses to authorized members — all adapter responses are ephemeral — including abbreviated paths in autocomplete labels and full paths in detail responses. The adapter SHALL NOT persist a path in a Discord channel topic, name, or other durable channel metadata.

#### Scenario: Authorized member reads Workspace details
- **WHEN** an authorized member requests Workspace details or hovers autocomplete candidates
- **THEN** the response may include the canonical path (full or abbreviated) alongside safe display titles

#### Scenario: Channel metadata never carries paths
- **WHEN** the adapter provisions or renames a Discord channel
- **THEN** the channel name derives from the Workspace display title, never from the canonical path, and no path is written into the channel topic

### Requirement: Safe Discord output
The adapter SHALL suppress automatic Discord mentions in all content derived from users, DSH events, model output, Workspace titles, Session titles, and tool presentation views.

#### Scenario: Model emits a mass mention
- **WHEN** model or tool output contains `@everyone`, `@here`, a role mention, or a user mention
- **THEN** the adapter renders the text without notifying the referenced members or roles
