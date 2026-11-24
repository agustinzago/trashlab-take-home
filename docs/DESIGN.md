# Design: two-way invoice sync

Terms in **bold** are defined in [CONTEXT.md](../CONTEXT.md). Two decisions have their own ADRs: [0001 three-way merge](adr/0001-three-way-merge-conflicts.md) and [0002 ledger via Account Mapping](adr/0002-no-journal-entry-sync.md).

## Shape

```
 Internal System (own DB)            Sync service (own DB)                      QBO sandbox
 ─────────────────────────           ───────────────────────────────            ───────────
 REST API ◄──────────────────────── worker: refetch both, merge, write ───────► Accounting API
 outbox ──webhook (HMAC)──► /webhooks/internal ─┐                     ┌──────── webhooks (HMAC)
                                                ├─► change_hints ─► sync_jobs ◄─ CDC poll (every 60s)
                                 /webhooks/qbo ─┘   (dedupe)        (queue)
```

The Internal System is a separate service. It doesn't know QBO exists, and the sync service reaches it only over HTTP. That keeps the boundary honest: the sync service has the same failure modes against both systems (timeouts, version conflicts, partial writes).

## Core idea: hints, not events

Webhook payloads from either side are treated as **Change Hints**: "record X may have changed". They're never treated as a description of the change. Every sync run refetches both sides, so:

- **Duplicates** are dropped at ingest by a per-hint dedupe key. Bursts also coalesce into one pending job per record (partial unique index). Even if both checks were bypassed, the rerun finds both sides equal to the **Base** and does nothing. Idempotency comes from the comparison itself, not from remembering which events were seen.
- **Out of order or delayed** hints don't matter, because ordering is never used. A late hint just triggers a refetch of the current state.
- **Incomplete payloads** are the normal case. QBO webhooks only carry the entity id, and the internal ones are equally thin.
- **Missed webhooks** are caught by the QBO CDC poll (at startup, then every minute). Each poll re-reads one minute of overlap and stores QBO's own clock as its cursor, only after every hint is recorded. CDC also reports hard deletes. Webhooks and CDC share one dedupe key, so a change seen both ways is stored once.

Each run takes a Postgres advisory lock on the invoice's DocNumber. That serializes everything touching one invoice (its edits and its payments) across workers, while unrelated invoices sync in parallel. Jobs are claimed with `SKIP LOCKED` and a lease, and fenced by a per-claim token, so a worker whose lease expired can't write a second Sync Attempt.

## Identity and Links

DocNumber is the shared identity. It's an **Identity Field**: the merge never syncs a change to it and flags it instead. A **Link** stores both ids, the **Base** and a state (`pending`, `linked`, `paused`, `attention`, `closed`). Payments are linked by `ref`: the internal payment ref is written to QBO's `PaymentRefNum`, and QBO-originated payments get the ref `QBO-<id>`. A Payment's Link also points at its Invoice's Link, which gives it the Invoice's lock and scopes ref lookups to that Invoice.

## Merge and conflicts (ADR 0001)

Each side's current fields are compared with the Base, field by field:

| Changed on | Same value | Different values |
|---|---|---|
| one side | copied to the other side | — |
| both sides | converge silently | **Financial Field**: Conflict, the invoice is paused. **Cosmetic Field**: last writer wins |

- **Financial Fields:** customer, txnDate and lines. The line list is compared as a single unit, because the two systems share no stable line ids and reordering is common. A per-line merge would guess.
- **Cosmetic Fields:** dueDate and memo.
- **Derived Fields** (total, balance, payment status) are never compared. They follow from lines and payments.

A Conflict pauses the whole invoice, including its clean fields, so that a half-applied merge never needs explaining. Resolving a Conflict rewrites the Base: each conflicting field's Base value becomes the losing side's value. The next merge then sees only the winner as changed and propagates it with the ordinary code path. If the loser was edited again after the Conflict was raised, a Financial Field simply conflicts again, so a stale resolution can't silently overwrite a money edit nobody has reviewed (a Cosmetic Field falls to last-writer-wins, as everywhere). Link Candidates are confirmed the same way. A Void wins over an open Conflict and settles it.

LWW for Cosmetic Fields uses each system's own updatedAt (a tie goes to QBO, the book of record), which is only as good as clock agreement between the two systems. That's acceptable for a memo and not for an amount, which is exactly where the line between Cosmetic and Financial is drawn.

## Writes and partial failure

Every write is guarded three ways:

