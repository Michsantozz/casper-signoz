# SigNoz notification channels (versioned)

Every alert rule in `../alerts/` routes to a channel **named `casper-default`**
(`condition.thresholds.spec[0].channels`). SigNoz resolves that reference by
name at fire time and does not create it — so on a fresh instance the rules
import cleanly and then have nowhere to deliver. `casper-default.json` is what
closes that gap: the channel definition, versioned next to the rules that name
it.

| File | Type | Destination |
|------|------|-------------|
| `casper-default.json` | webhook | `http://localhost:9099/webhook` |

The destination is a **local placeholder**, deliberately: it makes delivery
observable end to end (point any request sink at `:9099`) without wiring a real
Slack or PagerDuty account into a versioned file. Change `url` to the real
endpoint before this pages anyone.

## Create

Channel creation is **admin-only** — a service-account API key gets
`403 authz_forbidden` on this route, so use an admin session or an admin key:

```bash
curl -X POST http://localhost:8090/api/v1/channels \
  -H 'Content-Type: application/json' \
  -H "SIGNOZ-API-KEY: $SIGNOZ_ADMIN_API_KEY" \
  --data @casper-default.json
```

Then confirm the name the rules reference actually exists:

```bash
curl -s http://localhost:8090/api/v1/channels \
  -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" | jq '.data[].name'
```

Create the channel **before** importing the rules, so their `channels`
reference resolves on the first evaluation.

## Provenance

This file is a verbatim capture of the channel as the live instance stores it
(read back from `GET /api/v1/channels`, whose `data` field holds exactly this
Alertmanager receiver object). The `POST` above was not executed against the
instance during authoring — the key on hand was a service account, which the
route rejects.
