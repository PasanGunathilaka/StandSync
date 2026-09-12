# StandSync

**Your team talks. Jira stays current.**

StandSync reads daily standup messages in a Microsoft Teams channel, uses Claude to
understand what happened to each Jira ticket mentioned, checks the real current state of
those tickets in Jira, proposes status transitions and comments as an Adaptive Card, and
— only after a human clicks **Approve** — updates Jira via the REST API.

> **Non-negotiable rule:** Claude never modifies Jira. Claude only interprets and
> recommends. The flow is always **AI recommends → Human approves → StandSync executes.**

## Status

Phase 1 (skeleton) complete. Full setup, demo script, architecture diagram and
troubleshooting are written in Phase 7.

## Quick start

```bash
npm install
cp .env.example .env   # then fill in the blanks
npm run typecheck
npm run dev
```

`GET /health` confirms the service is up.

## Scripts

| Script              | What it does                                 |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Start with hot reload (tsx watch)            |
| `npm run typecheck` | TypeScript strict check, no emit             |
| `npm run lint`      | ESLint (type-aware)                          |
| `npm test`          | Vitest — no network calls in the default run |
| `npm run seed:jira` | Create/reset the demo tickets                |
| `npm run dev:post`  | POST a fake standup to `/dev/standup`        |
