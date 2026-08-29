## Context

This repository is currently a specification workspace rather than an implementation repository. The product will begin as the scoped npm package `@addozhang/dsh-discord`, and these OpenSpec artifacts remain the source of truth until an implementation skeleton exists.

The target runtime is an existing `dsh web` process. DeepSeek Harness is a Cordis plugin tree: Host plugins acquire dependencies through `ctx`, and external bundles join a profile through `cordis.patch.yml`. The installed compatibility baseline is DSH `0.1.1-rc.2` on Node `^22.19.0 || >=24.0.0`.

DSH owns the agent runtime and exposes typed Workspace, Session, model, preset, skill, queue, cancellation, event, approval, and question contracts through Host `apiProxy`. Kimaki demonstrates that a strong Discord experience additionally requires a durable channel/thread model, serialized per-thread state, coalesced rendering, interaction ownership, idempotency, and reconnect reconciliation. Current dsh-im proves an external bundle can inject `apiProxy`, credentials, settings/UI services, and Discord connectivity, but its bot-scoped Workspace model does not satisfy this product's channel-scoped requirement.

Milestone 1 targets one Discord bot connected to multiple explicitly allowed Guilds. A Guild is a Discord server and is the outer tenant/security boundary. Direct messages are unsupported. In a bound project channel, a new Session starts only when the bot is explicitly mentioned; messages in an adapter-owned Session Thread do not require another mention. Every DSH Workspace registered on the current Host is selectable by an authorized Guild member; canonical paths are shown inside the adapter's ephemeral responses (§3) and never written into durable channel metadata.

In DSH, a Session records an immutable `cwd` (current working directory): the project directory used to resolve relative file and shell operations and the workspace root applied by the sandbox policy. Rebinding a Discord channel changes only the Workspace used by future Threads; existing Session Threads retain their original Session and `cwd`.

## Goals / Non-Goals

**Goals:**

- Ship an independent Discord-only bundle embedded in the Web profile.
- Map project channels to existing DSH Workspaces and Threads to ordinary DSH Sessions.
- Use Discord-native interactions for discovery, confirmation, selection, approval, and questions.
- Make ordinary Thread input queue by default, with explicit steer and stop controls.
- Deliver reliable, rate-limit-aware streamed answers and tool progress.
- Recover safely across Discord disconnects, plugin reloads, and process restarts.
- Enforce Guild allowlisting, member authorization, interaction ownership, least disclosure, and single-writer Session semantics.
- Develop every behavioral slice with RED → GREEN → REFACTOR and contract-level fakes before live Discord tests.

**Non-Goals:**

- Direct-message operation.
- Starting, stopping, restarting, or upgrading `dsh web`.
- Creating directories or registering new Workspaces in Milestone 1.
- Full-text Session search or per-Workspace ACLs in Milestone 1.
- Persistent `Approval always` rules.
- Git worktrees and scheduled tasks.
- Generic file ingress or result-artifact delivery in Milestone 1.
- Public diff/session sharing, voice, tunnels, browser VS Code, or screen sharing.
- Promoting a subagent Session into a top-level writable Session.
- Kimaki's automatic timeout-based interruption of an active step.
- Supporting multiple Discord bot tokens in Milestone 1.

## Decisions

### 1. Embedded Host plugin with a Web settings half

The package exposes a Host Cordis plugin as its default export, a browser client bundle as `./client`, and a bundle patch through `dsh.bundle`. The Host half injects `apiProxy`, `credentials`, `settings`, `storageDomain`, and the Web connection service. The client half contributes one settings card.

The adapter calls the current Host in process. It does not connect to `127.0.0.1:3080`, discover another Host, or silently fail over to another endpoint.

The settings namespace holds non-secret values: required allowed Guild IDs; member user/role IDs; administrator user/role IDs; deny user/role IDs; a global Host-operator user-ID allowlist; default verbosity; and bounded retry/timing values. Inside an allowed Guild, the Guild owner and members with Discord Administrator or Manage Guild are Workspace administrators by default. Workspace administrators also receive ordinary member access. Deny IDs override every level, including Host operator. Settings changes use revision fencing and apply live. The one bot token uses a fixed plugin-owned credential reference, is resolved for every connection attempt, and is never stored in settings or adapter state. Credential changes replace the active Gateway generation without restarting DSH.

Required Host dependencies are `apiProxy`, `credentials`, `settings`, `storageDomain`, and the Web `connection` service. This exact roster must be confirmed against the installed DSH contract during Task 1.3: optional use through `ctx.get()` is not allowed for a required runtime dependency, while a dependency proven unnecessary must be removed from both design and startup checks.

