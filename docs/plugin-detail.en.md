# Discord Adapter · turn a Discord server into a DeepSeek Harness cockpit

@mention the bot in any channel and a session starts right there: replies stream into message threads with live tool activity; host approvals and questions surface as Discord buttons — click one and the agent keeps going; slash commands like `/permission` and `/model` tighten or relax control without switching back to the browser.

[![GitHub stars](https://img.shields.io/github/stars/addozhang/dsh-discord?style=social)](https://github.com/addozhang/dsh-discord)

**If it works for you, please [star the repo](https://github.com/addozhang/dsh-discord)** — that directly decides how fast this plugin evolves.

## Highlights

- **@mention starts a session** — mention the bot in a channel or thread and the turn begins; streaming renders, tool lines, finalized transcripts, and zero replay across host restarts
- **Approval & question buttons** — host approval cards mirror into Discord as buttons; web and Discord race, first answer wins
- **9 slash commands** — `/project bind`, `/permission set`, `/model select`, `/stop`, `/steer`, `/queue remove`, `/session resume`, `/guild forget`, `/info`
- **deny-first, three tiers** — the guild allowlist is the outer boundary; member < workspace-admin < host-operator tighten step by step
- **Web settings card** — Settings → Discord: token, guild allowlist, bot language, auto-archive — all in one place

## Quick start

1. Install: `dsh plugin --profile <profile> add @addozhang/dsh-discord`
2. Web GUI → Settings → Discord, paste your bot token and save
3. Run `/project bind` in Discord, then @mention the bot and start chatting

## Compatibility

dsh ≥ 0.2.1 (adapter 0.6.x line). See the repo README for the host ↔ adapter version pairing table.

## Links

- Source & docs: <https://github.com/addozhang/dsh-discord>
- Issues: <https://github.com/addozhang/dsh-discord/issues>
- npm package: <https://www.npmjs.com/package/@addozhang/dsh-discord>

---

Finding it useful? [Leave a Star](https://github.com/addozhang/dsh-discord/stargazers) so I know it helped 🙌
