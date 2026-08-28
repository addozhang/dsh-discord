## 1. Package foundation

- [x] 1.1 Scaffold the Node 22+ ESM package `@addozhang/dsh-discord` with pnpm, TypeScript, Vitest, lint/typecheck/build scripts, and exact DSH peer versions; verify the empty package with `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
- [ ] 1.2 Add the `dsh.bundle` manifest, Host entry, Client entry, and bundle patch; verify a packed artifact installs and activates in a disposable Web profile. *(Manifest, `cordis.patch.yml`, `./client` entry, esbuild bundle, and `npm pack` verification done; disposable-profile activation still requires the `dsh` CLI.)*
- [x] 1.3 RED: add contract tests for missing/incompatible `apiProxy`, credentials, settings, storage, and connection capabilities; GREEN: implement fail-loud startup validation; REFACTOR with focused tests green.
- [x] 1.4 RED: add lifecycle tests with open timers, listeners, and fake connections; GREEN: implement one cancellation root and Cordis-owned cleanup; REFACTOR with no post-disposal work.

## 2. Settings and credentials

- [x] 2.1 RED: add settings-schema tests for one bot, allowed Guild IDs, user/role allow and deny rules, Workspace administrator rules, Host-operator user IDs, verbosity, and bounded timing/retry values; GREEN: register the plugin settings namespace with live updates and last-known-good validation.
- [x] 2.2 RED: add tests for credential presence, token redaction, per-connection resolution, rotation, and deletion; GREEN: implement one fixed plugin-owned Discord token reference without copying its value into settings or state.
- [ ] 2.3 RED: add client tests for redacted settings, revision conflicts, invalid token/intents status, and save feedback; GREEN: implement the minimal Web settings card. *(Redaction, save feedback, controller/entry wiring, and the card itself are done and green; invalid token/intents status lands with the Gateway state surface in section 3.)*

## 3. Discord ingress and Gateway lifecycle

- [x] 3.1 RED: add pure tests for Gateway message/interaction validation, identity normalization, mention stripping, unsupported event rejection, and self/bot filtering; GREEN: implement normalized inbound types and parsers.
- [x] 3.2 RED: add fake-clock tests for heartbeat acknowledgement, resumable reconnect, terminal close codes, bounded backoff, generation replacement, and disposal; GREEN: implement the Gateway state machine over an injected socket factory.
- [x] 3.3 RED: add tests proving DMs and events from unconfigured Guilds cause no DSH calls; GREEN: reject those events at the earliest normalized ingress boundary.

### Checkpoint A: Foundation and ingress

- [x] 3.4 Run the full tests, typecheck, lint, build, package verification, and dependency audit; inspect the bundle for secret leakage before starting feature work. *(58 tests, all gates green, `npm pack` verified, secret scan clean — only the fixed credential reference name appears, no token values; `pnpm audit` clean. Disposable-profile activation from 1.2 remains a manual step.)*

## 4. Discord REST and native interaction transport

- [x] 4.1 RED: add tests for REST success, structured failure, cancellation, retry-after handling, bounded retries, and unknown outcomes; GREEN: implement the typed Discord REST adapter.
- [x] 4.2 RED: add tests for nonce reuse and serialized per-route send/edit ordering; GREEN: implement delivery identity and route queues.
- [x] 4.3 RED: add tests for the fixed slash-command names, subcommands, arguments, contexts, permissions, and response visibility; GREEN: register the Milestone 1 command set.
- [x] 4.4 RED: add tests for initial acknowledgement/defer timing and expired interaction tokens; GREEN: implement command response lifecycle.
- [x] 4.5 RED: add tests for autocomplete filtering and pagination beyond Discord component limits; GREEN: implement reusable native selector paging.
- [x] 4.6 RED: add tests for opaque component IDs and modal correlation; GREEN: implement the component/modal transport without DSH business rules.

## 5. Authorization policy

- [x] 5.1 RED: add a decision-table test for Guild allowlist, allowed users/roles, optional owner/Admin/Manage Guild policy, deny-user/deny-role precedence, Host-operator user IDs, and unauthorized bots; GREEN: implement the pure authorization evaluator.
- [x] 5.2 RED: add boundary tests showing messages, slash commands, autocomplete, buttons, selects, and modals are authorized before DSH access; GREEN: install authorization middleware at every Discord ingress path.
- [x] 5.3 RED: add disclosure tests for Workspace lists, duplicate titles, opaque IDs, administrator-only path details, and disabled mention parsing; GREEN: implement safe labels and output policy.

## 6. Durable state

- [x] 6.1 RED: define schema/codec tests for application+guild+channel Workspace keys and application+guild+thread Session keys; GREEN: define and open the versioned DSH storage domain.
- [x] 6.2 RED: add tests for binding revisions and stale asynchronous commits; GREEN: implement single-record revision-fenced Channel and Thread bindings.
- [x] 6.3 RED: add tests for atomic in-process message claims and same-ID/same-hash versus same-ID/different-hash replay; GREEN: implement the inbound intent records and per-key serialization.
- [x] 6.4 RED: add tests for `planned/executing/succeeded/failed/unknown-needs-user-resolution` transitions and invalid transitions; GREEN: implement the delivery/submission state machines.
- [x] 6.5 RED: add tests for one writable Thread per Session and ownership release; GREEN: implement the unique logical owner record.
- [x] 6.6 RED: add tests for 30-day completed-intent/delivery retention, 7-day resolved-interaction retention, the 7-day minimum, non-expiring unresolved records, and Guild forget; GREEN: implement bounded cleanup without deleting DSH data.
- [x] 6.7 RED: add tests for malformed/newer state and backend failures; GREEN: fail closed without replacing state or accepting Discord-triggered DSH writes.

### Checkpoint B: Security and persistence

- [x] 6.8 Run the complete deterministic suite and inspect every state-changing path for authorization-before-effect, durable-intent-before-effect, and secret redaction. *(190 tests green; state layer carries no credential material; guard authorizes before business dispatch; intent claim precedes effects; vitest upgraded 4.0.15→4.1.11 for GHSA-5xrq-8626-4rwp; audit clean.)*

## 7. Workspace control vertical slice

- [x] 7.1 RED: add fake-DSH integration tests for listing all registered Workspaces, safe duplicate-title labels, opaque Workspace IDs, and selection paging; GREEN: implement `/project list` discovery.
- [x] 7.2 RED: add tests for Workspace administrator authorization, confirmation, stale Workspace removal, and cancelled selection; GREEN: implement `/project bind`.
- [x] 7.3 RED: add tests for independent bindings across channels and Guilds and for concurrent rebind; GREEN: persist Channel→Workspace mapping with revision fences.
- [x] 7.4 RED: add tests proving existing Threads retain their original Session/cwd after parent Channel rebind; GREEN: route only subsequently created Threads through the new Workspace.
- [x] 7.5 RED: add tests for unbound-channel mentions and reserved Workspace creation; GREEN: show an ephemeral bind affordance and report creation unavailable without filesystem mutation.
- [x] 7.6 RED: add tests for member versus Workspace-administrator `/project info`; GREEN: return title/opaque ID to members and canonical path only in an administrator's ephemeral response.

## 8. Session creation and continuation

- [x] 8.1 RED: add tests for mention-gated parent-channel input, empty mentions, unbound channels, and unauthorized senders; GREEN: implement the new-task admission flow.
- [x] 8.2 RED: add tests for duplicate source messages and concurrent Thread-create attempts; GREEN: create or recover one Discord Thread using the source message as the stable intent.
- [x] 8.3 RED: add tests for Session-create success, rejection, and unknown outcome after Thread creation; GREEN: create or reconcile one DSH Session and persist the Thread binding.
- [x] 8.4 RED: add tests for initial-prompt success, duplicate delivery, and unknown admission; GREEN: submit once with a persisted request ID, reconcile against history and queue state, and require explicit retry after irreducible uncertainty.
- [x] 8.5 RED: add tests for ordinary Thread continuation while idle and busy; GREEN: submit every normal Thread message through `session.prompt` with `mode: queue`.
- [x] 8.6 RED: add tests for queue snapshots and removal of one owned pending item; GREEN: implement `/queue list` and `/queue remove`.

## 9. Session resume and control

- [x] 9.1 RED: add tests for listing the current Workspace's Sessions, ID/title filtering, title fallback, archived labels, bounded pages, and no content snippets; GREEN: implement the `/session resume` selector without full-text search.
- [x] 9.2 RED: add tests for cold Session adoption, bounded history display, Session disappearance, and subagent rejection; GREEN: resume into one newly created writable Discord Thread without prompting the model.
- [x] 9.3 RED: add tests for resume conflict when another Discord Thread owns the Session; GREEN: refuse the second writable binding without an implicit takeover.
- [x] 9.4 RED: add tests that establish Turn ownership from the submitted request ID and reject control based only on running status; GREEN: track adapter-owned active Turns.
- [x] 9.5 RED: add tests for valid/invalid/late `/steer`; GREEN: steer only the calling Thread's owned active Turn.
- [x] 9.6 RED: add tests for valid/duplicate/late `/stop` and preservation of queued items; GREEN: cancel only the calling Thread's owned active Turn.

### Checkpoint C: Core Session flow

- [x] 9.7 Run the full deterministic suite and manually exercise bind → mention → Thread/Session creation → queued continuation → resume → steer/stop against a local fake Discord transport and real DSH Host. *(282 tests green; full flow exercised end-to-end over fake transports in test/checkpoint-c.test.ts; the real DSH Host manual exercise remains in 15.10.)*

## 10. Preset, model, and Skill controls

- [x] 10.1 RED: add tests for channel Preset show/select/reset, missing/broken presets, and unchanged existing Sessions; GREEN: persist the project-channel default and pass it only to future `session.create` calls.
- [x] 10.2 RED: add tests for model/reasoning catalog failures, invalid effort, explicit Host-operator authorization, and denial of Guild-only administrators; GREEN: implement `/model show` and the guarded selection flow.
- [x] 10.3 RED: add tests for the DSH Host-default side-effect warning and partial failure where Session selection succeeds but default persistence does not; GREEN: present the actual DSH outcome without claiming more than the API proves.
- [x] 10.4 RED: add tests for Skill listing, unavailable catalog, user-only Skills, and canonical slash input; GREEN: implement `/skill run` through queued `session.prompt`.
- [x] 10.5 RED: add tests for Host connectivity/version reporting and process-management refusal; GREEN: implement `/host status` only.

## 11. Stream renderer

- [ ] 11.1 RED: add pure tests for folding Turn/Step boundaries and multiple assistant messages; GREEN: implement the per-Thread render model keyed by Session, Turn, Step, message, and call IDs.
- [ ] 11.2 RED: add tests for text-delta assembly, authoritative `assistant/message`, interrupted messages, and empty Turn completion; GREEN: implement logical answer-message state.
- [ ] 11.3 RED: add fake-clock tests proving rapid chunks coalesce and only one edit is in flight; GREEN: implement the update scheduler.
- [ ] 11.4 RED: add race tests proving late chunks cannot overwrite finalized output; GREEN: implement render-generation and terminal fences.
- [ ] 11.5 RED: add Unicode/property tests for 2,000-character splitting, long unbreakable text, and empty output; GREEN: implement the base splitter.
- [ ] 11.6 RED: add fixtures for balanced fenced code and table boundaries; GREEN: add Markdown-aware normalization and fence reopen/close behavior.
- [ ] 11.7 RED: add tests for mention suppression in assistant, tool, title, and error content; GREEN: apply disabled mention parsing to every outbound path.
- [ ] 11.8 RED: add tool-view tests for safe allowlisted labels, generic fallback, parallel `callId` correlation, raw-data suppression, and verbosity; GREEN: implement the bounded activity surface.
- [ ] 11.9 RED: add fake-clock tests for typing start, keepalive, interaction pause, completion, cancellation, failure, and disposal; GREEN: implement typing lifecycle.
- [ ] 11.10 RED: add integration tests for final answer overflow and Discord rate-limit responses; GREEN: finalize one edited head message plus ordered continuation messages exactly once.

### Checkpoint D: Streaming quality

- [ ] 11.11 Run unit, property, and fake-integration suites under bursty chunks, parallel tools, delayed REST responses, cancellation, and duplicate events; inspect rendered Discord fixtures manually.

## 12. Image input

- [ ] 12.1 RED: add tests for supported media types, Discord CDN host allowlisting, redirect rejection/revalidation, and malformed URLs; GREEN: implement the safe download boundary.
- [ ] 12.2 RED: add tests for declared size, actual streamed size, aggregate limits, timeout, cancellation, and bounded memory use; GREEN: implement bounded image collection.
- [ ] 12.3 RED: add fake-DSH tests for mixed text/images, unsupported model modality, Host rejection, and duplicate Discord delivery; GREEN: encode and submit images through `session.prompt` exactly once.

## 13. Approval routing

- [ ] 13.1 RED: add tests for rendering approval data into opaque component IDs without raw sensitive fields; GREEN: implement Allow once and Reject controls.
- [ ] 13.2 RED: add tests for originating-user/Thread/Session/requestId/rpcId/approvalId ownership and unauthorized clicks by other members or administrators; GREEN: implement approval ownership validation.
- [ ] 13.3 RED: add concurrent-click and already-resolved tests; GREEN: implement atomic pending→submitting resolution and idempotent stale-control handling.
- [ ] 13.4 RED: add fake-clock tests for approval expiry and failed rejection; GREEN: reject before expiring controls and retain an explicit unresolved/error state when DSH does not confirm the response.

## 14. Question routing

- [ ] 14.1 RED: add tests for single-select, multi-select, option limits, multiple questions, and complete answer encoding; GREEN: implement native select-menu collection.
- [ ] 14.2 RED: add tests for custom text, modal expiry, invalid labels, wrong actor, and incomplete answers; GREEN: implement modal/controlled reply handling.
- [ ] 14.3 RED: add concurrent-answer and remote-resolution tests; GREEN: atomically submit one complete response and disable stale controls.
- [ ] 14.4 RED: add fake-clock tests for question timeout and cancellation races; GREEN: cancel the owned Turn before expiring controls, without synthesizing an answer.

## 15. Reconciliation

- [ ] 15.1 RED: add startup tests for missing Workspace/Session and changed Workspace metadata; GREEN: reconcile DSH mappings without deleting Host data.
- [ ] 15.2 RED: add startup tests for confirmed-deleted versus temporarily inaccessible Discord channels/Threads; GREEN: retire only confirmed deletions and block/retry unverifiable mappings.
- [ ] 15.3 RED: add reconnect tests with one missed history page, duplicate live events, and committed watermarks; GREEN: replay missing visible effects and advance watermarks after delivery bookkeeping.
- [ ] 15.4 RED: add multi-page and recovery-bound tests; GREEN: page deterministically and surface incomplete recovery without exhausting resources.
- [ ] 15.5 RED: add tests for uncertain DSH prompt admission resolved by history `source.rpcId`, queue evidence, or no evidence; GREEN: reconcile proven acceptance and require explicit retry otherwise.
- [ ] 15.6 RED: add tests for confirmed/failed/unknown Discord delivery and bounded lookup; GREEN: reconcile delivery without blind resend.
- [ ] 15.7 RED: add tests for pending interaction replay, resolution by another client, Host-generation change, and plugin disposal; GREEN: reconcile or expire controls fail-closed.

### Checkpoint E: Recovery and release readiness

- [ ] 15.8 Run the complete unit/integration suite, typecheck, lint, build, package verification, and native dependency audit; fix every reachable critical/high issue.
- [ ] 15.9 Install the packed plugin into a disposable DSH `0.1.1-rc.2` Web profile and verify activation, settings/credential redaction, clean unload, and refusal of Host process management.
- [ ] 15.10 Run the manual/release-blocking E2E suite in a dedicated non-production Discord Guild using dedicated credentials: bind Workspace → mention bot → create Thread/Session → stream text/tool progress → queue → steer/stop → question/approval → plugin restart → reconciliation without duplicate output.
- [ ] 15.11 Verify a second allowed Guild is isolated and an unconfigured Guild, DM sender, unauthorized member, and unauthorized bot cannot invoke DSH or observe Workspace/Session data.
- [ ] 15.12 Review the implementation against every OpenSpec scenario and prepare it for human review; do not ship automatically.
