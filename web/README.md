# Web console

A React app for the people who run the invoice sync: the Internal System's invoices, payments and customers, plus everything the sync service needs a person for.

## Pages

- **Overview.** Outstanding and collected totals, what's waiting on a person, how many invoices agree with QBO, and the QBO connection (connect or reconnect from here).
- **Invoices.** Filter by status or "out of sync", search by number or customer. Each invoice shows its lines, payments, QBO sync state and Sync Attempt history. Create, edit, issue, void, delete drafts, record and void payments.
- **Review.** Conflicts (last agreed value next to each Side's), Link Candidates, Needs Attention and failed jobs. Pick a Side and the sync carries it across.
- **Customers.** List with invoice counts and amounts owed, and add new ones.

## How it talks to the backend

The browser only ever talks to its own origin. nginx (production, `nginx.conf`) and Vite (development, `vite.config.ts`) proxy the same two paths:

| Path | Goes to |
|---|---|
| `/api/internal/*` | the Internal System |
| `/api/sync/*` | the sync service |

Sign-in uses the sync service's `ADMIN_PASSWORD`, sent as HTTP Basic on every call and kept in `sessionStorage` for the tab. The Internal System has no auth of its own, so nginx checks the same credential against the sync service (`auth_request`) before letting a call through. Both proxies drop `WWW-Authenticate` so a 401 lands on the app's sign-in screen, not the browser's native prompt. The `Host` header is passed through unchanged because the sync service refuses admin POSTs whose `Origin` doesn't match it.

Writes follow the backend's safety rules:

- **Edits carry `If-Match`** with the version the person saw. On a 409 the form keeps their typing and offers to load the latest version.
- **Creates carry an `Idempotency-Key`**, one per form, so a retry after a lost reply can't create a second invoice, customer or payment.

Money is integer cents end to end. `src/format.ts` parses typed amounts without floating point; `src/format.test.ts` covers it.

## Develop

Run the backend (`docker compose up -d` from the repo root), then:

```bash
npm install
```

```bash
npm run dev
```

Vite proxies to `localhost:3001` and `localhost:3000`; set `INTERNAL_URL` or `SYNC_URL` to point elsewhere.

```bash
npm test
```

```bash
npm run build
```

## Design

Visual language: a warm paper ground, near-black ink, sky and periwinkle accents, Inter Tight display type, IBM Plex Mono eyebrows and labels. Fonts are self-hosted (`@fontsource`), so the strict Content-Security-Policy in `nginx.conf` holds.
