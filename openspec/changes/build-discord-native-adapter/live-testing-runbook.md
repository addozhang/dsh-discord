# Live testing runbook (web-test profile)

How this repo's Discord adapter is deployed to a real DSH host and exercised
against a real Discord Guild. Written for any agent following the 15.10 E2E
work: follow it top to bottom, do not improvise the credential handling.

## Environment facts (do not re-derive)

- Test profile: `/Users/addo/.dsh/profiles/web-test` (bundles: dsh-base,
  dsh-web-app, `@addozhang/dsh-discord` from a local tarball).
- Test instance: `dsh --profile web-test --port 3081 --no-open`, log at
  `/tmp/dsh-web-test.log`, health check `curl http://127.0.0.1:3081/` → 200.
- **Port 3080 runs the user's live GUI host — never restart or touch it.**
- Bot token: lives ONLY in the running test process's environment
  (`DSH_DISCORD_BOT_TOKEN`). It is NOT in `/Users/addo/.dsh/.credentials.yaml`
  (verified empty for this ref). There is no copy on disk.
- Adapter log channel: every observable step prints `[dsh-discord] <event>`
  to stderr → `/tmp/dsh-web-test.log` (rpcLog in src/index.ts).

## Deploy a new build (the pnpm gotcha)

```bash
pnpm build && pnpm pack --pack-destination /tmp
cd /Users/addo/.dsh/profiles/web-test
pnpm remove @addozhang/dsh-discord && pnpm add file:/tmp/addozhang-dsh-discord-0.0.0.tgz
```

**Gotcha:** the tarball version is always `0.0.0`; pnpm skips reinstalling a
same-name same-version package. Skipping the `pnpm remove` silently ships the
OLD build. Verify the new code actually landed, e.g.
`grep -c <new-log-event> node_modules/@addozhang/dsh-discord/lib/index.js`.

## Restart the test instance (silent token handoff)

The token exists only in the old process's env. Transfer it WITHOUT ever
printing it (no stdout, no logs):

```bash
OLD_PID=$(pgrep -f "dsh --profile web-test --port 3081" | head -1)
ps eww "$OLD_PID" > /tmp/dsh-env.txt && chmod 600 /tmp/dsh-env.txt
grep -c "DSH_DISCORD_BOT_TOKEN=" /tmp/dsh-env.txt   # must be 1 before killing
kill "$OLD_PID" && sleep 2
TOKEN_LINE=$(grep -o 'DSH_DISCORD_BOT_TOKEN=[^ ]*' /tmp/dsh-env.txt | head -1)
DSH_DISCORD_BOT_TOKEN="${TOKEN_LINE#DSH_DISCORD_BOT_TOKEN=}" \
  nohup /opt/homebrew/bin/dsh --profile web-test --port 3081 --no-open \
  > /tmp/dsh-web-test.log 2>&1 &
sleep 6 && rm -f /tmp/dsh-env.txt
```

Then verify: health 200, log starts with the `dsh web: http://127.0.0.1:3081`
line, no stack traces. Note the restart wipes all in-process bindings
(channel/thread/intents/turns are Maps until Phase 2) — re-run `/project bind`
after every restart.

## Observability conventions

- stderr log events (grep `[dsh-discord]`): `discord_slash_dispatch`,
  `discord_project_list_start`, `discord_project_bind_planned`,
  `discord_project_bind_commit`, `discord_workspace_channel_create_failed`,
  `discord_followup_failed`, `discord_ack_failed`,
  `discord_workspace_list_*`, `discord_prompt_submit_*`, and the mainline
  pair `discord_mention_admitted` / `discord_mention_not_admitted`.
- A silent failure is a bug: every REST outcome is logged; the REST client
  resolves (never rejects) 4xx/5xx outcomes, so a `void`-ed call drops
  failures without a trace. Never add `void rest.request(...)`.

## Discord-side manual steps (need a human in the test Guild)

Agents cannot drive the Discord client. Ask the user to run, in order, and
check both the Discord surface and the log sequence:

| Step | Discord | Expected log pair |
| --- | --- | --- |
| `/project bind` (autocomplete narrows as you type) | confirm button → provisioning reply | `discord_slash_dispatch` → `discord_project_bind_planned` → `discord_project_bind_commit` |
| `/project list` | ephemeral name-only list | `discord_project_list_start` |
| `/project info` (in the workspace channel) | title/revision/binder/path | — |
| `@bot <task>` in the workspace channel | new Thread + queued notice | `discord_mention_admitted` |
| follow-up message in the Thread | queued continuation | — |
| `/stop` / `/steer` (in the Thread) | acknowledgement / refusal copy | — |

Known environment hazards (from 15.9 prerequisites): npm's default cache may
have root-owned files (`sudo chown -R 501:20 ~/.npm`); pnpm and
`--cache <dir>` work around it, the profile install does not.

## After testing

1. Leave the test instance running or stop it cleanly; either way the next
   deploy repeats the handoff procedure.
2. **Reset the bot token in the Discord developer portal** — it has crossed
   multiple sessions and terminals. Never paste the token anywhere.
