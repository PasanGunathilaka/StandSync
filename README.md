<p align="left">
  <img src="docs/assets/standsync-logo-horizontal.png" alt="StandSync" width="760" />
</p>

<p align="left">
  <strong>"Your team talks. Jira stays current."</strong>
</p>

<p align="left">
  <strong>Claude-powered standup automation for Microsoft Teams and Jira.</strong><br/>
  Turn a normal standup message into reviewed Jira updates — without making developers enter the same information twice.
</p>

---

## StandSync V2 — agentic natural standup intelligence

V2 removes the `@StandSync` prefix.

With ambient mode enabled, a developer just types into the channel:

> Finished TES-31 today. Starting TES-42 next.

StandSync is listening. It decides for itself whether the message is any of its business, interprets it, reads the real Jira state, has a second reasoning stage argue with the first, asks a question when the update is genuinely ambiguous, and only then shows an Adaptive Card.

The one thing that has not changed is the part that matters:

> **Claude never writes to Jira.** Every mutation still goes through the same human-approved `executeBatch()` boundary V1 shipped with.

### What V2 adds

|                                       |                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Natural channel listening**         | No `@mention` needed. Uses Teams resource-specific consent (`ChannelMessage.Read.Group`), opt-in per conversation.                                                      |
| **Silence as a feature**              | Receiving every message and replying to every message are different things. Greetings, thanks, emoji, lunch plans and unrelated chatter get no visible response at all. |
| **Bounded multi-agent reasoning**     | Six narrow reasoning stages, each with a typed schema and no tool access.                                                                                               |
| **Deterministic Jira context**        | Application code reads Jira and hands agents a sanitized snapshot. Transition ids never reach a model.                                                                  |
| **A critic stage**                    | A second pass whose job is to _disagree_ — catching "finished coding" on a workflow whose next step is Code Review.                                                     |
| **Clarification instead of guessing** | "TES-31 is basically finished" gets a question, not a confident wrong card.                                                                                             |
| **Blocker intelligence**              | Structured, de-duplicated blocker tracking that feeds team summaries.                                                                                                   |
| **One decision policy**               | Every threshold in `src/policy/decision-policy.ts`, tested branch by branch.                                                                                            |
| **Team summaries**                    | On demand, grounded in StandSync's own records — never in a model's impression of the project.                                                                          |

### The behaviour that defines it

```text
"Good morning guys"                       → silence
"Anyone going for lunch?"                 → silence
"thanks"                                  → silence
👍                                        → silence
"Finished TES-31."                        → proposal card, pre-selected
"TES-42 is blocked waiting for API keys"  → comment proposed + blocker recorded
"TES-31 is basically finished."           → clarification card, nothing proposed
"Finished coding TES-31."                 → flagged: Code Review comes before Done
```

### Enabling it

Ambient mode is **off by default**. V1 mention-based behaviour is exactly preserved until you turn it on:

```bash
STANDSYNC_AMBIENT_MODE=true
TEAMS_ALLOWED_CONVERSATION_ID=19:...@thread.tacv2
```

