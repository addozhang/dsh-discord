# @addozhang/dsh-discord

Discord-first adapter for [DeepSeek Harness](https://github.com/deepseek-ai) — run DSH sessions from a Discord guild: mention the bot to open a task thread, steer and stop turns, answer approvals and questions inline, and watch the answer stream in.

## Features

- **Mention-driven sessions** — an authorized `@bot <task>` in a bound channel anchors a thread (the author's message becomes the first post), creates the DSH session, and submits the prompt at most once. Follow-ups inside the thread queue without a mention.
- **Stream rendering** — typing indicators, a single edited head message, per-tool activity rows, fenced long-answer splitting, one-time finalize; the activity message is deleted when the turn ends.
- **Approvals & questions** — DSH ask frames become Discord buttons, select menus, and a free-text modal; ownership is enforced (the asker — or the thread owner on later turns — clicks), expiry sweeps fail closed, and remote resolution retires the controls.
- **Session control** — `/steer`, `/stop`, `/queue list|remove` with turn-ownership checks; `/project bind|list|info` for guild↔workspace binding; `/guild forget` for operator cleanup.
- **Settings card** — token onboarding (paste + Connect; stored in the Host credential service, never in settings or logs), connect/disconnect, guild allowlist, thread auto-archive, and bot language (follow the DSH language, or pin 中文/English).
- **Bilingual copy** — every Discord-visible string ships in Chinese and English, selected live from the card.
- **Hardened by design** — deny-first authorization inside an explicit guild allowlist, byte-level mention neutralization plus `allowed_mentions` on every wire body, at-most-once DSH submission with unknown-preserving reconciliation, and durable bindings that survive restarts.

## Install

The adapter runs as a DSH plugin bundle inside a web profile:

```sh
pnpm build && pnpm pack --pack-destination /tmp
cd "$DSH_HOME/profiles/<your-profile>"
pnpm add file:/tmp/addozhang-dsh-discord-0.1.0.tgz
```

and register it in the profile's `package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@addozhang/dsh-discord"] } }
}
```

> Publishing to npm is pending (account unavailable). Until then, install from the packed tarball.

## Setup

1. Boot the profile and open the web UI.
2. In **Settings → Discord**, paste the bot token (Discord Developer Portal → your application → Bot → Reset Token) and press **Connect**. The token is stored by the Host credential service — never in settings, logs, or the client.
3. Fill in the allowed servers (server IDs via Discord's Developer Mode → right-click → Copy Server ID) and invite the bot to those guilds.
4. Mention the bot in a bound channel to start a session.

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

The implementation follows the OpenSpec change at `openspec/changes/build-discord-native-adapter/` (design, capability specs, verification checklist, review reports).

## License

MIT
