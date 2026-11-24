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
- **Missed webhooks** are caught by the QBO CDC poll. Each poll re-reads one minute of overlap and stores its cursor. CDC also reports hard deletes.

Each run takes a Postgres advisory lock on the invoice's DocNumber. That serializes everything touching one invoice (its edits and its payments) across workers, while unrelated invoices sync in parallel.

## Identity and Links

DocNumber is the shared identity. It's an **Identity Field**: the merge never syncs a change to it and flags it instead. A **Link** stores both ids, the **Base** and a state (`pending`, `linked`, `paused`, `attention`, `closed`). Payments are linked by `ref`: the internal payment ref is written to QBO's `PaymentRefNum`, and QBO-originated payments get the ref `QBO-<id>`.

## Merge and conflicts (ADR 0001)

Each side's current fields are compared with the Base, field by field:

| Changed on | Same value | Different values |
|---|---|---|
| one side | copied to the other side | — |
| both sides | converge silently | **Financial Field**: Conflict, the invoice is paused. **Cosmetic Field**: last writer wins |

- **Financial Fields:** customer, txnDate and lines. The line list is compared as a single unit, because the two systems share no stable line ids and reordering is common. A per-line merge would guess.
- **Cosmetic Fields:** dueDate and memo.
- **Derived Fields** (total, balance, payment status) are never compared. They follow from lines and payments.

A Conflict pauses the whole invoice, including its clean fields, so that a half-applied merge never needs explaining. Resolving a Conflict rewrites the Base: each conflicting field's Base value becomes the losing side's value. The next merge then sees only the winner as changed and propagates it with the ordinary code path. If the loser was edited again after the Conflict was raised, the field simply conflicts again, so a stale resolution can't silently overwrite an edit nobody has reviewed. Link Candidates are confirmed the same way.

LWW for Cosmetic Fields uses each system's own updatedAt, which is only as good as clock agreement between the two systems. That's acceptable for a memo and not for an amount, which is exactly where the line between Cosmetic and Financial is drawn.

## Writes and partial failure

Every write is guarded three ways:

1. **Optimistic concurrency.** QBO writes carry the SyncToken we read; a 5010 error means someone edited in between, so we refetch and re-merge. Internal writes carry `If-Match: version`, and a 409 is handled the same way. We never write blind over a concurrent edit.
2. **Server-side idempotency keys.** QBO's `requestid` is derived from (record, SyncToken, body) for updates and stored on the pending Link for creates. Internal creates use an `Idempotency-Key` header. A QBO customer create derives its requestid from the display name, and the lookup by name before creating covers a lost reply. A create keeps its requestid only while the outcome is unknown (a lost reply); when QBO answers with an error it did not take the write, so the pending Link gets a fresh requestid and a replayed failure can't block the retry.
3. **Look before re-creating.** A create first writes a `pending` Link (with its request id) and only then calls the other side. If the call times out, we can't know whether it landed. QBO's requestid window is short and not guaranteed, so the retry searches the target by DocNumber (payments are found through the invoice's `LinkedTxn`), adopts the record if it's there and its DocNumber, customer, date and lines match what was sent, flags it Needs Attention if they don't (someone else's record with that DocNumber), and creates it only if nothing is there.

The full Base advances only after every write in a run succeeds. One refinement: once the QBO half of a run lands, the fields just written are recorded in the Base, because both Sides now hold them. If the internal write then fails, the retry refetches and sees only what is still missing, so only the internal half is written. Without that step, an internal edit made between our two writes would make our own QBO write look like a QBO edit and raise a false Conflict (or lose a Cosmetic Field to last-writer-wins). Both sequences have their own tests.

Errors are classified as `transient` (timeout, 5xx, 429), `stale`, `auth`, `not_found` or `permanent`.