There is deliberately no wildcard — ambient listening is granted per conversation, so adding the app to a new channel cannot silently start feeding that channel into a Jira-mutating pipeline. See [docs/teams-setup.md](docs/teams-setup.md#8-v2-enabling-no-mention-channel-listening) for the consent steps.

---

## StandSync V1

StandSync is a Microsoft Teams application that understands daily standup updates and turns them into proposed Jira actions.

A developer writes what they normally would:

> **@StandSync** Yesterday I completed TES-41. Today I am working on TES-42. TES-43 is blocked because I am waiting for API credentials.

StandSync then:

1. Detects the Jira tickets.
2. Reads their current state from Jira.
3. Uses Claude to understand what the developer actually meant.
4. Builds proposed status changes and comments.
5. Shows them as an Adaptive Card in Teams.
6. Waits for a human to approve.
7. Updates Jira only after approval.

<p align="center">
  <img src="docs/assets/standsync-teams-demo.png" alt="StandSync Teams demo" width="850" />
</p>

---

## The problem

Developers already describe their progress during standup.

Then they often have to open Jira and enter the same information again.

That creates duplicate work:

```text
Standup in Teams
      ↓
"I finished TES-41"
      ↓
Open Jira
      ↓
Find TES-41
      ↓
Move it to Done
```

When that second step gets skipped, Jira becomes stale.

StandSync removes the duplicate step.

```text
Teams standup
      ↓
   StandSync
      ↓
Claude understands intent
      ↓
StandSync checks live Jira state
      ↓
Proposed Jira changes
      ↓
Human approves
      ↓
Jira updated
```

---

## Why Claude?

A simple keyword rule can understand:

```text
"Completed AP-92"
```

But real standups are rarely that simple.

For example:

```text
"Mostly finished AP-92, but QA found another issue.
Don't close it yet."
```

A rule may see **finished** and move the ticket to Done.

StandSync understands that the developer explicitly said **not to close it**.

Another example:

```text
"Working on AP-92 but blocked waiting for credentials."
```

StandSync can understand both facts:

- the ticket is being worked on
- there is a blocker worth recording in Jira

Claude's job is only to interpret the meaning of the standup.

It does **not** update Jira.

---

## Safe by design

> **AI recommends → Human approves → StandSync executes.**

Claude never has direct write access to Jira.

The safety boundary is deliberately separated:

```text
Claude
  ↓
Intent only
  ↓
StandSync proposal engine
  ↓
Teams approval
  ↓
Human
  ↓
StandSync Jira executor
  ↓
Jira REST API
```

StandSync V1 includes:

- **Approve All**
- **Review individual proposals**
- **Apply Selected**
- **Reject**
- Low-confidence proposals start unselected
- Live Jira state validation
- Live Jira transition lookup
- No hard-coded transition IDs
- Atomic protection against double approval
- SQLite audit history
- Sanitised error handling

A second approval cannot accidentally apply the same Jira changes twice.

---

## What StandSync understands

Claude classifies each mentioned ticket into one of six intents:

| Intent         | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| `completed`    | Work is complete                                      |
| `in_progress`  | Work has started / is continuing                      |
| `blocked`      | Work is blocked                                       |
| `not_done_yet` | Work is not ready to close                            |
| `no_change`    | No Jira action is required                            |
| `unclear`      | StandSync is not confident enough to infer the intent |

Each interpretation also includes:

- confidence
- evidence from the original standup
- blocker reason where applicable
- suggested comment where useful

StandSync then combines that intent with the ticket's **actual current Jira state** before proposing an action.

---

## Multi-project support

StandSync V1 is not tied to the demo `TES` project.

The runtime is project-agnostic.

A single standup can contain:

```text
TES-41
AP-92
BCPM-33
```

StandSync reads each ticket directly from Jira and resolves its available transitions independently.

The only requirements are:

- the configured Jira account can access the ticket
- the project's workflow statuses are known to StandSync

Projects with different terminology can use per-project overrides:

```env
JIRA_STATUS_OVERRIDES={"BCPM":{"done":"Closed","inProgress":"Doing"}}
```

`JIRA_PROJECT_KEY` is used only by the demo ticket seeding script.

---

## V1 features

StandSync V1 currently includes:

- Microsoft Teams bot/application
- `@StandSync` standup invocation
- Teams Adaptive Cards
- Jira ticket detection
- Multiple Jira projects in one standup
- Live Jira issue-state lookup
- Live Jira transition lookup
- Claude-powered intent interpretation
- Confidence and evidence
- Proposed Jira transitions
- Proposed Jira comments
- Approve All
- Review and Apply Selected
- Reject
- Human approval before every Jira write
- Jira Cloud REST API v3 integration
- SQLite audit trail
- Double-approval protection
- Per-project workflow overrides
- Mock LLM provider for offline testing
- Claude Code provider
- Optional Anthropic provider
- Teams-free development endpoints
- Real Teams → Claude → Jira end-to-end verification

---

## Architecture

```text
                    ┌───────────────────┐
                    │  Microsoft Teams  │
                    └─────────┬─────────┘
                              │
                        Standup message
                              │
                              ▼
                    ┌───────────────────┐
                    │     StandSync     │
                    │      Fastify      │
                    └─────────┬─────────┘
                              │
                    Detect Jira tickets
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
        ┌─────────────────┐       ┌─────────────────┐
        │      Jira       │       │     Claude      │
        │ status + live   │       │ interpret only  │
        │   transitions   │       │                 │
        └────────┬────────┘       └────────┬────────┘
                 └────────────┬────────────┘
                              ▼
                    ┌───────────────────┐
                    │ Proposal engine   │
                    └─────────┬─────────┘
                              ▼
                    ┌───────────────────┐
                    │ Teams Adaptive    │
                    │       Card        │
                    └─────────┬─────────┘
                              │
                        Human approval
                              │
                              ▼
                    ┌───────────────────┐
                    │ Jira REST API     │
                    │ transition/comment│
                    └───────────────────┘
```

### V2 agentic architecture

The V1 diagram above is still the shape of the system. V2 adds reasoning stages
around it — and, critically, adds nothing below the approval line.

```text
                        Teams Channel
                     (no @mention needed)
                              │
                              ▼
                       Message Ingress                    ← deterministic:
                   bot / system / duplicate /               no model calls,
                   chatter / unconfigured channel           no Jira reads
                              │
                              ▼
                    Relevance Classifier  ─────────────▶  irrelevant → SILENCE
                              │
                              ▼
                    Standup Interpreter
                              │
                              ├──────────▶ Jira Context Service
                              │            (application code, read-only,
                              │             sanitized, no transition ids)
                              ◀──────────────────┘
                              │
                              ▼
                    Proposal Validator                    ← argues with the
                  (+ deterministic Jira facts,              interpreter; can
                     which always override)                 only tighten
                              │
                              ▼
                 Ambiguity / Risk Decision
                  src/policy/decision-policy.ts
                        ╱           ╲
                       ╱             ╲
                  Clarify          Propose
                   card             card
                       ╲             ╱
                        ╲           ╱
                         ▼         ▼
                     Adaptive Card in Teams
                              │
                    ══════════╪══════════   ← THE TRUST BOUNDARY
                       HUMAN APPROVAL          nothing below this line
                    ══════════╪══════════      runs without a human click
                              │
                              ▼
                       executeBatch()                     ← the ONLY Jira
                   claim-then-act, idempotent               write path
                              │
                              ▼
                             Jira
```

An answered clarification re-enters at **Standup Interpreter** — it produces an
ordinary proposal that still needs approving. Answering a question and
authorising a write are two separate clicks, on purpose.

Parallel observational path, which never reaches Jira:

```text
                    Validated Standup
                              │
                              ▼
                    Blocker Intelligence
                   (de-duplicated per issue,
                    surfaced once, not nagged)
                              │
                              ▼
                       Team Summary
                  grounded in stored records
                    ── read-only, always ──
```

### Where the reasoning lives

```text
src/agents/      the bounded agents: deterministic policy wrapped around a skill
  runAgent.ts        the single place any agent calls a model
  orchestrator.ts    ingress → classify → context → interpret → validate
                     → ambiguity → blockers → policy → card
  message-classifier / standup-interpreter / proposal-validator
  ambiguity-agent / blocker-agent / summary-agent / clarification

src/skills/      the reasoning modules: prompt + JSON schema + zod + typed IO
  detect-standup  interpret-work  validate-proposal  detect-ambiguity
  detect-blockers  summarize-team  explain-proposal (deterministic)

src/policy/decision-policy.ts   every threshold, one place
src/jira/context.ts             deterministic, sanitized Jira reads
src/teams/ambient.ts            pre-model ingress filtering
src/observe/stages.ts           typed stage logging
src/approval/migrations.ts      versioned SQLite migrations
```

**Skills** are prompt + schema + call. **Agents** are the deterministic policy
around a skill — fast paths, reconciliation, Jira cross-checks, fail-closed
defaults. That is where "don't trust the model" lives, and it is why the split
is not ceremony.

### Main components

- **Microsoft Teams SDK** — receives standups and handles Adaptive Card actions
- **Fastify** — HTTP server
- **StandSync pipeline** — ticket detection, interpretation and proposal generation
- **V2 orchestrator** — the bounded agent stages and the decision policy
- **LLMClient** — provider-independent Claude interface; every agent goes through it
- **Jira client** — Jira Cloud REST API v3
- **JiraContextService** — read-only, sanitized Jira snapshots for the agent layer
- **SQLite** — batches, proposals, approvals, results, message events, agent runs, clarifications, blockers
- **Approval executor** — the only path allowed to perform Jira writes

### Why Claude cannot write to Jira

Not a convention — four enforced properties, each covered by a test in
[test/safety.test.ts](test/safety.test.ts):

1. **One call site.** `transitionIssue` / `addComment` have exactly one caller:
   `src/approval/execute.ts`. A second caller fails the build.
2. **No capability in the agent layer.** Nothing under `src/agents/` or
   `src/skills/` may import `jira/actions`, `approval/execute`, or construct a
   `JiraClient`. `AgentDeps` grants an LLM client, a store and a logger.
3. **No credentials, no ids.** Agents never read `JIRA_API_TOKEN`, and the
   sanitized `IssueContext` handed to a model carries status _names_ but no
   transition ids — and a transition id is what actually performs a write.
4. **Claim before act.** `executeBatch()` moves the batch out of `pending` in a
   single conditional SQL update _before_ the first Jira call, so a replayed
   click returns the recorded outcome instead of re-applying.

---

## Quick start

### Requirements

- Node.js 20+
- Microsoft Teams bot/application credentials
- Jira Cloud account with API access
- Claude Code login or Anthropic API credentials

### Install

```bash
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

Fill in the required values in `.env`.

Never commit `.env` or real credentials.

### Verify the project

```bash
npm run typecheck
npm run lint
npm test
```

### Start StandSync

```bash
npm run dev
```

Verify:

```text
GET /health
```

A healthy StandSync instance returns HTTP `200`.

---

## Teams usage

In the configured Teams conversation, mention StandSync and write a normal standup:

```text
@StandSync Yesterday I completed TES-41.
Today I am working on TES-42.
TES-43 is blocked because I am waiting for API credentials.
```

StandSync checks Jira and replies with proposed actions.

Example:

```text
TES-41
In Progress → Done

TES-42
To Do → In Progress

TES-43
Add blocker comment

[Approve All] [Review] [Reject]
```

Nothing is written to Jira yet.

After approval:

```text
✅ TES-41   In Progress → Done
✅ TES-42   To Do → In Progress
✅ TES-43   comment added
```

---

## Demo

The verified V1 demo uses three tickets:

| Ticket | Starting state | Standup intent | Result          |
| ------ | -------------- | -------------- | --------------- |
| TES-41 | In Progress    | Completed      | Done            |
| TES-42 | To Do          | Working on     | In Progress     |
| TES-43 | In Progress    | Blocked        | Blocker comment |

Example standup:

```text
@StandSync Yesterday I completed TES-41.
Today I am working on TES-42.
TES-43 is blocked because I am waiting for API credentials.
```

The full Teams → Claude → approval → Jira flow has been verified against:

- real Microsoft Teams
- real Claude
- real Jira Cloud

### V2 demo script

Every V2 stage is demonstrable without a Teams tenant. The dev endpoints call
the **same** `orchestrateMessage()` and `executeBatch()` the Teams handlers call,
so there is no demo-only code path.

```powershell
npm run seed:jira
npm run dev
```

**1. StandSync stays quiet.** Three messages, no cards, no noise:

```bash
for T in "Good morning everyone" "thanks!" "Anyone going for lunch?"; do
  curl -s -X POST localhost:3978/dev/message \
    -H 'content-type: application/json' \
    -d "{\"text\":\"$T\",\"source\":\"ambient\"}" | jq -c '{kind, reason}'
done
# {"kind":"ignored","reason":"social_chatter"}       ← no model call at all
# {"kind":"ignored","reason":"social_chatter"}
# {"kind":"ignored","reason":"classified_irrelevant"}
```

**2. A real standup, with no @mention.** Three tickets, three intents:

```bash
curl -s -X POST localhost:3978/dev/message \
  -H 'content-type: application/json' \
  -d '{"text":"Finished TES-41. TES-43 is blocked waiting for API access. Starting TES-42.",
       "author":"Pasan","source":"ambient"}' | jq '{kind, rows: .summary.rows, blockers}'
