## ADDED Requirements

### Requirement: List authorized existing Workspaces
The adapter SHALL list only existing DSH Workspaces visible to the invoking Discord principal and SHALL use Workspace IDs as selection values.

#### Scenario: User opens Workspace selector
- **WHEN** an authorized user invokes the Workspace bind command in a guild channel
- **THEN** the adapter queries `workspace.list`, applies authorization and disclosure policy, and presents matching Workspace titles through autocomplete or a paginated native selector; duplicate titles include a short opaque Workspace-ID suffix

### Requirement: Bind provisions the Workspace home channel
The bind action SHALL NOT capture the channel it was typed in. Instead, Kimaki add-project style, confirming a selection SHALL provision — or reuse — the Workspace's home channel: a text channel named after the Workspace title's Discord-safe slug under the adapter's own category, durably bound to that Workspace. The model SHALL be one Workspace, one home channel per Guild: an already-bound Workspace SHALL be answered with a link to its existing channel and never duplicated. A same-name channel MAY be reused only while it is unbound; a channel bound to another Workspace SHALL never be stolen — a `-2` sibling SHALL be created instead. The category's `general` control channel SHALL be excluded from ever becoming a Workspace home.

#### Scenario: Successful bind provisions the home channel
- **WHEN** an authorized administrator confirms an available Workspace selection
- **THEN** the Workspace home channel is created (or reused when already serving this Workspace) and durably bound, and subsequent new Threads in that channel create Sessions in that Workspace; the channel the command was typed in is unchanged

#### Scenario: Workspace already has its channel
- **WHEN** the selected Workspace already has a bound home channel in this Guild
- **THEN** the adapter answers with a link to the existing channel and creates nothing

#### Scenario: Workspace changed before confirmation
- **WHEN** the selected Workspace is removed before confirmation
- **THEN** the adapter rejects the stale selection and creates no channel

#### Scenario: Name collision with another Workspace's channel
- **WHEN** a same-name channel under the adapter category is bound to a different Workspace
- **THEN** the adapter creates a `-2` sibling channel for the new Workspace and leaves the other Workspace's channel untouched

### Requirement: Workspace binding is administrative
The adapter SHALL restrict binding and rebinding a project channel to principals with the configured Workspace-management permission.

#### Scenario: Regular user attempts binding
- **WHEN** a user may run Sessions but lacks Workspace-management permission
- **THEN** the adapter denies the binding without revealing disallowed Workspace metadata

### Requirement: Workspace creation is excluded
The first milestone SHALL NOT expose a Discord operation that creates Host directories or registers new DSH Workspaces.

#### Scenario: User requests a new Workspace
- **WHEN** a user attempts the reserved Workspace-create command
- **THEN** the adapter states that creation is unavailable in this version and performs no filesystem or Workspace mutation
