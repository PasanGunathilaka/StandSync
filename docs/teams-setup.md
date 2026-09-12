# Teams setup

StandSync runs the Teams SDK **on the existing Fastify server** via a custom
`IHttpServerAdapter`. There is one HTTP process and one port: Fastify serves
`/health`, the `/dev/*` endpoints, and the Teams messaging endpoint
(`/api/messages`) side by side.

```
                       ┌──────────────────────────── Fastify (PORT) ───────┐
Teams channel ──POST──▶│ /api/messages ─ FastifyHttpServerAdapter          │
                       │                   └─▶ Teams SDK App              │
                       │                        ├─ on('message')          │
curl / dev:post ──────▶│ /dev/standup  ─────────┤                         │
                       │ /dev/approve/:id ──────┤   runStandupPipeline()   │
                       │ /dev/reject/:id        │   executeBatch()         │
                       │ /health                │                         │
                       └───────────────────────────────────────────────────┘
```

Both entry points call the **same** `runStandupPipeline` and `executeBatch`, so
the fallback demo path cannot drift from the real one.

## 1. Register the bot

You need an Azure Bot (or Entra app registration) to get a client id/secret.

1. Azure Portal → **Create a resource** → **Azure Bot**.
2. Type of App: **Multi Tenant** (or Single Tenant if your org requires it).
3. After creation: **Configuration** → copy the **Microsoft App ID**.
4. **Manage Password** → **New client secret** → copy the value immediately.
5. Set **Messaging endpoint** to `https://<your-tunnel>/api/messages` (step 3).
6. **Channels** → add **Microsoft Teams**.

Put the values in `.env`:

```
MICROSOFT_APP_ID=<app id>
MICROSOFT_APP_PASSWORD=<client secret>
MICROSOFT_APP_TENANT_ID=<tenant id, only for single-tenant apps>
```

StandSync logs a warning and disables Teams entirely if the id/secret are unset —
the `/dev/*` endpoints keep working.

## 2. Start StandSync

```bash
npm run dev
```

You should see `Teams endpoint mounted on Fastify` and `/api/messages (POST)` in
the route list.

## 3. Expose it with a tunnel

Teams must reach your machine over HTTPS. Either tool works:

```bash
# Microsoft dev tunnels
winget install Microsoft.devtunnel
devtunnel user login
devtunnel host -p 3978 --allow-anonymous

# or ngrok
ngrok http 3978
```

Copy the public HTTPS URL into the bot's **Messaging endpoint** as
`https://<host>/api/messages`.

## 4. Package and sideload the app

`appPackage/manifest.json` is ready; `${{MICROSOFT_APP_ID}}` must be replaced
with your real app id.

```bash
cd appPackage
# add color.png (192x192) and outline.png (32x32) first
zip -r ../standsync-teams.zip manifest.json color.png outline.png
```

In Teams: **Apps** → **Manage your apps** → **Upload an app** → **Upload a custom
app** → pick `standsync-teams.zip` → **Add to a team** → choose the standup channel.

> If **Upload a custom app** is missing, your tenant has custom app uploading
> disabled. See "Tenant blockers" below.

## 5. Lock StandSync to one channel

StandSync **fails closed**: with `TEAMS_ALLOWED_CONVERSATION_ID` unset it ignores
every message. Post anything in the target channel and read the log:

```
WARN: TEAMS_ALLOWED_CONVERSATION_ID is not set, so StandSync is ignoring this
      message. To enable this channel, set
      TEAMS_ALLOWED_CONVERSATION_ID=19:abc...@thread.tacv2
```

Copy that id into `.env` and restart. This is deliberate — a bot that writes to a
real Jira project should not act on any channel it happens to be added to.

## 6. Smoke test

1. Post: `Yesterday I completed TES-41. Today I am working on TES-42. TES-43 is blocked because I am waiting for API credentials.`
2. StandSync replies in-thread with the proposal card.
3. Click **Approve All** → card becomes **Applying to Jira…** → then the result card.
4. Check Jira.

## Configuration reference

| Variable                                      | Purpose                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD` | Bot credentials. Unset ⇒ Teams disabled.                                      |
| `MICROSOFT_APP_TENANT_ID`                     | Single-tenant apps only.                                                      |
| `TEAMS_ALLOWED_CONVERSATION_ID`               | The one channel StandSync listens to. Unset ⇒ ignores everything.             |
| `TEAMS_MESSAGING_ENDPOINT`                    | Defaults to `/api/messages`.                                                  |
| `TEAMS_ALLOW_UNAUTHENTICATED`                 | Local testing only. Skips Teams token validation. Never enable in production. |
| `APPROVAL_POLICY`                             | `anyone` (default) or `author_only`.                                          |

## Tenant blockers

Sideloading is an admin-controlled setting. If it is off you will not see
**Upload a custom app**.

- **Teams admin center** → Teams apps → **Setup policies** → Global → enable
  _Upload custom apps_. Requires Teams Administrator.
- Some tenants also block creating Azure Bot resources or consenting to new app
  registrations.

**If any of this is blocked, StandSync is still fully demonstrable.** The
`/dev/*` endpoints run the identical pipeline and executor:

```bash
npm run seed:jira
npm run dev
npm run dev:post                       # proposal batch, nothing written
curl -X POST http://127.0.0.1:3978/dev/approve/<batchId>   # applies to Jira
```

## Troubleshooting

| Symptom                                                       | Cause                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AADSTS700016: Application with identifier ... was not found` | App id/secret wrong, or app not registered in this tenant.                                                                                  |
| Card appears but buttons do nothing                           | Messaging endpoint not reachable — check the tunnel is still up.                                                                            |
| Bot never replies                                             | Conversation id not in `TEAMS_ALLOWED_CONVERSATION_ID` (see step 5), or the message contained no Jira keys.                                 |
| `EADDRINUSE :3978`                                            | An orphaned dev server. `Get-NetTCPConnection -LocalPort 3978 -State Listen \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }` |
| Every request 401                                             | Credentials unset and `TEAMS_ALLOW_UNAUTHENTICATED=false`. Expected — set real credentials.                                                 |