**Alternatives considered:**

- A standalone daemon supervising `dsh web`: rejected because process management and upgrade are explicitly excluded.
- Loopback HTTP/WebSocket access: rejected because it adds authority, port, CORS/trust, and wrong-Host risks without benefit inside the same process.
- Forking dsh-im: rejected as the product architecture because its cross-channel abstraction centers on a bot-scoped Workspace. Source may be studied and algorithms independently adapted under its license, but the new domain model starts Discord-first.

### 2. One bot, multiple Guilds, channel-scoped Workspace identity

Milestone 1 supports one configured Discord bot token. A project binding is keyed by `(applicationId, guildId, channelId)` and a Session binding by `(applicationId, guildId, threadId)`. The explicit Guild allowlist is checked before any member role or administrator privilege; membership in an unknown Guild never grants access.

A DSH Workspace ID is the authoritative logical target. Canonical path and title are cached only for diagnostics and stale-state detection. Reconciliation refreshes them from `workspace.list`.

**Alternatives considered:**

- Bot-global current Workspace: rejected because changing one channel would invalidate unrelated projects and Sessions.
- Path-only identity: rejected because DSH owns durable Workspace IDs and path-only mappings make stale detection ambiguous.
- Multi-bot support: deferred to avoid multiplying credential, connection, and lifecycle states before the core model is proven.
- Direct messages: deferred because they have no Guild authorization context or project-channel/thread mapping and require a separate product model.

### 3. All registered Workspaces are selectable, with Kimaki-style path display

The current Host's complete Workspace registry is the Milestone 1 selection set. Authorization gates discovery, but no additional path allowlist filters registered entries. Autocomplete/select options use opaque Workspace IDs as values and display labels; duplicate titles are disambiguated with a short Workspace-ID suffix. Following the deployment owner's explicit decision for this self-hosted, trusted-Guild product, filesystem paths are NOT treated as sensitive: they may appear in ephemeral responses (for example an abbreviated path in autocomplete labels, or the full path in `/project info`), available to every authorized member. Paths still never appear in channel names, topics, or other durable channel metadata.

**Trade-off:** an authorized Session user can cause work in any registered Workspace. Deployment guidance must require a dedicated trusted Discord server or tightly scoped roles. A future Workspace ACL can narrow this without changing mapping identity.

### 4. Mention-gated project channels and thread-native continuation

An authorized message in a bound project channel creates work only when it explicitly mentions the bot. The adapter creates or deterministically recovers one Thread for that source message, creates one DSH Session in the bound Workspace, commits the binding, and submits the prompt with at-most-once preference. Messages in adapter-owned Threads continue the bound Session without a mention.

Rebinding a project Channel from Workspace A to Workspace B affects only future Threads. Existing Threads remain bound to their original Sessions and immutable Workspace A `cwd`.

The Thread follows Kimaki's surface model: creation is anchored to the source message (`message_id`), so Discord moves the author's task message into the Thread as its first post — the Thread opens with what reads exactly like the user's own task post. The adapter also joins the author to the Thread (`thread-members`), because Discord sidebars list only threads the user has joined; Kimaki's comment is explicit: "add user to thread so it appears in their sidebar". The join is best-effort and never fails the task. The initial Thread name is the deterministic sanitized task title with a one-day auto-archive; crash-window recovery matches the anchored first message among the parent's active threads. When DSH later publishes its model-generated Session title (derived from the user's first input), the adapter renames the Thread once per distinct title — the Kimaki "renamed the channel" behavior — via the `session/projection` (`key: 'title'`) mux frame.

### 4.1 Channel provisioning is the bind action (Kimaki add-project alignment)

`/project bind <workspace>` does not capture the channel it was typed in. Confirming a bind provisions — or reuses — the Workspace's home channel: a text channel named after the Workspace title's Discord-safe slug, under the adapter's own category, and binds that channel to the Workspace. The model is strictly one Workspace, one channel per Guild: a Workspace that already has a bound channel is answered with a link to it, never duplicated. A same-name channel is reused only when it is unbound; a channel serving another Workspace is never stolen (a `-2` sibling is created instead).

The category's `general` control channel is the Kimaki `#kimaki-opencode` analog — the surface for running commands — and can never become a Workspace home. Ephemeral confirm/cancel buttons gate the write; the custom_ids are opaque registry ids, so no DSH identifier ever reaches the Discord wire. Workspace references are selected through live autocomplete; ids are never copy-pasted.

### 5. Default queue, explicit steer and stop