1. **Optimistic concurrency.** QBO writes carry the SyncToken we read; a 5010 error means someone edited in between, so we refetch and re-merge. Internal writes carry `If-Match: version`, and a 409 is handled the same way. We never write blind over a concurrent edit.
2. **Server-side idempotency keys.** QBO's `requestid` is derived from (record, SyncToken, body) for updates and stored on the pending Link for creates. Internal creates use an `Idempotency-Key` header. A QBO customer create derives its requestid from the display name, and the lookup by name before creating covers a lost reply. A create keeps its requestid only while the outcome is unknown (a lost reply); when QBO answers with an error it did not take the write, so the pending Link gets a fresh requestid and a replayed failure can't block the retry.
3. **Look before re-creating.** A create first writes a `pending` Link (with its request id) and only then calls the other side. If the call times out, we can't know whether it landed. QBO's requestid window is short and not guaranteed, so the retry searches the target by DocNumber (payments are found through the invoice's `LinkedTxn`), adopts the record if it's there and its DocNumber, customer, date and lines match what was sent, flags it Needs Attention if they don't (someone else's record with that DocNumber), and creates it only if nothing is there.

The full Base advances only after every write in a run succeeds. One refinement: once the QBO half of a run lands, the fields just written are recorded in the Base, because both Sides now hold them. If the internal write then fails, the retry refetches and sees only what is still missing, so only the internal half is written. Without that step, an internal edit made between our two writes would make our own QBO write look like a QBO edit and raise a false Conflict (or lose a Cosmetic Field to last-writer-wins). Both sequences have their own tests.

Errors are classified as `transient` (timeout, 5xx, 429), `stale`, `auth`, `waiting`, `not_found` or `permanent`.

- `transient` retries with jittered exponential backoff, up to 10 attempts.
- `stale` retries in 500 ms.
- `auth` retries every 5 minutes without spending attempts, so a lapsed or missing connection holds work until someone reconnects.
- `waiting` (a Payment whose Invoice has no Link yet) backs off like `transient`, then keeps retrying every 5 minutes; it is never given up.
- `permanent` fails the job and shows it on the admin page.
- `not_found` also fails the job: the record vanished mid-run, and the next hint for it starts afresh.
- `stale` is capped at the same 10 attempts as `transient`, so a record edited non-stop still surfaces.
- An error with no HTTP reply counts as `transient` only for a timeout, a dropped connection or a lost database connection. Anything else (a bug, unexpected data) is `permanent`.

Each run writes exactly one **Sync Attempt** row. It records the outcome, a summary, the snapshots of the Base and both sides (with the merge result), every write performed (including writes that landed before a failure) and any notes, such as edits discarded by a void.

## Delete vs void

| Event | Result |
|---|---|
| Internal void | Voided in QBO (`operation=void` keeps the record and zeroes it) |
| QBO void | Voided internally |
| QBO hard delete | Voided internally. Financial history is never deleted. |
| Internal delete | Only possible for drafts, which are never synced |
| Void or delete while the other side has payments applied | Needs Attention; payments are never auto-unlinked |
| Void racing an edit | Void wins; the discarded edit is recorded in the attempt |

QBO has no void flag. A voided Invoice or Payment shows `TotalAmt = 0` and a `PrivateNote` starting with "Voided", and that's what we detect (confirmed against the sandbox; see Sandbox findings). Two guards keep a misread from voiding real receivables: a QBO "not found" counts as a hard delete only when a Delete notification (webhook or CDC) was received for it, and a QBO Invoice zeroed without a "Voided" note is Needs Attention rather than a merge of zeroed lines. A voided Invoice's Link is closed, so later hints are no-ops.

## Payments

The scope is **receivables**: an Invoice, then a Payment received against it. Vendor bills (`Bill`/`BillPayment`) are payables and out of scope. Payments sync both ways and are create and void only. A change to an amount or date on either side is flagged, because editing money in place across systems is how ledgers drift; the fix is to void and re-enter. A QBO payment applied to several invoices (or moved to another one) is flagged rather than split or moved. A payment hint that arrives before its invoice is linked enqueues the invoice's sync and waits until it is linked. The deposit account comes from Account Mapping by payment method, else Undeposited Funds (found by its account sub-type, not its name).

Editing a partially paid invoice:

- From internal: pushed only if the new total stays at or above what QBO says is paid; otherwise Needs Attention.
- From QBO: accepted, because QBO is the book of record. The overpayment shows up as a negative balance.

## Ledger (ADR 0002)

QBO generates the AR, income and deposit postings from Invoices and Payments itself. Writing JournalEntries alongside them would double-count revenue. So "syncing the general ledger" here means two things:

- **Account Mapping:** a revenue category maps to a QBO Item, which carries its income account. A payment method maps to a deposit account, defaulting to Undeposited Funds.
- **A read-only reconciliation:** `cli.ts reconcile` compares QBO's posted total and balance with the internal ones for every linked (not closed) invoice and lists the mismatches. It writes nothing.

## Pre-existing invoices with no Link

A backfill command turns every invoice on both sides into a hint. The normal path then:

- links pairs with the same DocNumber whose fields are identical, writing nothing;
- raises a **Link Candidate** when the fields differ. Nothing is created, and a person picks which side wins on the admin page;
- flags a pair voided on one Side only, or several QBO Invoices sharing a DocNumber, as Needs Attention.

