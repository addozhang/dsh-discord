## ADDED Requirements

### Requirement: Embedded Cordis plugin
The product SHALL ship as an independently installable Discord-only DSH bundle whose Host plugin runs inside the existing `dsh web` process and acquires the current Host through injected DSH services rather than starting another DSH process.

#### Scenario: Plugin starts with DSH
- **WHEN** the bundle is installed in the Web profile and `dsh web` starts
- **THEN** the Discord Host plugin activates after its declared DSH dependencies become available

#### Scenario: Host dependency is unavailable
- **WHEN** a required DSH service such as `apiProxy` or credentials is unavailable
- **THEN** plugin activation fails loudly with an actionable diagnostic and does not start a partially functional Discord connection

### Requirement: No host process management
The plugin SHALL NOT start, stop, restart, replace, or upgrade the `dsh web` process or DSH runtime.

#### Scenario: User requests unsupported process action
- **WHEN** a Discord user requests a DSH process-management or DSH-upgrade operation
- **THEN** the plugin refuses the operation and explains that the embedded adapter cannot manage its own Host process

### Requirement: Protected Discord credentials
The plugin SHALL address the single Discord bot token through a fixed plugin-owned DSH credential reference and SHALL NOT store the token in the settings document or adapter state database. It SHALL resolve the token per connection attempt and SHALL NOT return token values through browser RPCs, Discord responses, diagnostics, or logs.

#### Scenario: Configuration is inspected
- **WHEN** an authorized UI or diagnostic client requests adapter status
- **THEN** it receives only configured/unconfigured and connection-state metadata, never the Discord token

#### Scenario: Token is changed
- **WHEN** the credential provider reports that the Discord token reference changed
- **THEN** the adapter disposes the old Gateway generation and reconnects once using the newly resolved credential without requiring a DSH restart

### Requirement: Validated runtime configuration
The plugin SHALL register a restart-safe settings namespace for allowed Guild IDs, member and Workspace-management authorization rules, Host-operator user IDs, output verbosity defaults, and bounded timing/retry limits. Settings writes SHALL use revision checks, and invalid values SHALL preserve the last known-good runtime configuration.

#### Scenario: Stale settings update
- **WHEN** the settings UI submits a write against an obsolete namespace revision
- **THEN** the Host rejects the write and the UI reloads current redacted settings instead of overwriting the newer configuration

#### Scenario: Missing Discord capability
- **WHEN** the token is invalid or required Gateway intents or channel permissions are missing
- **THEN** the settings surface reports a sanitized actionable state without exposing the token or raw provider response

### Requirement: Explicit version compatibility
The plugin SHALL declare and test an explicit supported DSH version range and SHALL refuse activation when required contracts are unavailable.

#### Scenario: Unsupported DSH contract
- **WHEN** the running DSH version lacks a required API method or event shape
- **THEN** the plugin remains inactive and reports the incompatible capability without opening the Discord Gateway
