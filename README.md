# Invoice sync

Keeps receivable Invoices, and the Payments applied to them, in agreement between an Internal System and a QuickBooks Online (QBO) sandbox company, in both directions. It stays correct when notifications are duplicated, delayed, reordered or lost, and when either API times out after a write has landed.

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

The two Postgres databases start with them. Then, in the web console, create a customer and an issued Invoice. It appears in QBO with the same DocNumber, and its sync state and history show next to it.

To watch the core scenarios run end to end (creates and edits both ways, a Conflict and its resolution, a duplicated notification, a Payment and a Void):

```bash
docker compose run --rm sync node sync/scripts/live-run.ts
```

The mock QBO answers the same Accounting API the sync uses, with any bearer token. For example, to list its Invoices:

```bash
curl -sG localhost:4000/v3/company/9130000000000000/query -H 'authorization: Bearer mock' --data-urlencode 'query=select * from Invoice'
```

The mock keeps its data in memory, so reset the whole stack rather than restarting it alone:

```bash
docker compose down -v
```

To make the Internal System duplicate, delay and reorder its notifications on purpose, start it with `CHAOS=1`:

```bash
CHAOS=1 docker compose up -d internal-system
```

## Layout

```
internal-system/   the Internal System: REST API + transactional outbox of HMAC-signed notifications
sync/src/          the sync service: webhook ingest, CDC poll, queue + worker, merge, admin page, OAuth, CLI
sync/scripts/      spike.ts (checks the real QBO sandbox) and live-run.ts (core scenarios end to end)
sync/test/         integration tests against the fake QBO, plus the pure merge's unit tests
mock-qbo/          the fake QBO: used by the tests, and run as the mock-qbo service
web/               the web console: React + Vite, served by nginx, which also proxies both APIs
```

## Use a real QBO sandbox instead

Optional. You need an Intuit developer account with a sandbox company (one is created with the account).

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