One-sided invoices are copied across only with `--create-missing`. That opt-in governs the backfill alone: a pre-existing Invoice that changes after the sync is running gets a Change Hint like any other and is synced, since keeping live changes in step is the sync's job. The same "look before create" check guards ordinary syncing, so an unlinked match can never be duplicated by accident.

## Operations

- **Admin page** (`/admin`, HTTP Basic with `ADMIN_PASSWORD`, required at startup): open Conflicts and Link Candidates with Base and both values and buttons to pick a Side, Needs Attention items, failed jobs, and the Sync Attempt history per Link. A JSON API under `/admin/api` serves the same. Cross-site form posts are refused.
- **QBO connection:** `/admin/qbo/connect` runs the OAuth 2 authorization-code flow; tokens live in the sync database and are refreshed under a row lock, both replaced in one statement.
- **CLI** (`sync/src/cli.ts`): `backfill [--create-missing]`, `reconcile`, and `qbo-ids` (the Item and account ids Account Mapping needs).
- **Scripts** (`sync/scripts/`): `spike.ts` checks the QBO behaviours this design assumes; `live-run.ts` drives the core scenarios against the sandbox.

## Tradeoffs and known limits

- **Line-level merge:** whole-list comparison means a QBO memo edit and an internal line edit merge fine, but line edits on both sides always conflict, even on different lines.
- **Customers:** matched by display name and created on first use. Customer edits aren't synced.
- **No tax** (none in the brief) and single currency. QBO's automated sales tax would make the total a Derived Field computed by QBO. The model supports that, but it isn't implemented.
- **DocNumber must be settable in QBO** ("Custom transaction numbers" must be on; a startup check reads QBO Preferences to verify it). Without it there's no shared identity, and matching would have to fall back to heuristics.
- **The queue is Postgres**, with `SKIP LOCKED` and leases. That's enough for this load, and transactional with the Link state. A broker becomes worth it at many realms or high volume.
- **Single QBO company.** Multi-tenant support would key every table by realm.
- **QBO connection.** OAuth 2 tokens are stored in plain text in the sync database and the client secret comes from the environment; fine for one operator-run company, a secrets store before anything shared. The connection can be renewed but never switched to another company, since Links, the CDC cursor and Account Mapping belong to one. "Custom transaction numbers" is checked when connecting and at startup only; turning it off later goes unnoticed until the next restart. The image ships the operator scripts (spike, live run), which write to the connected company when run.
- **Payment edits** are flagged rather than synced. Auto void-and-recreate is possible but changes payment identity in the books, which an accountant should decide.

## Sandbox findings

`sync/scripts/spike.ts` ran against the QBO sandbox on 2026-11-23 (company 9341458748388797). The fake QBO models what it found.

| Question | Observed | Effect |
|---|---|---|
| Custom transaction numbers | Off by default in a new sandbox company; must be turned on | The connect step and startup check enforce it |
| DocNumber on create | Kept as sent | Shared identity holds |
| DueDate omitted on create | QBO derives one from the default terms (Net 30) | Comes back as a QBO edit and is copied internally once |
| Same `requestid` repeated | Returned the original Invoice, immediately and again after 65 s | Lost replies are covered for at least a minute; look-before-create covers longer gaps |
| Duplicate DocNumber, no `requestid` | Rejected, Fault 6140 | A double create can't silently duplicate |
| Payment `PaymentRefNum`, Invoice `LinkedTxn` | Ref kept as sent; the Invoice lists the Payment in `LinkedTxn` and its `Balance` drops; deposit defaults to Undeposited Funds | Payment links and look-before-create work as designed |
| Voiding a Payment | `operation=void` is refused (Fault 6000, it voids card charges). `operation=update&include=void` works: `TotalAmt` 0, `PrivateNote` "Voided", `Line` emptied; the Payment leaves the Invoice's `LinkedTxn` and the balance is restored | **Assumption was wrong**: the client now voids Payments through update with include=void, and a voided Payment's Invoice comes from its Link, never from its (empty) lines |
| Voiding an Invoice | `TotalAmt` 0, `Balance` 0, `PrivateNote` "Voided", line amounts 0 | Void detection holds |
| Update with a stale `SyncToken` | Fault 5010 "Stale Object Error" | Classified as stale: refetch and re-merge |
| CDC after a hard delete | `{domain: "QBO", status: "Deleted", Id, MetaData.LastUpdatedTime}` (with a UTC offset) | Delete hints match what the sync expects |
| Refresh token reuse | This refresh returned the same refresh token, and the previous token was still honoured | A crash mid-refresh cannot leave the connection unusable |

The live run (`sync/scripts/live-run.ts`) then verified 8 of 8 scenarios against the same sandbox through the running stack: creates both ways, edits both ways, a Conflict and its resolution, a duplicated hint, a Payment and a Void. A timeout after a write can't be induced there; the fault-injection tests cover it. `cli.ts reconcile` afterwards reported 0 mismatches across the linked Invoices.