Ordinary messages call `session.prompt` with `mode: 'queue'`. `/steer` uses `mode: 'steer'` only after proving the calling Thread submitted and still owns the active Turn. `/stop` calls `session.cancel`; DSH preserves pending inbox work.

The adapter does not implement Kimaki's three-second abort-and-resubmit behavior. This removes a cancel/claim/resend race and is more predictable for collaborative use.

### 6. One writable Discord Thread per Session

A Session may be observed in DSH Web or future read-only Discord views, but the adapter permits at most one writable Discord Thread mapping. Resume into an already-owned Session fails with a clear conflict. A future explicit takeover operation may transfer ownership transactionally; it is not part of Milestone 1.

The Thread is the single writable transport binding, but each accepted prompt also records its submitting Discord user. `/steer`, `/stop`, approval, and question responses require both the owning Thread and that originating user. A Session being `running` alone never proves Discord ownership; ownership is established by the durable request ID on the admitted user message.

### 7. Project-channel Agent Preset; Host-affecting model selection

An Agent Preset is a complete Agent composition, not only a prompt template: it can determine persona, tools, skills, delegation, plan/goal support, and other per-Agent plugins. Preset configuration is an independent project-channel setting and does not require rebinding the Channel to its Workspace. The adapter stores a default Preset per project channel and passes it explicitly to future `session.create` calls. Resetting the channel preference omits the field so DSH applies its current Host default. Existing Sessions never change Preset, including blank Sessions reached through a Thread.

Model/reasoning selection follows DSH `session.selectModel` semantics. In DSH `0.1.1-rc.2`, a successful selection changes the addressed Session and attempts to persist that selection as the Host default for future Sessions. Therefore mutation is restricted to the explicit global Host-operator user-ID allowlist, not Guild-local administrators, and its confirmation states both effects. The adapter does not describe it as Session-only.

### 8. Event-derived renderer with two logical surfaces

Each active Thread runtime maintains a serialized action queue and two logical output surfaces:

1. **Answer surface:** each DSH `assistant/message` owns one logical Discord answer message. Its preceding chunks update that message through latest-value coalescing. A later Step starts another logical answer and never overwrites an earlier completed assistant message.
2. **Activity surface:** bounded tool status rows keyed by `callId`. Milestone 1 exposes only sanitized title/category and running/succeeded/failed state. It does not expose raw arguments, terminal output, absolute cwd, full file content, or full diffs.

Typing is refreshed only while a Turn produces work and stops for terminal states or while an interaction owns attention. `assistant/message` is the authoritative content for that logical response; `turn/end` closes the Turn. An interrupted assistant message retains its visible prefix and an interrupted marker.

Final splitting preserves Unicode and balanced code fences and respects Discord's message size limit. All output uses disabled mention parsing. Every asynchronous edit/send is serialized per Thread and guarded by a render generation so a late update cannot overwrite final output.

### 9. Native interaction routing with separate timeout semantics

Approval requests render `Allow once` and `Reject` buttons. Questions use select menus for bounded options and modals or controlled replies for custom answers. Component IDs contain only an opaque local interaction ID; durable state retains Session, Thread, DSH `rpcId`, approval ID when applicable, authorized actors, expiry, and state.

Resolution uses an atomic compare-and-set from `pending` to `submitting`; only the winner calls `apiProxy.respond`. A rejected receipt or resolved event disables stale controls.

Approval timeout atomically submits `rejected` before controls are marked expired. Question timeout cannot synthesize an answer; it requests cancellation of the adapter-owned Turn and records whether cancellation was accepted before disabling controls. A stream reconnect can replay still-pending requests, but a Host process restart may destroy pending question state and therefore expires unmatched controls.

`Approval always` is not emulated because DSH exposes only `allowed-once` and `rejected` on this wire.

### 10. Durable state through DSH storageDomain

The plugin defines a schema-versioned DSH storage domain under the current Host's configured storage backend. This avoids adding a second persistence technology to the embedded plugin while retaining serialized durable writes and validated records.

The domain tables cover:

- non-secret Discord installation and connection metadata;
- Guild policy and role/user allow/deny entries;
- project Channel ↔ Workspace mapping and revision;
- Thread ↔ Session writable binding and revision;
- Discord inbound message ↔ stable DSH request/submission state;
- DSH event/part ↔ Discord message/render state;
- pending interaction correlation and expiry;
- per-Thread delivery watermark.

External effects use an intent-first state machine:

```text
planned → executing → succeeded
                  └→ failed
                  └→ unknown-needs-user-resolution
```

