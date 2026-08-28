## ADDED Requirements

### Requirement: List authorized existing Workspaces
The adapter SHALL list only existing DSH Workspaces visible to the invoking Discord principal and SHALL use Workspace IDs as selection values.

#### Scenario: User opens Workspace selector
- **WHEN** an authorized user invokes the Workspace bind command in a guild channel
- **THEN** the adapter queries `workspace.list`, applies authorization and disclosure policy, and presents matching Workspace titles through autocomplete or a paginated native selector; duplicate titles include a short opaque Workspace-ID suffix

### Requirement: Bind Workspace to project channel
The adapter SHALL bind the selected existing DSH Workspace to the current Discord project channel without altering bindings belonging to other channels.

#### Scenario: Successful channel binding
- **WHEN** an authorized user confirms an available Workspace selection
- **THEN** the Channel mapping is durably committed and subsequent new Threads in that Channel create Sessions in that Workspace

#### Scenario: Workspace changed before confirmation
- **WHEN** the selected Workspace is removed before confirmation
- **THEN** the adapter rejects the stale selection, preserves the previous binding, and asks the user to refresh the selector

#### Scenario: Rebind a channel with existing Threads
- **WHEN** an authorized administrator rebinds a project Channel from Workspace A to Workspace B
- **THEN** existing Thread→Session bindings continue using their Sessions and immutable Workspace A cwd, while only Threads created after the committed rebind use Workspace B

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
