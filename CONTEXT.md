# Invoice Sync

Keeps receivable invoices and the payments received against them consistent between the Internal System and QuickBooks Online, in both directions.

## Systems

**Internal System**:
The company's own invoicing service, a separate application with its own API and its own change notifications.
_Avoid_: internal app, our DB, source system

**QBO**:
The QuickBooks Online company that the Internal System is synced with.
_Avoid_: QuickBooks, QB, Intuit

**Side**:
Either the Internal System or QBO, when a rule applies symmetrically to both.
_Avoid_: end, peer

## Records

**Invoice**:
A receivable: a request for payment sent to a customer. It exists once on each Side and is joined by a Link.
_Avoid_: bill (a bill is a payable owed to a vendor and is out of scope)

**Payment**:
Money received from a customer and applied to exactly one Invoice.
_Avoid_: bill payment, transaction, receipt

**Payment Status**:
Whether an Invoice is unpaid, partially paid or paid. It is always derived from the Payments applied, never edited or synced directly.
_Avoid_: paid flag, balance status

**Void**:
An Invoice kept on record with its amounts zeroed, so its history survives.
_Avoid_: cancel

**Delete**:
Removing an Invoice entirely. Only allowed for an Invoice that was never synced; a Delete in QBO arrives in the Internal System as a Void.
_Avoid_: remove, purge

**Account Mapping**:
The configured correspondence between an internal revenue category or payment method and the QBO account or item it posts to.
_Avoid_: GL sync, chart sync

## Sync

**Link**:
The durable record saying which Invoice or Payment on one Side is the same record on the other.
_Avoid_: mapping row, linkage, pairing

**Link Candidate**:
A proposed Link between pre-existing records on both Sides that looks like a match but is waiting for a person to confirm it.
_Avoid_: fuzzy match, suggestion

**Base**:
The snapshot of an Invoice's fields as they were the last time both Sides agreed. Each Side's changes are measured against it.
_Avoid_: last state, previous version, ancestor

**Change Hint**:
A notification that a record on some Side may have changed. It carries no trusted content, so the record is always refetched.
_Avoid_: event, webhook payload, delta

**Financial Field**:
An Invoice field whose value affects money owed or its accounting, such as the customer, lines, amounts or transaction date.
_Avoid_: money field, important field

**Cosmetic Field**:
An Invoice field that does not affect money owed, such as the memo or due date.
_Avoid_: soft field, minor field

**Identity Field**:
An Invoice field that names the record, such as its DocNumber. It is fixed once a Link exists, and a change on either Side is flagged rather than synced.
_Avoid_: key field

**Derived Field**:
An Invoice value that a Side computes rather than a person edits, such as the total, balance or Payment Status. It is never merged and never causes a Conflict.
_Avoid_: computed field, read-only field

**Conflict**:
A Financial Field changed to different values on both Sides since the Base. It pauses that Invoice's sync until a person picks a Side.
_Avoid_: collision, merge error

**Sync Attempt**:
One recorded try at bringing a record into agreement: what changed, what was written where, and the outcome.
_Avoid_: job, run, log entry

**Needs Attention**:
The state of a Sync Attempt that cannot proceed safely without a person, for example a push that would leave an Invoice's total below what has already been paid.
_Avoid_: failed, error, stuck
