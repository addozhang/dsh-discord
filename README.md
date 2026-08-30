# @addozhang/dsh-discord

[English](README.md) | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@addozhang/dsh-discord)](https://www.npmjs.com/package/@addozhang/dsh-discord)
[![CI](https://img.shields.io/github/actions/workflow/status/addozhang/dsh-discord/ci.yml?branch=main&label=CI)](https://github.com/addozhang/dsh-discord/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@addozhang/dsh-discord)](./LICENSE)
[![node](https://img.shields.io/node/v/@addozhang/dsh-discord)](./package.json)

A Discord-first adapter for [DeepSeek Harness](https://github.com/deepseek-ai): run DSH sessions from a Discord guild — mention the bot to open a task thread, steer and stop turns, answer approvals and questions inline, and watch the answer stream in.

This is a function/namespace plugin (`inject: ['apiProxy', 'credentials', 'settings', 'storageDomain', 'connection']`). It mounts the Discord Gateway, command surface, stream renderer, and the settings card onto a DSH web profile; session state lives in DSH and durable adapter bindings live in the profile's storage domain.

## Features

- **Mention-driven sessions** — an authorized `@bot <task>` in a bound channel anchors a thread (the author's message becomes the first post), creates the DSH session, and submits the prompt at most once. Follow-ups inside the thread queue without a mention.
- **Stream rendering** — typing indicators, a single edited head message, per-tool activity rows, fenced long-answer splitting, one-time finalize; the activity message is deleted when the turn ends.
- **Approvals & questions** — DSH ask frames become Discord buttons, select menus, and a free-text modal; ownership is enforced (the asker — or the thread owner on later turns — clicks), expiry sweeps fail closed, and remote resolution retires the controls.
- **Session control** — `/steer`, `/stop`, `/queue list|remove` with turn-ownership checks; `/project bind|list|info` for guild↔workspace binding; `/guild forget` for operator cleanup.
- **Settings card** — token onboarding (paste + Connect; stored in the Host credential service, never in settings or logs), connect/disconnect, guild allowlist, thread auto-archive, and bot language.
- **Bilingual copy** — every Discord-visible string ships in Chinese and English; the bot language defaults to following the DSH language preference and can be pinned from the card.
- **Hardened by design** — deny-first authorization inside an explicit guild allowlist, mention suppression via `allowed_mentions` plus byte-level neutralization on every wire body, at-most-once DSH submission with unknown-preserving reconciliation, and durable bindings that survive restarts.

## Requirements

- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.1.1-rc.2` (web profile)
- Node.js `^22.19.0 || >=24`
- A Discord application with a bot user and the **MESSAGE CONTENT** privileged intent enabled (Developer Portal → your application → Bot → Privileged Gateway Intents)

## Install

```sh
pnpm add @addozhang/dsh-discord
```

Inside a DSH web profile the adapter runs as a plugin bundle — add it to the profile's `package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@addozhang/dsh-discord"] } }
}
```

## Configuration

All keys live in the `dsh-discord` settings namespace and can be set either from the settings card or by editing the profile's user settings (`settings.yaml`):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Adapter master switch; the card's Connect starts it once a token is stored. |
| `allowedGuildIds` | `[]` | Guild allowlist. Anything outside is ignored with zero adapter or DSH calls. |
| `memberUserIds` / `memberRoleIds` | `[]` | Member-level authorization inside an allowed guild. |
| `administratorUserIds` / `administratorRoleIds` | `[]` | Workspace-administrator level (`/project bind`, preset changes). |
| `deniedUserIds` / `deniedRoleIds` | `[]` | Deny entries; they win over every grant above. |
| `hostOperatorUserIds` | `[]` | Host operators (`/guild forget`, `/model select`). |
| `defaultVerbosity` | `essential-tools` | Tool-activity row granularity: `text-only`, `essential-tools`, or `full-tools`. |
| `language` | `auto` | Bot-visible copy language: `auto` follows the DSH language preference (non-Chinese renders English), or pin `zh`/`en`. |
| `streamUpdateIntervalMs` | `800` | Coalescing budget for stream edits (250–10000). |
| `typingIntervalMs` | `7000` | Typing-indicator heartbeat (1000–30000). |
| `approvalTimeoutMs` | `600000` | Approval ask deadline (30000–86400000); overdue asks auto-reject. |
| `questionTimeoutMs` | `1800000` | Question ask deadline (30000–86400000); expiry cancels the owning turn. |
| `threadAutoArchiveMinutes` | `1440` | Task-thread auto-archive: 60, 1440, 4320, or 10080. |

```yaml
dsh-discord:
  allowedGuildIds: ["1517134847850709032"]
  language: auto
```

The settings card exposes the three high-frequency fields (guild allowlist, auto-archive, language) plus the connection and token surface; every other key is fully supported through `settings.yaml`. An invalid stored section preserves the last known-good configuration.

## Setup

1. Invite the bot to your guild with at least: View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Attach Files, Read Message History.
2. Boot the profile and open the web UI.
3. In **Settings → Discord**, paste the bot token (Developer Portal → your application → Bot → Reset Token) and press **Connect**. The token is stored by the Host credential service — never in settings, logs, or the client.
4. Fill in **Allowed servers** (server IDs via Discord's Developer Mode → right-click a server → Copy Server ID). Everything outside this allowlist is ignored.
5. Pick the bot language and mention the bot in a bound channel to start a session.

## Commands

| Command | Where | What |
|---|---|---|
| `/project bind` | any channel | bind the guild to a workspace (admin; provisions the home channel) |
| `/project list` / `info` | any channel | list workspaces / inspect this channel's binding |
| `/queue list`, `/queue remove` | session thread | inspect and trim the pending queue |
| `/steer`, `/stop` | session thread | steer or cancel the running turn (owner only) |
| `/model`, `/preset`, `/skill` | per context | model/preset defaults and skill runs |
| `/host status` | any channel | connection and version |
| `/guild forget` | any channel | operator-only removal of adapter records |

## Design notes

- The settings card is the first-run onboarding surface: the token entry writes the credential service's `DSH_DISCORD_BOT_TOKEN` ref over the plugin management channel, then triggers the start chain. Disconnect keeps the credential; an empty reconnect uses it.
- The publish workflow authenticates to npm via trusted publishing (OIDC) — no publish token is stored anywhere.
- The adapter start chain is generation-counted, so Connect/Disconnect races with the initial boot yield exactly one gateway.
- A credential probe falls back to `resolve()` because the Host's `describe()` misses env-sourced values — a connected adapter never reads as unconfigured.

## Known Limitations and Deferred Work

- **`/session new|resume` is not registered** — the selector and cold-adoption modules are implemented and unit-tested, but the Host RPC face cannot back them yet (`sessions.list` v1 returns bare ids; no `session.inspect`). They return with the next milestone.
- **`/preset` lacks a session-thread guard** and **verbosity is a single global setting** (the DSH ecosystem has per-channel precedent).
- **Deferred after a Kimaki parity pass**: reconcile-interactions wiring, typing pause during ask waits, fail-closed binding/session-owner store wiring, and credential-rotation watching.
- **Known tension**: the 250ms minimum stream-edit interval against Discord's edit budget under heavy load (429s self-heal), and typing has no duration-capped watchdog.

## Development

```sh
pnpm install --ignore-scripts
pnpm test          # 642 tests incl. gateway/REST twin E2E
pnpm typecheck
pnpm lint
pnpm build         # lib + client bundle
```

To try a local build in a profile:

```sh
pnpm pack --pack-destination /tmp
cd "$DSH_HOME/profiles/<your-profile>"
pnpm add file:/tmp/addozhang-dsh-discord-<version>.tgz
```

Releases are tagged (`npm version <level> && git push --follow-tags`) and published by [GitHub Actions](./.github/workflows/publish.yml) via npm trusted publishing (OIDC) — no publish token is stored anywhere. The implementation follows the OpenSpec change at `openspec/changes/build-discord-native-adapter/` (design, capability specs, verification checklist, review reports).

## License

MIT
