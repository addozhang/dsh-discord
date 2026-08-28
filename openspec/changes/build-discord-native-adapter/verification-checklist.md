# Release verification checklist (15.9–15.12)

Steps that require a real Host profile and a dedicated non-production Discord
Guild. Everything automatable has already passed: 502 tests / 77 files,
typecheck, strict lint, Host + client builds, `pnpm pack` verification, and a
clean `pnpm audit`.

## Prerequisites

- `sudo chown -R 501:20 ~/.npm` (npm's default cache has root-owned files;
  pnpm and `--cache <dir>` work around it, the profile install does not).
- `dsh 0.1.1-rc.2` CLI available on PATH.
- A dedicated Discord application + bot, invited to a **non-production** Guild
  with the intents the adapter requests (Guilds, GuildMessages, GuildMembers,
  MessageContent for the sandbox guild only).
- A test bot token to place into the DSH credential reference
  `DSH_DISCORD_BOT_TOKEN` (never into the settings document).

## 15.9 Disposable profile install

1. `mkdir /tmp/dsh-profile && pnpm pack --pack-destination /tmp`
2. Install the packed tarball into a disposable Web profile per dsh docs
   (`dsh profile add`/plugin install path) and start it.
3. Verify:
   - plugin activates (cordis diagnostics show `dsh-discord` with all five
     injected services; startup validation did not refuse);
   - settings card renders under Plugins → Discord;
   - the token reference shows only `configured`/`source`/`writable` — no
     value anywhere in the card, settings document, or logs;
   - unload/disable removes the card and the status RPC channel cleanly
     (no post-disposal errors in the log);
   - the adapter refuses Host process management: no admin/job/plugin APIs
     surface through any adapter command or RPC endpoint.
4. Record the profile path and discard it afterwards.

## 15.10 Manual E2E (dedicated Guild)

Run exactly once in this order, noting any duplicate output:

1. `/project bind <workspace>` in a test channel (administrator).
2. `@bot <task>` in that channel → Thread + Session created.
3. Watch streaming: one edited head message, tool activity rows, typing.
4. Submit a second prompt while the first runs → `/queue list` shows it.
5. `/steer <nudge>` mid-turn, then `/stop` → turn ends, queue preserved.
6. Have DSH trigger an approval → Allow once / Reject round trip; then a
   question → select + "Other…" modal + submit.
7. Restart the dsh process mid-idle → reconciliation: no duplicate Discord
   messages, bindings intact, uncertain prompts reported (not silently
   resent).
8. `/session resume` → new writable Thread; old Thread keeps history only.

## 15.11 Isolation

1. Allow a second Guild; verify independent bindings (`/project info` in both).
2. From an unconfigured Guild: `@bot` mention must produce nothing.
3. From a DM: nothing (no Guild context → rejected at ingress).
4. An unauthorized member clicking a stale approval/question button gets an
   ephemeral denial; controls stay pending.
5. An unauthorized bot's messages must be ignored end to end.

## 15.12 Spec-vs-implementation review (prepared for human review)

Requirement → primary evidence:

| Spec requirement | Evidence |
| --- | --- |
| Guild allowlist, deny-first, DM rejection | `test/gateway-ingress*`, `test/policy*` |
| One bot token via credentialRef, redaction | `test/credential.test.ts`, `test/adapter-status*` |
| Settings namespace + last-known-good | `test/settings.test.ts`, `test/card-form.test.ts` |
| Fail-loud startup validation | `test/startup.test.ts`, `test/lifecycle.test.ts` |
| Gateway lifecycle, terminal closes | `test/gateway*` |
| REST adapter, route queues, commands | `test/rest*`, `test/commands*`, `test/selector*` |
| Durable intents, revisions, retention | `test/intents*`, `test/retention*`, `test/effect-machine*` |
| Workspace/session flows | `test/project-*`, `test/session-*`, `test/task-admission*` |
| Stream renderer, splitting, fences | `test/render*`, `test/splitter*`, `test/outbound*` |
| Approval routing | `test/approval-*.test.ts` |
| Question routing | `test/question-*.test.ts` |
| Reconciliation | `test/reconcile-*.test.ts` |

Any deviation found during 15.9–15.11 is a finding for human review — do not
ship automatically.
