# @addozhang/dsh-discord

[![npm](https://img.shields.io/npm/v/@addozhang/dsh-discord)](https://www.npmjs.com/package/@addozhang/dsh-discord)
[![license](https://img.shields.io/npm/l/@addozhang/dsh-discord)](./LICENSE)
[![node](https://img.shields.io/node/v/@addozhang/dsh-discord)](./package.json)

Discord-first adapter for [DeepSeek Harness](https://github.com/deepseek-ai) — run DSH sessions from a Discord guild: mention the bot to open a task thread, steer and stop turns, answer approvals and questions inline, and watch the answer stream in.

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
- A Discord application with a bot user and the **MESSAGE CONTENT** privileged intent enabled (Developer Portal → your app → Bot → Privileged Gateway Intents)

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

## Setup

1. Invite the bot to your guild with at least: View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Attach Files, Read Message History.
2. Boot the profile and open the web UI.
3. In **Settings → Discord**, paste the bot token (Developer Portal → your application → Bot → Reset Token) and press **Connect**. The token is stored by the Host credential service — never in settings, logs, or the client.
4. Fill in **Allowed servers** (server IDs via Discord's Developer Mode → right-click a server → Copy Server ID). Everything outside this allowlist is ignored.
5. Pick the bot language (follow the DSH language by default) and mention the bot in a bound channel to start a session.

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

The implementation follows the OpenSpec change at `openspec/changes/build-discord-native-adapter/` (design, capability specs, verification checklist, review reports).

Releases are tagged (`npm version <level> && git push --follow-tags`) and published by [GitHub Actions](./.github/workflows/publish.yml) via npm trusted publishing (OIDC) — no publish token is stored anywhere.

## License

MIT
