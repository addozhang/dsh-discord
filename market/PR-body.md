# Add addozhang/dsh-discord

## What

Adds one entry: `data/plugins/addozhang__dsh-discord.yml` — category `notify`.

**addozhang/dsh-discord** is a Discord adapter for DeepSeek Harness. It installs
into a dsh web or desktop profile (prebuilt from npm as `@addozhang/dsh-discord`,
or from GitHub) and connects a Discord bot to the running host:

- @mentions and threads bind to sessions; replies stream per thread with live
  tool-activity rows, and a persisted render watermark suppresses already
  delivered history after a restart (no replay).
- Nine slash commands (`/project` `/queue` `/info` `/steer` `/stop` `/model`
  `/session` `/guild` `/permission`) cover workspace binding, queue inspection,
  turn control, session resume, and permission-preset / model selection.
- Tool approvals and user questions race between Discord buttons and the web UI
  cards — whichever side answers first wins, and the losing side's controls
  retire automatically.
- A deny-first guild allowlist gates everything, with permission levels
  member < workspace-admin < host-operator; messages are bilingual zh/en.

Relative to the existing Discord entries (`suuuuuu-1/dsh-discord`,
`tjiisztiuv/dsh-plugin-discord`): per-thread streaming renderer with
tool-activity rows and a zero-replay render watermark, permission-preset and
model-selection commands, and the deny-first guild allowlist.

## Self-check

- [x] `package.json` declares `dsh.bundle` with `cordis.patch.yml` at the repo root
- [x] Repo created 2026-08-30 (past the 1-day bar); `dsh-plugin` topic present; MIT
- [x] Real, working code — CI runs the full vitest suite including a Discord
      digital-twin E2E on every push
- [x] Description claims verified against source — "nine slash commands" counted
      in `src/discord/commands.ts` (project, queue, info, steer, stop, model,
      session, guild, permission)
- [x] npm package published (`@addozhang/dsh-discord@0.6.4`); its `repository`
      field points back at this repo (no hand-written `npm:` key)
- [x] One entry, one PR; generated READMEs untouched