```

Nothing is in Jira yet. Inspect exactly which stages ran and how long each took:

```bash
curl -s localhost:3978/dev/agents/<traceId> | jq '.stages'
# [ "interpret-work:ok:412ms", "validate-proposal:ok:388ms", "detect-blockers:ok:201ms" ]
```

**3. Approve — now Jira changes:**

```bash
curl -s -X POST localhost:3978/dev/approve/<batchId> | jq '{status, summary}'
curl -s -X POST localhost:3978/dev/approve/<batchId> | jq '.status'   # idempotent
```

**4. An ambiguous update asks instead of guessing:**

```bash
curl -s -X POST localhost:3978/dev/message \
  -H 'content-type: application/json' \
  -d '{"text":"TES-42 is basically finished.","author":"Pasan","source":"ambient"}' \
  | jq '.clarifications[0] | {question, options}'
```

Answer it — which produces a proposal that _still_ needs approving:

```bash
curl -s -X POST localhost:3978/dev/clarify/<clarificationId> \
  -H 'content-type: application/json' -d '{"optionId":"opt0"}' | jq '{kind, note}'
# { "kind": "resolved", "note": "A proposal was created. Nothing has been sent to Jira yet." }
```

**5. The team summary, grounded in what was actually recorded:**

```bash
curl -s localhost:3978/dev/summary | jq -r '.text'
curl -s localhost:3978/dev/blockers | jq '.blockers'
```

### Dev endpoints

| Endpoint                     | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `POST /dev/standup`          | V1 pipeline, unchanged                                           |
| `POST /dev/message`          | V2 orchestrator. `source: ambient` runs the relevance classifier |
| `POST /dev/clarify/:id`      | Answer a clarification → produces a pending proposal             |
| `GET /dev/clarification/:id` | Read a question and its options back                             |
| `POST /dev/approve/:id`      | The single Jira write path. Idempotent                           |
| `POST /dev/reject/:id`       | Records a rejection. Never calls Jira                            |
| `GET /dev/batch/:id`         | Batch plus recorded execution results                            |
| `GET /dev/agents/:traceId`   | Per-stage agent trace: model, duration, outcome                  |
| `GET /dev/summary`           | Generate a team summary on demand                                |
| `GET /dev/blockers`          | Open blockers for a conversation                                 |

---

## Testing

Current V2 status:

```text
656 tests passing, 4 skipped (live, opt-in with LIVE=1)
TypeScript typecheck: clean
ESLint: clean
Prettier: clean
Build: clean
```

The default test suite makes no network calls. Jira is a stubbed `fetch`, so the
real client, context service, status mapping and proposal builder all execute —
and every test can assert that no Jira mutation was attempted.

V2 test coverage:

| File                        | Covers                                                          |
| --------------------------- | --------------------------------------------------------------- |
| `test/safety.test.ts`       | The trust boundary, as build-breaking architecture guards       |
| `test/orchestrator.test.ts` | Both E2E scenarios, ambient filtering, dedup, validation gating |
| `test/policy.test.ts`       | Every branch of the decision policy                             |
| `test/agents.test.ts`       | Each bounded agent's deterministic wrapper and fail-closed path |
| `test/skills.test.ts`       | Prompt contracts, schema round-trips, rendered prompts          |
| `test/ambient.test.ts`      | Ingress filtering, chatter detection, ambient-off preservation  |
| `test/storeV2.test.ts`      | Dedup, bounded context, blocker de-duplication, clarifications  |
| `test/migrations.test.ts`   | A live V1 database upgraded in place, with its data intact      |
| `test/cardsV2.test.ts`      | What a user can read and what they can click                    |
| `test/devRoutes.test.ts`    | The dev path drives the same orchestrator and executor          |

V1 tests cover areas including:

- ticket extraction
- Claude interpretation
- malformed model output
- timeouts and provider failures
- proposal generation
- Jira transition resolution
- multi-project standups
- project-specific workflow statuses
- Adaptive Card payloads
- approval/rejection
- duplicate approval protection
- Jira client failures and retries
- audit persistence
- safety boundaries

Live integration tests are kept separate from the default offline suite.

---

## Scripts

| Script               | Purpose                                         |
| -------------------- | ----------------------------------------------- |
| `npm run dev`        | Start StandSync with hot reload                 |
| `npm run typecheck`  | Run strict TypeScript validation                |
| `npm run lint`       | Run ESLint                                      |
| `npm test`           | Run the offline Vitest suite                    |
| `npm run seed:jira`  | Create/reset demo Jira tickets                  |
| `npm run dev:post`   | Send a standup through the development endpoint |
| Teams package script | Build the Microsoft Teams installation package  |

---

## Boundaries

### Resolved in V2

- ~~Teams messages require an `@StandSync` mention~~ — ambient mode, via RSC
- ~~Automatic standup monitoring~~ — shipped
- ~~Blocker reporting~~ — structured, de-duplicated, feeds summaries

### Current limitations

**Teams / RSC**

- **Private channels are not covered.** `ChannelMessage.Read.Group` is granted
  per team; a private channel has its own membership. `@StandSync` still works there.
- **Shared channels (Teams Connect) are not supported** for ambient listening —
  cross-tenant membership is outside the RSC grant. Treat them as mention-only.
- Meeting chats are not covered.
- RSC is a live feed, not history: messages posted before install are never seen.
- Installing into a second team needs that team's owner to consent again.
- A deleted message does not retract an already-posted proposal card; the batch
  stays `pending` and can be rejected.

**Reasoning**

- Work described with no Jira key is classified and recorded, but cannot produce
  a proposal — there is nothing to propose against. StandSync does not guess
  which ticket you meant from a description alone.
- Thread context is bounded (default 5 messages, 2 hours). A conversation that
  resolves an ambiguity over more turns than that will not be fully joined up.
- Clarification options can only offer statuses the live workflow can reach, so
  a misconfigured workflow yields fewer options rather than better ones.
- The intent vocabulary is six values. A clarification can name an arbitrary
  destination status explicitly; an _interpretation_ still maps onto those six.

**Deployment**

- Jira writes use a shared service account, so Jira attributes the change to
  StandSync and names the author in the comment rather than acting as them.
- Some Jira projects need `JIRA_STATUS_OVERRIDES` for renamed statuses.
- SQLite is local to the instance. Two instances behind one endpoint would
  deduplicate independently.
- Runs locally behind a Microsoft dev tunnel; not yet a cloud service.

---

## Roadmap

- **Scheduled summaries** — `generateSummary()` is deliberately uncoupled from
  scheduling, so this is a scheduler, not a rewrite
- **Production cloud hosting** and a managed database
- **Per-user Jira attribution** via delegated OAuth
- **Workflow auto-discovery**, removing status overrides
- **Stale Jira ticket detection**
- **Resolving work described without a ticket key**, using sprint context
- **Adoption reporting** — approve/reject rates per proposal kind, to tune the
  decision policy against real behaviour rather than guesses

---

## Design principle

StandSync deliberately separates **understanding** from **acting**.

Claude can say:

> “I believe TES-41 was completed.”

But Claude cannot transition TES-41.

Only StandSync's deterministic application code can determine the Jira action, and only after a human approves it.

That distinction is the foundation of StandSync V1.

---

<p align="center">
  <strong>StandSync V1</strong><br/>
  <em>Your team talks. Jira stays current.</em>
</p>