The storage domain serializes writes but does not provide multi-record transactions or a put-if-absent primitive. Therefore each invariant is represented by one key/record whenever possible, and one process-local per-key queue serializes claim operations before the durable write. This gives atomicity inside the supported single embedded Host process, not cross-process transactional guarantees.

The stable Discord event/message identity and normalized payload hash are stored before invoking DSH. When a new Session is needed, the adapter also preallocates and persists the DSH Session ID before calling `session.create`; DSH can then idempotently adopt the same ID and cwd after an uncertain response. Before prompting, the adapter persists a stable DSH request ID. Same-ID/same-payload replay reuses the record; same-ID/different-payload fails. If prompt admission remains uncertain after checking durable history and the live queue snapshot, the adapter does not resubmit automatically; an explicit user retry creates a new intent.

Completed inbound-intent and delivery records default to 30-day retention; resolved interactions default to 7 days. Both values are configurable but SHALL NOT be set below 7 days. Active mappings and unresolved or unknown records are retained until explicit resolution or Guild forget. A confirmed Guild-forget operation removes adapter-owned Guild/member/role/mapping records while preserving DSH Workspaces and Sessions. Invalid or unreadable stored state fails closed; it is never replaced by an empty database automatically.

**Alternatives considered:**

- A separate SQLite ORM: rejected for Milestone 1 because the product is single-process and DSH already provides validated, serially durable KV domains. Reconsider only if later requirements need multi-process transactions or indexed queries unavailable from the domain API.
- Ad-hoc JSON files: rejected because independent records, validation, migration, and write serialization would have to be rebuilt.

### 11. Reconciliation is a first-class subsystem

On startup and after stream/Gateway reconnection, the adapter:

1. obtains DSH Workspace and Session baselines;
2. verifies Discord channels and Threads used by persisted mappings;
3. opens Host and Session event streams;
4. fetches bounded Session history pages for active mappings;
5. folds missing events after each mapping's committed watermark;
6. reconciles uncertain prompts against durable `user/message.source.rpcId` and live queue snapshots;
7. recreates missing render state only when delivery identity proves it is safe;
8. retires definitely invalid mappings without deleting DSH Workspaces or Sessions;
9. retains transiently unverifiable mappings in a blocked/unverified state;
10. reconciles pending interactions with DSH replay/resolution state.

Because DSH `0.1.1-rc.2` ignores `events.mux.since`, history reads are the durable recovery source. Stream events are live acceleration, not the sole source of truth.

### 12. Images only in Milestone 1

JPEG, PNG, WebP, and supported GIF inputs are downloaded only from approved Discord CDN hosts with redirects disabled or revalidated, bounded by DSH-advertised attachment limits and adapter limits, then encoded for `session.prompt`. Arbitrary file staging and outbound artifact delivery are deferred.

### 13. Fixed Milestone 1 command contract

The public Discord command surface is:

| Command | Context | Permission | Response |
|---|---|---|---|
| `/project list [query]` | allowed Guild | member | ephemeral paginated Workspace titles (names only; ids ride autocomplete values) |
| `/project bind <workspace>` | allowed Guild | Workspace administrator | live autocomplete → ephemeral confirm button → Workspace home channel provisioned/reused and durably bound (Kimaki add-project; the typed-in channel is never captured) |
| `/project info` | bound guild channel or its Thread | member | ephemeral; includes the canonical path (see §3) |
| `/session new <prompt>` | bound project channel | member | creates a Thread and Session |
| `/session resume <session>` | bound project channel | member | creates a new writable Thread unless Session is already Discord-owned |
| `/queue list` | bound Session Thread | member | ephemeral queue view |
| `/queue remove <item>` | bound Session Thread | writable Turn/Session owner | ephemeral result |
| `/steer <prompt>` | bound Session Thread | writable active-Turn owner | ephemeral acknowledgement |
| `/stop` | bound Session Thread | writable active-Turn owner | ephemeral acknowledgement |
| `/model show` | bound Session Thread | member | ephemeral model/reasoning view |
| `/model select <provider-model> [reasoning]` | bound Session Thread | Host operator | ephemeral confirmation stating Host-default side effect |
| `/preset show` | project channel | member | ephemeral channel default and Host default |
| `/preset select <preset>` | project channel | Workspace administrator | ephemeral confirmation for future Sessions |
| `/preset reset` | project channel | Workspace administrator | ephemeral confirmation that future Sessions follow Host default |
| `/skill run <skill> [input]` | bound Session Thread | member | queues canonical slash invocation |
| `/host status` | allowed Guild | member | ephemeral connection/version status |

