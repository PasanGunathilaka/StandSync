# Demo runbook

Everything needed to take StandSync from "VS Code just opened" to "the Adaptive
Card is on screen", and what to do when it misbehaves.

## One command

```powershell
npm run demo
```

That is the whole happy path. It:

1. **Checks** config, the Claude CLI, Jira, Teams credentials, the dev tunnel and
   the port — before starting anything.
2. **Clears** a stale StandSync still holding port 3978. It will never kill a
   process that is not StandSync.
3. **Hosts the persistent `standsync` tunnel** — never a new random one, so the
   public URL stays stable and the bot registration keeps working.
4. **Verifies the live tunnel URL matches `TEAMS_PUBLIC_URL`**, which catches the
   case where the tunnel URL changed and the Developer Portal did not.
5. **Starts StandSync** with `CLAUDE_CODE_PATH` pinned to an absolute path, so
   interpretation no longer depends on how the terminal inherited `PATH`.
6. **Verifies the public chain**: local `/health`, public `/health`, and
   `POST /api/messages` (expects **401** — mounted with authentication enforced).
7. **Prints the exact Teams message to send.**

It starts nothing unless every check passes — a demo that half starts is worse
than one that refuses to. **Ctrl+C stops StandSync and the tunnel together.**

Expected final output:

```
READY — send this in the Teams channel:

    @StandSync I completed TES-18

  tunnel     https://<your-tunnel>.devtunnels.ms
  endpoint   https://<your-tunnel>.devtunnels.ms/api/messages
  channel    19:...@thread.v2
  claude     C:\...\WinGet\Links\claude.exe
```

## Other commands

| Command             | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `npm run preflight` | Run the checks only, start nothing. Use the morning of a demo.                  |
| `npm run demo:stop` | Kill leftover StandSync / tunnel processes, including a `tsx watch` supervisor. |
| `npm run seed:jira` | Reset the TES demo tickets to their starting state.                             |
| `npm run dev`       | Server only — no tunnel, no checks. For unit work, not demos.                   |

## Why the tunnel is started automatically

It is the single most common cause of a dead demo, and it fails **silently from
Teams' side** — Teams shows nothing at all, so it looks like the bot is broken.
Hosting an existing _named_ tunnel is idempotent and safe, so there is no reason
to make it a separate manual step.

`devtunnel list` showing `Host Connections: 0` means Teams cannot reach this
machine, no matter how healthy the server looks locally.

## Before a competition demo

Run in order:

```powershell
npm run demo:stop     # clear anything left from last time
npm run seed:jira     # TES-41 In Progress, TES-42 To Do, TES-43 In Progress
npm run demo          # must end with READY
```

Then confirm in Teams that the bot still appears in the channel, and post:

```
@StandSync I completed TES-18
```

Leave the `npm run demo` terminal open for the whole demo.

## If Teams does not respond

Work down this list; each step rules out one layer.

| #   | Check                                     | Command / expectation                                                                                                                           |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Did you **@mention** the bot?             | StandSync only receives mentioned messages. A plain message is never delivered to it.                                                           |
| 2   | Is the tunnel hosted?                     | `devtunnel list` → `Host Connections` must be **1**, not 0.                                                                                     |
| 3   | Is the public endpoint alive?             | `curl https://<tunnel>/health` → **200**                                                                                                        |
| 4   | Is the bot endpoint mounted?              | `curl -X POST https://<tunnel>/api/messages` → **401** (401 is correct: auth enforced. **404** means Teams is disabled)                         |
| 5   | Does the Developer Portal endpoint match? | Bot → _Endpoint address_ must equal the URL `npm run demo` printed, plus `/api/messages`.                                                       |
| 6   | Is the channel allow-listed?              | The log line `allowedConversation` must show the conversation id, not `(not set — will ignore all)`.                                            |
| 7   | Did interpretation fail?                  | Look for `interpretation provider failed` in the log. The error now names the cause, e.g. `Claude Code exited with code 1 (API status 404): …`. |
| 8   | Fallback                                  | The `/dev/*` path runs the identical pipeline: `npm run dev:post`, then `curl -X POST http://127.0.0.1:3978/dev/approve/<batchId>`.             |

## Known operational facts

- **`claude.exe` is on the USER PATH only.** `npm run demo` resolves it to an
  absolute path and passes it to the server, so this no longer matters. If you
  start the server another way, set `CLAUDE_CODE_PATH` in `.env`.
- **`npm run dev` is `tsx watch`** — a supervisor. Killing the child makes it
  respawn immediately on port 3978, which looks like "the port is stuck". Use
  `npm run demo:stop`.
- **The tunnel dies with its terminal.** Closing the `npm run demo` window ends
  the demo.
- **The dev tunnel expires after 30 days.** `devtunnel list` shows the remaining
  time.
