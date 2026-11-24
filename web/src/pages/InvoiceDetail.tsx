import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, newIdempotencyKey, q, syncStateOf, type Attempt, type Invoice, type Payment } from "../api.ts";
import { centsToInput, formatAgo, formatCents, formatDate, formatStamp, parseCents, today } from "../format.ts";
import { Button, Confirm, Dialog, Empty, ErrorState, errorMessage, Money, PaymentPill, Skeleton, SyncPill, usePageTitle, useToast } from "../ui.tsx";

type Action = "issue" | "void" | "delete" | "pay" | { voidPayment: Payment } | null;

export function InvoiceDetail() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const toast = useToast();
  const invoice = useQuery(q.invoice(id));
  const customers = useQuery(q.customers());
  const payments = useQuery(q.payments(id));
  const links = useQuery(q.links());
  const attention = useQuery(q.attention());
  const [action, setAction] = useState<Action>(null);
  usePageTitle(invoice.data?.docNumber ?? "Invoice");

  if (invoice.isPending) return <Skeleton rows={12} />;
  if (invoice.isError)
    return invoice.error instanceof ApiError && invoice.error.status === 404 ? (
      <div className="card">
        <Empty title="Invoice not found" action={<Link to="/invoices" className="btn btn-primary">All invoices</Link>}>
          It may have been a draft that was deleted.
        </Empty>
      </div>
    ) : (
      <ErrorState error={invoice.error} retry={() => invoice.refetch()} />
    );

  const inv = invoice.data;
  const customer = customers.data?.find((c) => c.id === inv.customerId)?.displayName;
  const link = links.data?.find((l) => l.internalId === String(inv.id));
  const syncState = syncStateOf(inv, links.data);
  const why = link && attention.data?.find((a) => a.linkId === link.id)?.summary;
  const linesTotal = inv.lines.reduce((s, l) => s + l.amountCents, 0);

  /** Runs a lifecycle change with the version we showed; a 409 means someone (or the sync) got there first. */
  const run = (fn: () => Promise<unknown>, done: string) => async () => {
    try {
      await fn();
      toast(done);
    } catch (err) {
      if (err instanceof ApiError && err.isStale) {
        invoice.refetch();
        throw new ApiError(409, "This invoice changed since you opened it. It has been reloaded; check it and try again.");
      }
      throw err;
    }
  };

  return (
    <>
      <Link to="/invoices" className="back">
        ← All invoices
      </Link>
      <div className="page-head">
        <div>
          <p className="eyebrow">Invoice{customer ? ` · ${customer}` : ""}</p>
          <h1 style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 16px" }}>
            <span className="mono" style={{ fontFamily: "var(--display)" }}>
              {inv.docNumber}
            </span>
            <PaymentPill invoice={inv} />
            <SyncPill state={syncState} />
          </h1>
        </div>
        <div className="actions">
          {inv.status !== "voided" && (
            <Link to={`/invoices/${inv.id}/edit`} className="btn btn-secondary">
              Edit
            </Link>
          )}
          {inv.status === "draft" && (
            <>
              <Button variant="danger" onClick={() => setAction("delete")}>
                Delete draft
              </Button>
              <Button variant="primary" onClick={() => setAction("issue")}>
                Issue invoice
              </Button>
            </>
          )}
          {inv.status === "issued" && (
            <>
              <Button variant="danger" onClick={() => setAction("void")}>
                Void
              </Button>
              {inv.balanceCents > 0 && (
                <Button variant="primary" onClick={() => setAction("pay")}>
                  Record payment
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {syncState === "paused" && (
        <div className="banner banner-warn" role="status">
          <span>
            <strong>Changed differently here and in QBO.</strong> Sync for this invoice is paused until someone picks which version to keep.
          </span>
          <Link to="/review?tab=conflicts" className="btn btn-sm btn-primary">
            Resolve conflict
          </Link>
        </div>
      )}
      {syncState === "attention" && (
        <div className="banner banner-danger" role="status">
          <span>
            <strong>The sync needs a person.</strong> {why}
          </span>
          <Link to="/review?tab=attention" className="btn btn-sm btn-secondary" style={{ borderColor: "currentColor", color: "inherit" }}>
            Open review
          </Link>
        </div>
      )}
      {inv.status === "draft" && (
        <div className="banner banner-info" role="status">
          Drafts stay in the Internal System. Issue it to send it to QuickBooks Online.
        </div>
      )}

      <div className="split">
        <div className="split-main">
          <section className="card" aria-label="Invoice">
            <dl className="facts card-pad" style={{ borderBottom: "1px solid var(--line)" }}>
              <div>
                <dt>Invoice date</dt>
                <dd>{formatDate(inv.txnDate)}</dd>
              </div>
              <div>
                <dt>Due</dt>
                <dd>{formatDate(inv.dueDate)}</dd>
              </div>
              <div>
                <dt>Customer</dt>
                <dd>{customer ?? `#${inv.customerId}`}</dd>
              </div>
              <div>
                <dt>Memo</dt>
                <dd>{inv.memo || <span className="muted">—</span>}</dd>
              </div>
            </dl>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 480 }}>
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col">Revenue category</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.description}</td>
                      <td>
                        <span className="mono muted">{l.revenueCategory}</span>
                      </td>
                      <td className={`num${inv.status === "voided" ? " strike" : ""}`}>{formatCents(l.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="totals" style={{ borderTop: "1px solid var(--line)" }}>
              <dt>Total</dt>
              <dd>{inv.status === "voided" ? <><span className="strike">{formatCents(linesTotal)}</span> {formatCents(0)}</> : formatCents(inv.totalCents)}</dd>
              {inv.status !== "draft" && (
                <>
                  <dt>Paid</dt>
                  <dd>{inv.paidCents ? `−${formatCents(inv.paidCents)}` : formatCents(0)}</dd>
                  <dt style={{ color: "var(--ink)" }}>Balance</dt>
                  <dd className="grand">{formatCents(inv.balanceCents)}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="card" aria-labelledby="payments-title">
            <div className="card-head">
              <h2 id="payments-title" style={{ fontSize: 18 }}>
                Payments
              </h2>
            </div>
            {payments.isPending ? (
              <div className="card-pad">
                <div className="skeleton" style={{ height: 18 }} />
              </div>
            ) : payments.isError ? (
              <Empty title="Couldn't load payments" action={<Button onClick={() => payments.refetch()}>Try again</Button>}>
                {errorMessage(payments.error)}
              </Empty>
            ) : payments.data.length === 0 ? (
              <Empty title="No payments yet">
                {inv.status === "issued" ? "Payments recorded here, or received in QBO, are applied to this invoice." : "Only an issued invoice can be paid."}
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="table" style={{ minWidth: 520 }}>
                  <thead>
                    <tr>
                      <th scope="col">Reference</th>
                      <th scope="col">Date</th>
                      <th scope="col">Method</th>
                      <th scope="col" className="num">
                        Amount
                      </th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.data.map((p) => {
                      const voided = p.status === "voided";
                      return (
                        <tr key={p.id}>
                          <td className={`mono${voided ? " strike" : ""}`}>{p.ref}</td>
                          <td className={voided ? "muted" : undefined}>{formatDate(p.txnDate)}</td>
                          <td className="muted">{p.method}</td>
                          <td className={`num${voided ? " strike" : ""}`}>
                            <Money cents={p.amountCents} />
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {voided ? (
                              <span className="pill pill-voided">Voided</span>
                            ) : (
                              <Button size="sm" variant="ghost" style={{ color: "var(--rose-ink)" }} onClick={() => setAction({ voidPayment: p })}>
                                Void
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <aside className="split-side">
          <SyncPanel invoice={inv} link={link} />
        </aside>
      </div>

      <Confirm
        open={action === "issue"}
        onClose={() => setAction(null)}
        title={`Issue ${inv.docNumber}?`}
        confirmLabel="Issue invoice"
        onConfirm={run(() => api.issueInvoice(inv), `Issued ${inv.docNumber}. It will appear in QBO shortly.`)}
      >
        It will be sent to QuickBooks Online as {inv.docNumber}, for {formatCents(linesTotal)}. After that it can be voided but not deleted.
      </Confirm>
      <Confirm
        open={action === "void"}
        onClose={() => setAction(null)}
        title={`Void ${inv.docNumber}?`}
        confirmLabel="Void invoice"
        danger
        onConfirm={run(() => api.voidInvoice(inv), `Voided ${inv.docNumber}`)}
      >
        The invoice stays on record with its amounts zeroed, here and in QBO. This can't be undone.
        {inv.paidCents > 0 && ` It has ${formatCents(inv.paidCents)} in payments applied.`}
      </Confirm>
      <Confirm
        open={action === "delete"}
        onClose={() => setAction(null)}
        title={`Delete draft ${inv.docNumber}?`}
        confirmLabel="Delete draft"
        danger
        onConfirm={run(async () => {
          await api.deleteInvoice(inv);
          navigate("/invoices", { replace: true });
        }, `Deleted draft ${inv.docNumber}`)}
      >
        The draft is removed for good. It was never sent to QBO.
      </Confirm>
      {action && typeof action === "object" && (
        <Confirm
          open
          onClose={() => setAction(null)}
          title={`Void payment ${action.voidPayment.ref}?`}
          confirmLabel="Void payment"
          danger
          onConfirm={async () => {
            try {
              await api.voidPayment(action.voidPayment);
              toast(`Voided payment ${action.voidPayment.ref}`);
            } catch (err) {
              if (err instanceof ApiError && err.isStale) {
                payments.refetch();
                throw new ApiError(409, "This payment changed since you opened it. It has been reloaded; try again.");
              }
              throw err;
            }
          }}
        >
          {formatCents(action.voidPayment.amountCents)} goes back onto the balance of {inv.docNumber}, here and in QBO. This can't be undone.
        </Confirm>
      )}
      <PaymentDialog open={action === "pay"} invoice={inv} onClose={() => setAction(null)} />
    </>
  );
}

const METHODS = ["check", "ach", "card", "cash", "wire"];

function PaymentDialog({ open, invoice, onClose }: { open: boolean; invoice: Invoice; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="pay-title">
      <PaymentForm invoice={invoice} onClose={onClose} />
    </Dialog>
  );
}

/** Mounted fresh each time the dialog opens, so each payment gets its own Idempotency-Key. */
function PaymentForm({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(centsToInput(invoice.balanceCents));
  const [txnDate, setTxnDate] = useState(today());
  const [method, setMethod] = useState("check");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);

  const pay = useMutation({
    mutationFn: (amountCents: number) =>
      api.createPayment({ invoiceId: invoice.id, amountCents, txnDate, method: method.trim(), ref: ref.trim() || undefined }, key),
    onSuccess: (p) => {
      toast(`Recorded ${formatCents(p.amountCents)} as ${p.ref}`);
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const cents = parseCents(amount);
        if (cents === null || cents <= 0) return setError("Enter an amount, like 250 or 1,200.50.");
        if (cents > invoice.balanceCents) return setError(`That's more than the ${formatCents(invoice.balanceCents)} still owed.`);
        if (!txnDate) return setError("Pick the date the payment was received.");
        if (!method.trim()) return setError("Say how it was paid.");
        setError(null);
        pay.mutate(cents);
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p className="eyebrow">{invoice.docNumber}</p>
        <h2 id="pay-title">Record a payment</h2>
        <p className="muted" style={{ fontSize: 14 }}>
          {formatCents(invoice.balanceCents)} is still owed. The payment is applied to this invoice and copied to QBO.
        </p>
      </div>
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="pay-amount">
            Amount
          </label>
          <input id="pay-amount" className="input amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label className="label" htmlFor="pay-date">
            Received
          </label>
          <input id="pay-date" className="input" type="date" value={txnDate} min={invoice.txnDate} onChange={(e) => setTxnDate(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="pay-method">
            Method
          </label>
          <input id="pay-method" className="input" list="pay-methods" value={method} onChange={(e) => setMethod(e.target.value)} />
          <datalist id="pay-methods">
            {METHODS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label className="label" htmlFor="pay-ref">
            Reference (optional)
          </label>
          <input id="pay-ref" className="input mono" value={ref} placeholder="PAY-…" onChange={(e) => setRef(e.target.value)} />
        </div>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button onClick={onClose} disabled={pay.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={pay.isPending}>
          Record payment
        </Button>
      </div>
    </form>
  );
}

const OUTCOME: Record<Attempt["outcome"], string> = {
  synced: "Synced",
  skipped: "No change",
  attention: "Needs attention",
  candidate: "Link candidate",
  conflict: "Conflict",
  paused: "Paused",
  failed: "Failed",
};

function SyncPanel({ invoice, link }: { invoice: Invoice; link: { id: number; qboId: string | null; state: string; updatedAt: string } | undefined }) {
  const attempts = useQuery({ ...q.attempts(link?.id ?? 0), enabled: !!link });
  return (
    <section className="card" aria-labelledby="sync-title">
      <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 12, borderBottom: "1px solid var(--line)" }}>
        <p className="eyebrow" id="sync-title">
          QuickBooks Online
        </p>
        {link ? (
          <dl className="facts" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div>
              <dt>QBO invoice</dt>
              <dd className="mono">{link.qboId ?? "Being created…"}</dd>
            </div>
            <div>
              <dt>Last change</dt>
              <dd>{formatAgo(link.updatedAt)}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted" style={{ fontSize: 14 }}>
            {invoice.status === "draft" ? "Not sent to QBO while it's a draft." : "Waiting for the sync to pick it up. This usually takes seconds."}
          </p>
        )}
      </div>
      {link && (
        <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h3>Sync history</h3>
          {attempts.isPending ? (
            <div className="skeleton" style={{ height: 18 }} />
          ) : attempts.isError ? (
            <p className="error-text">{errorMessage(attempts.error)}</p>
          ) : attempts.data.length === 0 ? (
            <p className="muted" style={{ fontSize: 14 }}>
              No attempts recorded yet.
            </p>
          ) : (
            <ol className="timeline">
              {attempts.data.slice(0, 25).map((a) => (
                <li key={a.id}>
                  <span className={`dot o-${a.outcome}`} aria-hidden="true" />
                  <details>
                    <summary>
                      <span style={{ fontSize: 14, display: "block" }}>{a.summary}</span>
                      <span className="meta">
                        {OUTCOME[a.outcome]} · from {a.trigger.side === "qbo" ? "QBO" : "Internal"} ·{" "}
                        <time dateTime={a.at} title={formatStamp(a.at)}>
                          {formatAgo(a.at)}
                        </time>
                      </span>
                    </summary>
                    <div className="more">
                      {a.writes.length === 0 && <span>Nothing written.</span>}
                      {a.writes.map((w, i) => (
                        <span key={i}>
                          {w.action === "create" ? "Created" : w.action === "update" ? "Updated" : w.action} {w.entity} {w.id} in {w.side === "qbo" ? "QBO" : "Internal"}
                          {w.fields?.length ? ` (${w.fields.join(", ")})` : ""}
                        </span>
                      ))}
                      {a.notes.map((n, i) => (
                        <span key={i}>Note: {n}</span>
                      ))}
                      {a.error && <span className="error-text mono">{a.error}</span>}
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