- `transient` retries with jittered exponential backoff, up to 10 attempts.
- `stale` retries in 500 ms.
- `auth` retries every 5 minutes, so a lapsed connection holds work until someone reconnects.
- `permanent` fails the job and shows it on the admin page.
- `not_found` also fails the job: the record vanished mid-run, and the next hint for it starts afresh.
- `stale` is capped at the same 10 attempts as `transient`, so a record edited non-stop still surfaces.
- An error with no HTTP reply counts as `transient` only for a timeout, a dropped connection or a lost database connection. Anything else (a bug, unexpected data) is `permanent`.

Each run writes exactly one **Sync Attempt** row. It records the outcome, a summary, the merge plan, the snapshots of the Base and both sides, every write performed (including writes that landed before a failure) and any notes, such as edits discarded by a void.

## Delete vs void

| Event | Result |
|---|---|
| Internal void | Voided in QBO (`operation=void` keeps the record and zeroes it) |
| QBO void | Voided internally |
| QBO hard delete | Voided internally. Financial history is never deleted. |
| Internal delete | Only possible for drafts, which are never synced |
| Void or delete while the other side has payments applied | Needs Attention; payments are never auto-unlinked |
| Void racing an edit | Void wins; the discarded edit is recorded in the attempt |

QBO has no void flag. A voided Invoice or Payment shows `TotalAmt = 0` and a `PrivateNote` starting with "Voided", and that's what we detect (to be confirmed against the sandbox).

## Payments

The scope is **receivables**: an Invoice, then a Payment received against it. Vendor bills (`Bill`/`BillPayment`) are payables and out of scope. Payments sync both ways and are create and void only. A change to an amount or date on either side is flagged, because editing money in place across systems is how ledgers drift; the fix is to void and re-enter. A QBO payment applied to several invoices is flagged rather than split. A payment hint that arrives before its invoice is linked retries with backoff and enqueues the invoice's sync.

Editing a partially paid invoice:

- From internal: pushed only if the new total stays at or above what QBO says is paid; otherwise Needs Attention.
- From QBO: accepted, because QBO is the book of record. The overpayment shows up as a negative balance.

## Ledger (ADR 0002)

QBO generates the AR, income and deposit postings from Invoices and Payments itself. Writing JournalEntries alongside them would double-count revenue. So "syncing the general ledger" here means two things:

- **Account Mapping:** a revenue category maps to a QBO Item, which carries its income account. A payment method maps to a deposit account, defaulting to Undeposited Funds.
- **A read-only reconciliation:** a reconcile command compares QBO's posted total and balance with the internal ones for every linked invoice.

## Pre-existing invoices with no Link

A backfill command turns every invoice on both sides into a hint. The normal path then:

- links pairs with the same DocNumber whose fields are identical;
- raises a **Link Candidate** when the fields differ. Nothing is created, and a person picks which side wins.

One-sided invoices are copied across only with `--create-missing`. That opt-in governs the backfill alone: a pre-existing Invoice that changes after the sync is running gets a Change Hint like any other and is synced, since keeping live changes in step is the sync's job. The same "look before create" check guards ordinary syncing, so an unlinked match can never be duplicated by accident.

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

Pending: `sync/scripts/spike.ts` checks each behaviour below against the real sandbox, and its output belongs here. Until then the fake QBO models these assumptions:

- A void keeps the record with `TotalAmt` 0 and a `PrivateNote` starting with "Voided", for Invoices and Payments; a voided Payment drops out of its Invoice's `LinkedTxn`.
- Repeating a write with the same `requestid` returns the original response for a short window; only successful writes are assumed replayed.
- `DocNumber` is settable on create when Custom transaction numbers is on, and a duplicate is rejected (6140).
- A Payment carries `PaymentRefNum` as sent, and the Invoice it pays lists it in `LinkedTxn` with a reduced `Balance`.
- A stale `SyncToken` fails with Fault code 5010, and CDC reports a hard-deleted Invoice as `{status: "Deleted", Id}`.