A bot mention carrying non-empty text or a supported image in a bound project channel is the canonical new-task interface; `/session new` is the explicit alternative for structured inputs. DSH commands typed inside a Session Thread may pass through `session.prompt`, but the adapter does not automatically register every DSH command because rc.2 exposes no command-list method.

## Risks / Trade-offs

- **Discord access grants local agent capability** → an explicit Guild allowlist is the outer gate; member and administrator policies apply only inside it; deny rules win.
- **All registered Workspaces are selectable** → keep binding and model mutation admin-only, show paths only inside ephemeral adapter responses (§3), and preserve an additive ACL seam.
- **DSH is pre-1.0** → pin exact compatible packages, validate capabilities at startup, and run contract tests against every supported version.
- **`apiProxy` event streams are Host-global** → filter each frame by exact bound Session and never infer Discord ownership from Session ID alone.
- **DSH Web may use the same Session** → Discord owns only a Turn whose durable user message carries its submitted request ID; running status alone grants no control.
- **Cross-system exactly-once is impossible** → prefer at-most-once DSH submission, preserve unknown outcomes, and require explicit retry rather than risking duplicate code execution.
- **Discord REST outcomes may be unknown** → preserve unknown as a third state, use nonce/idempotency support where available, and reconcile before replacement sends.
- **`events.mux.since` is not implemented in rc.2** → restore from bounded history pages and advance watermarks only after delivery bookkeeping commits.
- **Pending questions do not survive every Host restart** → cancel/expire stale controls and never claim recovery without a current pending frame.
- **Tool presentation views are not a disclosure allowlist** → project only explicitly allowed status fields and suppress mentions in every output.
- **Full-text search is disabled by default in the Web profile** → defer content search; Milestone 1 filters only the current Workspace's bounded Session metadata.
- **Creating a Thread and Session crosses two systems** → persist intent before each effect and reconcile partial outcomes using the source message ID.
- **StorageDomain is single-process and non-transactional across records** → model critical invariants as single records and serialize per-key mutations; a future supervisor/multi-process deployment requires a storage redesign.

## Migration Plan

1. Create the new package and bundle without modifying existing DSH or dsh-im installations.
2. Install it into a dedicated test Web profile with one Discord bot and one test Guild.
3. Keep the adapter disabled until credentials and the Guild/member authorization policy validate.
4. Roll out to one project channel, then multiple channels in that Guild, then a second allowed Guild.
5. Treat storage-domain schema versions as explicit migrations; reject unknown/newer schemas and retain prior-version backups until migration verification succeeds.
6. Roll back by disabling/removing the bundle from the profile; retain adapter state unless an administrator explicitly forgets the Guild. DSH Workspaces, Sessions, and files remain untouched.

## Testing Strategy

The implementation repository will use pnpm, TypeScript, Vitest, and the package's own lint/build/package-verification scripts. Exact command names are established by the scaffold task and recorded in its `package.json`; subsequent tasks use those checked-in commands rather than global defaults.

Every behavioral slice follows strict RED → GREEN → REFACTOR:

1. Add one externally observable failing test.
2. Run the focused test and record that it fails for the intended missing behavior.
3. Add the minimum implementation required to pass.
4. Run the focused test until green.
5. Refactor only while the focused test remains green.
6. At each checkpoint run the full unit/integration suite, typecheck, lint, build, package verification, and dependency audit.

Test distribution:

- **Small/unit:** identity keys, authorization precedence, command parsing, path redaction, message splitting, Markdown fence balancing, render folding, state machines, retries, and event deduplication.
- **Medium/integration:** real DSH storage backend plus fake Discord transport and fake typed DSH API; restart/reconnect, mapping revisions, queue ownership, approval/question races, and partial external effects.
- **Large/E2E:** a dedicated Discord test Guild and installed supported DSH runtime for the critical bind → create Thread → prompt → stream → tool → interaction → completion path. This suite is manual/release-blocking and uses dedicated test credentials; ordinary pull requests run deterministic unit/integration gates without production Discord secrets.

Tests assert externally visible state and durable records rather than incidental method-call ordering. Fake clocks and deterministic schedulers replace real sleeps for rate-limit and reconnect tests.

## Later Milestones

- Add per-Workspace ACLs that can narrow which registered Workspaces each Guild, role, or user may discover and bind.
- Add controlled directory/Workspace creation and persistent approval rules only after their authorization models are specified.

## Open Questions

None for Milestone 1. Any later scope change requires updating the relevant capability spec before implementation.
