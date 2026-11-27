# Invoice sync

Keeps receivable Invoices, and the Payments applied to them, in agreement between an Internal System and a QuickBooks Online (QBO) sandbox company, in both directions. It stays correct when notifications are duplicated, delayed, reordered or lost, and when either API times out after a write has landed.

It is built against the real QBO Accounting API and verified on a QBO sandbox company: the spike script checked every QBO behaviour the design relies on, and the live run passed all 8 core scenarios there (see "Sandbox findings" in [docs/DESIGN.md](docs/DESIGN.md)). The bundled mock QBO exists only so the stack can be reviewed without an Intuit account; [Run against the QBO sandbox](#run-against-the-qbo-sandbox) switches to the real one.

- **Live:** <https://trashlab.agustinzago.com>. The web console, hosted on Railway and connected to the QBO sandbox company; the sign-in password is shared separately. See [Hosted deployment](#hosted-deployment).
- **Design:** [docs/DESIGN.md](docs/DESIGN.md). How it works, write safety, tradeoffs and known limits.
- **Vocabulary:** [CONTEXT.md](CONTEXT.md). Change Hint, Link, Base, Conflict and the other terms used below.
- **Decisions:** [docs/adr/](docs/adr/). The three-way merge, and syncing the ledger through Account Mapping.

## Quick start (no accounts needed)

You need only Docker. Every setting has a working default, and QBO is replaced by a mock QBO service, so no `.env` file and no Intuit account are needed:

```bash
docker compose up -d --build
```

This starts:

| Service | Address | What it is |
|---|---|---|
| Web console | <http://localhost:8088> | Sign in with `admin` / `admin` |
| Sync service | <http://localhost:3000> | Webhooks, worker, `/admin` page |
| Internal System | <http://localhost:3001> | The invoicing API |
| Mock QBO | <http://localhost:4000> | Stands in for QBO; already connected |

The two Postgres databases start with them. The fastest check is the live run, which drives the core scenarios end to end through the running stack and prints what it verified: creates and edits both ways, a Conflict and its resolution, a duplicated notification, a Payment and a Void.

```bash
docker compose run --rm sync node sync/scripts/live-run.ts
```

The mock keeps its data in memory, so reset the whole stack rather than restarting the mock alone:

```bash
docker compose down -v
```

## Try it step by step

This walks through every case in the brief by hand. The steps were run in this order on a fresh stack, so the ids shown match. If you have done other things first, read the ids and SyncTokens from the query output instead. Start clean:

```bash
docker compose down -v && docker compose up -d --build
```

Sign in to the web console at <http://localhost:8088> with `admin` / `admin`. Each Invoice's page shows its sync state and its Sync history: what changed, what was written and whether it succeeded. The Review page lists Conflicts, Link Candidates, Needs Attention items and failed jobs.

The mock QBO has no screen, so its side is driven with `curl` against the same Accounting API endpoints QBO has. It accepts any bearer token, and sends its changes to the sync as signed webhooks every second. Set these once in your shell:

```bash
QBO=localhost:4000/v3/company/9130000000000000
AUTH='authorization: Bearer mock'
```

**1. An Invoice created internally appears in QBO.** In the console, open Customers and add `Acme Ltd`. Then open New invoice and enter:

- Invoice number `INV-1001`, customer Acme Ltd.
- One line: `Advice`, revenue category `consulting`, amount `500.00`.

Click Issue invoice. Its page shows it synced, and the history says "Created QBO Invoice 4 (DocNumber INV-1001)". In QBO:

```bash
curl -sG $QBO/query -H "$AUTH" --data-urlencode "query=select * from Invoice where DocNumber = 'INV-1001'"
```

It has the same DocNumber, customer and `TotalAmt` 500, with `"Id":"4"` and `"SyncToken":"0"`.

**2. A QBO edit reaches the Internal System.** Change the due date in QBO, as a sparse update with the current SyncToken:

```bash
curl -s -XPOST $QBO/invoice -H "$AUTH" -H 'content-type: application/json' -d '{"Id":"4","SyncToken":"0","sparse":true,"DueDate":"2027-01-15"}'
```

Within a couple of seconds INV-1001 shows the new due date in the console, with a history entry for the run that copied it.

**3. An Invoice created in QBO appears internally.**

```bash
curl -s -XPOST $QBO/invoice -H "$AUTH" -H 'content-type: application/json' -d '{"DocNumber":"INV-2001","CustomerRef":{"value":"3"},"TxnDate":"2026-11-02","Line":[{"DetailType":"SalesItemLineDetail","Amount":42,"Description":"Hosting","SalesItemLineDetail":{"ItemRef":{"value":"2"}}}]}'
```

INV-2001 appears in the console's invoice list: 42.00, revenue category `hosting`, linked to QBO Invoice 5. Customer `3` is Acme Ltd, which step 1 created in QBO, and Item `2` is Hosting.

**4. A duplicated notification changes nothing.** Send the same signed QBO webhook for INV-2001 three times:

```bash
BODY='{"eventNotifications":[{"realmId":"9130000000000000","dataChangeEvent":{"entities":[{"name":"Invoice","id":"5","operation":"Update","lastUpdated":"2026-11-24T00:00:00Z"}]}}]}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac dev-qbo-verifier -binary | base64)
for i in 1 2 3; do curl -s -XPOST localhost:3000/webhooks/qbo -H 'content-type: application/json' -H "intuit-signature: $SIG" -d "$BODY"; done
```

All three are accepted, but they collapse into one pending job. INV-2001's history gains a run that says "No changes" and wrote nothing. QBO still has one INV-2001, still at SyncToken `0`.

**5. The same Invoice edited in both systems.** Change INV-2001's line to 60 in QBO and to 70 internally. Paste both commands at once, so the sync sees both edits before it copies either:

```bash
curl -s -XPOST $QBO/invoice -H "$AUTH" -H 'content-type: application/json' -d '{"Id":"5","SyncToken":"0","sparse":true,"Line":[{"DetailType":"SalesItemLineDetail","Amount":60,"Description":"Hosting","SalesItemLineDetail":{"ItemRef":{"value":"2"}}}]}'
curl -s -XPATCH localhost:3001/invoices/2 -H 'content-type: application/json' -H 'if-match: 1' -d '{"lines":[{"description":"Hosting","amountCents":7000,"revenueCategory":"hosting"}]}'
```

Lines are a Financial Field, and both Sides changed them differently, so the sync raises a Conflict and pauses the whole Invoice instead of guessing. Review → Conflicts shows the last agreed value (42.00) and both Sides' values. Pick Keep QBO or Keep Internal, and both Sides end equal.

If the PATCH answers 409, the sync had already copied the QBO edit in between, so there is nothing to conflict with. Run the pair again with the new SyncToken and version.

**6. Payments.** On INV-1001's page, click Record payment: `300.00`, method `check`, reference `CHK-1`. The page shows 300.00 paid and a 200.00 balance. In QBO:

```bash
curl -sG $QBO/query -H "$AUTH" --data-urlencode "query=select * from Payment where PaymentRefNum = 'CHK-1'"
```

That is a 300 Payment applied to QBO Invoice 4, whose `Balance` is now 200 (rerun the step 1 query to see it). Payment Status is never copied: each Side derives it from the Payments applied.

**7. Void vs delete.** Void the CHK-1 payment from INV-1001's page, then void INV-1001 itself. Rerun both queries: the QBO Payment and Invoice now have `TotalAmt` 0 and `PrivateNote` "Voided", and INV-1001's history says its Link is closed.

Delete is different. Only a draft can be deleted internally (Delete draft), and drafts never reach QBO. In QBO, an Invoice is treated as deleted only when a Delete notification confirms it, never on a not-found alone. A deleted QBO Invoice voids the internal one.

**8. A partially paid Invoice edited.** Create and issue `INV-1002`: one `consulting` line of `500.00`. Record a `300.00` payment on it, then edit its line down to `200.00`. The new total would be below what is paid, so the sync doesn't push it. Review → Needs attention says "Internal edit would set the total to 200.00, below the 300.00 already paid in QBO". The same edit made in QBO, the book of record, would be accepted.

**9. The ledger check.** Compare QBO's posted totals and balances with the Internal System's, read-only:

```bash
docker compose run --rm sync node sync/src/cli.ts reconcile
```

It lists INV-1002, which step 8 left different on purpose, with both Sides' totals and balances. Every other linked Invoice agrees.

**10. Duplicated, delayed and reordered notifications.** Restart the Internal System with `CHAOS=1`, and it duplicates, delays and reorders its own notifications on purpose:

```bash
CHAOS=1 docker compose up -d internal-system
```

Create and edit a few Invoices in the console. Each still ends with one QBO Invoice that matches it, because a notification only says "look at this record": every run refetches both Sides, so order and repeats don't matter.

**11. What can't be done by hand.** Timeouts after a write, 500 and 429 errors, retries after partial success and expired tokens need fault injection, so the tests cover them (see [Tests](#tests)). For example, `sync/test/write-safety.test.ts` covers a create that times out after QBO committed it and is retried, and a QBO write that succeeds while the internal write fails. Invoices that already exist on both Sides with no Link are adopted by the backfill command (see [Commands](#the-internal-system-api)), and `sync/test/backfill.test.ts` covers it.

## How the brief is covered

Tests are in `sync/test/` unless noted. The "how" column names the mechanism; [docs/DESIGN.md](docs/DESIGN.md) explains each one and its tradeoffs.

| Requirement or edge case | How | Tests |
|---|---|---|
| Invoice creation, both ways | DocNumber is the shared identity; a Link joins the pair | [tracer](sync/test/tracer.test.ts), [two-way](sync/test/two-way.test.ts) |
| Invoice updates | Three-way merge of both Sides against the Base stored on the Link | [two-way](sync/test/two-way.test.ts), [merge](sync/test/merge.test.ts) |
| Deletes vs voids | Voids sync both ways. Internally only drafts can be deleted; a QBO hard delete becomes an internal Void, but only when a Delete notification confirms it | [void](sync/test/void.test.ts), [cdc](sync/test/cdc.test.ts) |
| Payment status changes | Payments sync both ways (create and void); Payment Status is derived from them, never copied | [payments](sync/test/payments.test.ts), [internal payments](internal-system/test/payments.test.ts) |
| Duplicate events | Every notification is a Change Hint: deduped, one pending job per record, and a run with no real change writes nothing | [tracer](sync/test/tracer.test.ts), [payments](sync/test/payments.test.ts), [two-way](sync/test/two-way.test.ts) |
| Out-of-order or delayed events | Hints carry no data: each run refetches both Sides, so order doesn't matter. A CDC poll catches lost webhooks | [chaos](sync/test/chaos.test.ts), [cdc](sync/test/cdc.test.ts) |
| Incomplete webhook payloads | Same: the full record is always refetched from its API | all of the above |
| Conflicting edits in both systems | Financial fields edited on both Sides raise a Conflict that pauses the Invoice until a person picks a Side; cosmetic fields are last-writer-wins | [conflicts](sync/test/conflicts.test.ts), [merge](sync/test/merge.test.ts) |
| Partially paid invoice edited | An internal edit that drops the total below what is paid is flagged; the same edit from QBO, the book of record, is accepted | [payments](sync/test/payments.test.ts) |
| Timeout after a write | `requestid` replay, SyncToken on every update, and a pending Link with look-before-create | [write-safety](sync/test/write-safety.test.ts), [payments](sync/test/payments.test.ts) |
| Retry after partial success | The QBO half is recorded in the Base before the internal write, so a retry only does the missing half | [write-safety](sync/test/write-safety.test.ts) |
| Transient failures and retries | Errors are classified (transient, stale, auth, permanent…); backoff, leases, visible failed jobs | [write-safety](sync/test/write-safety.test.ts), [qbo-auth](sync/test/qbo-auth.test.ts) |
| Existing invoices with no Link | Backfill links identical pairs and raises Link Candidates for differing ones | [backfill](sync/test/backfill.test.ts) |
| Mapping: invoices and payments | Links (Invoices by DocNumber, Payments by ref ↔ `PaymentRefNum`) | [tracer](sync/test/tracer.test.ts), [payments](sync/test/payments.test.ts) |
| Mapping: ledger entries and accounts | Account Mapping (revenue category → QBO Item, payment method → deposit account) and a read-only reconcile. No JournalEntries are written, because QBO already posts Invoices and Payments and they would double-count ([ADR 0002](docs/adr/0002-no-journal-entry-sync.md)) | [reconcile](sync/test/reconcile.test.ts), [tracer](sync/test/tracer.test.ts) |
| Auditability | One Sync Attempt per run: what changed, what was written, and whether it succeeded, shown per Invoice in the console and admin page | [tracer](sync/test/tracer.test.ts), [conflicts](sync/test/conflicts.test.ts) |

## Layout

```
internal-system/   the Internal System: REST API + transactional outbox of HMAC-signed notifications
sync/src/          the sync service: webhook ingest, CDC poll, queue + worker, merge, admin page, OAuth, CLI
sync/scripts/      spike.ts (checks the real QBO sandbox) and live-run.ts (core scenarios end to end)
sync/test/         integration tests against the fake QBO, plus the pure merge's unit tests
mock-qbo/          the fake QBO: used by the tests, and run as the mock-qbo service
web/               the web console: React + Vite, served by nginx, which also proxies both APIs
```

## Hosted deployment

A running copy is at **<https://trashlab.agustinzago.com>**, connected to a QBO sandbox company. Sign in with the admin password (shared separately); everything in [Try it step by step](#try-it-step-by-step) works there against the real sandbox instead of the mock.

It runs on [Railway](https://railway.com) from the same Dockerfiles as `docker compose`, one service each:

| Service | Reachable at | Notes |
|---|---|---|
| `web` | <https://trashlab.agustinzago.com> | The only public service. nginx serves the console and proxies `/api/sync/*` and `/api/internal/*` on the same origin |
| `sync` | `sync.railway.internal:3000` (private) | Worker, CDC poll and webhooks run always-on in this process |
| `internal-system` | `internal-system.railway.internal:3001` (private) | Has no auth of its own: only reachable through the console, which checks the admin password on every call |
| two Postgres | private | One database per system, as locally |

- QBO OAuth redirect URI: `https://trashlab.agustinzago.com/api/sync/qbo/callback` (registered in the Intuit app's Development keys).
- QBO webhook endpoint: `https://trashlab.agustinzago.com/api/sync/webhooks/qbo`. Without it, the 60-second CDC poll still picks up QBO changes.
- The console's nginx config is a template (`web/default.conf.template`): its port, upstream addresses and DNS resolver come from the environment, with defaults that match `docker compose`. On Railway both Node services set `HOST=::` for the IPv6 private network.
- Secrets (`ADMIN_PASSWORD`, `QBO_CLIENT_SECRET`, `QBO_WEBHOOK_VERIFIER`, the shared `INTERNAL_WEBHOOK_SECRET`) are Railway variables, never in the repository.
- Why not serverless: the sync relies on an always-on worker loop, a per-minute CDC poll and Postgres advisory locks held across QBO calls, none of which fit request-scoped functions.

Redeploy a service from a checkout linked to the project (`railway link`):

```bash
railway up -s sync -d
```
```bash
railway up web --path-as-root -s web -d
```

## Run against the QBO sandbox

You need an Intuit developer account with a sandbox company (one is created with the account).

1. On [developer.intuit.com](https://developer.intuit.com), create an app with the **com.intuit.quickbooks.accounting** scope. Under **Keys & credentials** (Development), note the Client ID and Client Secret, and add the redirect URI `http://localhost:3000/qbo/callback`.
2. In the sandbox company, go to Settings → Account and settings → Sales → Sales form content, and turn on **Custom transaction numbers**. DocNumber is the shared identity, so the sync refuses to connect or start without it.
3. Create a `.env` from the example and uncomment the three `QBO_*` lines with your values. With `QBO_CLIENT_ID` set, the mock is not used.

   ```bash
   cp .env.example .env
   ```

4. Restart the sync service, then connect QBO from the web console (or <http://localhost:3000/admin/qbo/connect>), signing in to Intuit and picking the sandbox company. Tokens are stored in the sync database and refreshed automatically; until QBO is connected, sync work waits rather than fails.

   ```bash
   docker compose up -d --build
   ```

5. Point `ACCOUNT_MAPPING` in `.env` at the sandbox's Items and deposit accounts, then restart the sync service again. Each revenue category posts to a QBO Item, and each payment method deposits to an account (Undeposited Funds by default). List the ids with:

   ```bash
   docker compose run --rm sync node sync/src/cli.ts qbo-ids
   ```

QBO webhooks need a public URL, such as a tunnel to `localhost:3000/webhooks/qbo`; set `QBO_WEBHOOK_VERIFIER` to the app's verifier token. Without webhooks the CDC poll still catches every QBO change within a minute.

## The Internal System API

The web console covers the whole loop. The same works with `curl`: create a customer and issue an Invoice, and it appears in QBO with the same DocNumber.

```bash
curl -s -XPOST localhost:3001/customers -H 'content-type: application/json' -d '{"displayName":"Acme Ltd"}'
```

```bash
curl -s -XPOST localhost:3001/invoices -H 'content-type: application/json' -d '{"docNumber":"INV-1001","customerId":1,"txnDate":"2026-11-01","dueDate":"2026-12-01","memo":"Thanks","lines":[{"description":"Advice","amountCents":25000,"revenueCategory":"consulting"}],"status":"issued"}'
```

Changes made in QBO come back the same way. On its first start the CDC poll looks back one hour, so older QBO Invoices wait for the backfill command below. The Internal System's API:

- `POST/GET /customers`
- `POST/GET/PATCH /invoices`
- `POST /invoices/:id/issue|void`, and `DELETE /invoices/:id` for drafts only
- `POST/GET /payments` and `POST /payments/:id/void`

Every change to an existing record (PATCH, issue, void, delete) needs `If-Match: <version>`; it returns 428 without one and 409 when the version is stale.

Creates accept an `Idempotency-Key` header.

**Web console:** <http://localhost:8088>. Sign in with `ADMIN_PASSWORD` (`admin` by default). It covers the whole loop: create, edit, issue, void and delete Invoices, record and void Payments, see each Invoice's QBO sync state and Sync Attempt history, resolve Conflicts and Link Candidates, and connect or reconnect QBO. See [web/README.md](web/README.md).

**Admin page:** <http://localhost:3000/admin>, the plain server-rendered fallback. It lists Conflicts and Link Candidates (with buttons to pick a Side), Needs Attention items, failed jobs, and each Invoice's Sync Attempt history.

**Commands:**

- Adopt Invoices that existed before the sync. Identical pairs are linked, differing ones become Link Candidates, and one-sided Invoices are copied only with the flag:

  ```bash
  docker compose run --rm sync node sync/src/cli.ts backfill --create-missing
  ```

- Compare QBO's posted totals and balances with the Internal System's, read-only:

  ```bash
  docker compose run --rm sync node sync/src/cli.ts reconcile
  ```

## Tests

The tests need Node 24 and the dev Postgres. They create their own `internal_test` and `sync_test` databases there.

```bash
docker compose up -d internal-db
```

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

The web console has its own package: `cd web && npm install && npm test && npm run build`.

Everything is real except QBO, which is replaced by an in-memory fake QBO HTTP server (`mock-qbo/fake-qbo.ts`, the same one the mock-qbo service runs). The fake models the Accounting API subset in use (Invoices, Payments, voids, SyncToken checks, requestid replay, CDC, OAuth) with fault injection:

- timeouts before and after commit
- 500 and 429 errors
- an expired connection
- concurrent edits

The pure merge has table-driven unit tests (`sync/test/merge.test.ts`). The chaos run (`sync/test/chaos.test.ts`) edits both Sides while notifications are duplicated, delayed, reordered and dropped. It checks that both Sides end equal, with no duplicates and one Link per pair.

## Scripts

Both write `SPIKE-*` or `LIVE-*` records to the connected QBO company.

- **Spike** (real sandbox only). Checks the QBO behaviours the design assumes: the void shape, requestid replay, DocNumber on create, PaymentRefNum and LinkedTxn, 5010, CDC deletes, and refresh-token reuse. Paste its output into "Sandbox findings" in [docs/DESIGN.md](docs/DESIGN.md), and adjust the fake where reality differs.

  ```bash
  docker compose run --rm sync node sync/scripts/spike.ts
  ```

- **Live run** (mock or sandbox). Drives the core scenarios end to end through the running stack: creates and updates both ways, a Conflict and its resolution, a duplicated hint, a Payment and a Void. It prints what it verified. A timeout after a write can't be induced here, so the fault-injection tests cover it. Against the real sandbox it verified 8 of 8 (see "Sandbox findings" in [docs/DESIGN.md](docs/DESIGN.md)).

  ```bash
  docker compose run --rm sync node sync/scripts/live-run.ts
  ```

## Assumptions

- **No tax, one currency (USD), one QBO company.**
- **Receivables only:** Invoices and the Payments received against them. Bills and bill payments are out of scope.
- **Customers** are matched by display name and created on first use; edits to customers aren't synced.
- **Custom transaction numbers** must be on in QBO.
- **The ledger** is kept consistent through Account Mapping plus a read-only reconciliation, never by writing JournalEntries ([ADR 0002](docs/adr/0002-no-journal-entry-sync.md)).
