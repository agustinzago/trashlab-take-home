# Invoice sync

Keeps receivable Invoices, and the Payments applied to them, in agreement between an Internal System and a QuickBooks Online (QBO) sandbox company, in both directions. It stays correct when notifications are duplicated, delayed, reordered or lost, and when either API times out after a write has landed.

- **Design:** [docs/DESIGN.md](docs/DESIGN.md). How it works, write safety, tradeoffs and known limits.
- **Vocabulary:** [CONTEXT.md](CONTEXT.md). Change Hint, Link, Base, Conflict and the other terms used below.
- **Decisions:** [docs/adr/](docs/adr/). The three-way merge, and syncing the ledger through Account Mapping.

```
internal-system/   the Internal System: REST API + transactional outbox of HMAC-signed notifications
sync/src/          the sync service: webhook ingest, CDC poll, queue + worker, merge, admin page, OAuth, CLI
sync/scripts/      spike.ts (checks QBO's real behaviours) and live-run.ts (scenarios against the sandbox)
sync/test/         integration tests against a fake QBO, plus the pure merge's unit tests
```

## Run it against a QBO sandbox

You need Docker, and an Intuit developer account with a sandbox company (one is created with the account).

### 1. Create the QBO app

1. On [developer.intuit.com](https://developer.intuit.com), create an app with the **com.intuit.quickbooks.accounting** scope.
2. Under **Keys & credentials** (Development), note the Client ID and Client Secret.
3. On the same page, add the redirect URI `http://localhost:3000/qbo/callback`.
4. Optional: webhooks need a public URL, such as a tunnel to `localhost:3000/webhooks/qbo`. Subscribe to Invoice and Payment, then note the verifier token. Without webhooks the sync still catches every QBO change within a minute through the CDC poll.

### 2. Prepare the sandbox company

In the sandbox company, go to Settings → Account and settings → Sales → Sales form content, and turn on **Custom transaction numbers**. The DocNumber is the shared identity, so the sync refuses to connect or start without it.

### 3. Configure and start

```bash
cp .env.example .env
```

Fill in `.env`: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `ADMIN_PASSWORD`, `INTERNAL_WEBHOOK_SECRET`, and `QBO_WEBHOOK_VERIFIER` (any value if you skip webhooks).

```bash
docker compose up -d --build
```

This starts the Internal System on `:3001` and the sync service on `:3000`, each with its own Postgres.

### 4. Connect QBO

Open <http://localhost:3000/admin/qbo/connect>, log in as `admin` with your `ADMIN_PASSWORD`, then sign in to Intuit and pick the sandbox company. The tokens are stored in the sync database and refreshed automatically. Until QBO is connected, sync work waits rather than fails.

### 5. Set the Account Mapping

Each internal revenue category posts to a QBO Item, and each payment method deposits to a QBO account (the default is Undeposited Funds). List the ids:

```bash
docker compose run --rm sync node sync/src/cli.ts qbo-ids
```

Then set `ACCOUNT_MAPPING` in `.env`, for example `{"revenue_category":{"consulting":"1","hosting":"5"},"payment_method":{"check":"35"}}`, and restart:

```bash
docker compose up -d sync
```

### 6. Use it

Create a customer and issue an Invoice in the Internal System. It appears in QBO with the same DocNumber:

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

**Admin page:** <http://localhost:3000/admin>. It lists Conflicts and Link Candidates (with buttons to pick a Side), Needs Attention items, failed jobs, and each Invoice's Sync Attempt history.

**Commands:**

- Adopt Invoices that existed before the sync. Identical pairs are linked, differing ones become Link Candidates, and one-sided Invoices are copied only with the flag:

  ```bash
  docker compose run --rm sync node sync/src/cli.ts backfill --create-missing
  ```

- Compare QBO's posted totals and balances with the Internal System's, read-only:

  ```bash
  docker compose run --rm sync node sync/src/cli.ts reconcile
  ```

To see the sync cope with messy delivery, set `CHAOS=1` in `.env` and restart the Internal System. Its notifications are then duplicated, delayed and reordered.

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

Everything is real except QBO, which is replaced by an in-memory fake QBO HTTP server (`sync/test/fake-qbo.ts`). The fake models the Accounting API subset in use (Invoices, Payments, voids, SyncToken checks, requestid replay, CDC, OAuth) with fault injection:

- timeouts before and after commit
- 500 and 429 errors
- an expired connection
- concurrent edits

The pure merge has table-driven unit tests (`sync/test/merge.test.ts`). The chaos run (`sync/test/chaos.test.ts`) edits both Sides while notifications are duplicated, delayed, reordered and dropped. It checks that both Sides end equal, with no duplicates and one Link per pair.

## Against the real sandbox

Both scripts write `SPIKE-*` or `LIVE-*` records to the connected company.

- **Spike.** Checks the QBO behaviours the design assumes: the void shape, requestid replay, DocNumber on create, PaymentRefNum and LinkedTxn, 5010, CDC deletes, and refresh-token reuse. Paste its output into "Sandbox findings" in [docs/DESIGN.md](docs/DESIGN.md), and adjust the fake where reality differs.

  ```bash
  docker compose run --rm sync node sync/scripts/spike.ts
  ```

- **Live run.** Drives the core scenarios end to end through the running stack: creates and updates both ways, a Conflict and its resolution, a duplicated hint, a Payment and a Void. It prints what it verified. A timeout after a write can't be induced against the sandbox, so the fault-injection tests cover it.

  ```bash
  docker compose run --rm sync node sync/scripts/live-run.ts
  ```

## Assumptions

- **No tax, one currency (USD), one QBO company.**
- **Receivables only:** Invoices and the Payments received against them. Bills and bill payments are out of scope.
- **Customers** are matched by display name and created on first use; edits to customers aren't synced.
- **Custom transaction numbers** must be on in QBO.
- **The ledger** is kept consistent through Account Mapping plus a read-only reconciliation, never by writing JournalEntries ([ADR 0002](docs/adr/0002-no-journal-entry-sync.md)).
