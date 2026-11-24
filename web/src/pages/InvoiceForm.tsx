import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, newIdempotencyKey, q, type Invoice, type InvoiceInput, type Line } from "../api.ts";
import { centsToInput, formatCents, parseCents, today } from "../format.ts";
import { Button, Empty, ErrorState, errorMessage, Skeleton, usePageTitle, useToast } from "../ui.tsx";

/** Create (/invoices/new) or edit (/invoices/:id/edit). */
export function InvoiceForm() {
  const id = Number(useParams().id);
  const editing = Number.isInteger(id) && id > 0;
  const invoice = useQuery({ ...q.invoice(id), enabled: editing, refetchInterval: false, refetchOnWindowFocus: false });
  const [generation, setGeneration] = useState(0);
  usePageTitle(editing ? `Edit ${invoice.data?.docNumber ?? "invoice"}` : "New invoice");

  if (!editing) return <Form />;
  if (invoice.isPending) return <Skeleton rows={10} />;
  if (invoice.isError) return <ErrorState error={invoice.error} retry={() => invoice.refetch()} />;
  if (invoice.data.status === "voided")
    return (
      <div className="card">
        <Empty title="A voided invoice can't be edited" action={<Link to={`/invoices/${id}`} className="btn btn-primary">Back to invoice</Link>}>
          Voiding keeps the record for history with its amounts zeroed.
        </Empty>
      </div>
    );
  // Background refreshes don't touch the form; "Load latest version" remounts it on the newest data.
  return (
    <Form
      key={generation}
      initial={invoice.data}
      onReload={async () => {
        await invoice.refetch();
        setGeneration((g) => g + 1);
      }}
    />
  );
}

type DraftLine = { key: string; description: string; revenueCategory: string; amount: string };
const blankLine = (): DraftLine => ({ key: newIdempotencyKey(), description: "", revenueCategory: "", amount: "" });
const toDraft = (l: Line): DraftLine => ({ key: newIdempotencyKey(), description: l.description, revenueCategory: l.revenueCategory, amount: centsToInput(l.amountCents) });

type Errors = Partial<Record<"docNumber" | "customer" | "txnDate" | "dueDate" | "lines" | "form", string>> & { line?: Record<string, string> };

function Form({ initial, onReload }: { initial?: Invoice; onReload?: () => void }) {
  // The version the person started editing. Edits are sent with its version, so a change made meanwhile
  // (by someone else or by the sync) is refused with 409 rather than overwritten.
  const [invoice] = useState(initial);
  const navigate = useNavigate();
  const toast = useToast();
  const uid = useId();
  const customers = useQuery(q.customers());
  const invoices = useQuery(q.invoices());
  const links = useQuery(q.links());

  const [docNumber, setDocNumber] = useState(invoice?.docNumber ?? "");
  const [customerId, setCustomerId] = useState(invoice ? String(invoice.customerId) : "");
  const [newCustomer, setNewCustomer] = useState("");
  const [txnDate, setTxnDate] = useState(invoice?.txnDate ?? today());
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? "");
  const [memo, setMemo] = useState(invoice?.memo ?? "");
  const [lines, setLines] = useState<DraftLine[]>(invoice ? invoice.lines.map(toDraft) : [blankLine()]);
  const [errors, setErrors] = useState<Errors>({});
  const [stale, setStale] = useState(false);
  // One key per form: a retry after a lost reply replays the first create instead of making a second.
  const [keys] = useState(() => ({ invoice: newIdempotencyKey(), customer: newIdempotencyKey() }));

  // DocNumber is the identity shared with QBO: once linked, a change would be flagged, not synced.
  const linked = !!invoice && !!links.data?.some((l) => l.internalId === String(invoice.id) && l.qboId);
  const categories = useMemo(() => [...new Set(invoices.data?.flatMap((i) => i.lines.map((l) => l.revenueCategory)))].sort(), [invoices.data]);
  const total = lines.reduce((s, l) => s + (parseCents(l.amount) ?? 0), 0);

  function validate(): InvoiceInput | null {
    const e: Errors = { line: {} };
    if (!docNumber.trim()) e.docNumber = "Give the invoice a number.";
    else if (!invoice && invoices.data?.some((i) => i.docNumber === docNumber.trim())) e.docNumber = "Another invoice already uses this number.";
    if (customerId === "new" ? !newCustomer.trim() : !customerId) e.customer = customerId === "new" ? "Enter the new customer's name." : "Choose a customer.";
    if (!txnDate) e.txnDate = "Pick the invoice date.";
    if (dueDate && txnDate && dueDate < txnDate) e.dueDate = "The due date is before the invoice date.";
    const parsed: Line[] = [];
    for (const l of lines) {
      const cents = parseCents(l.amount);
      if (!l.description.trim()) e.line![l.key] = "Describe this line.";
      else if (!l.revenueCategory.trim()) e.line![l.key] = "Pick a revenue category.";
      else if (cents === null || cents === 0) e.line![l.key] = "Enter an amount, like 250 or 1,200.50.";
      // Same key order as the API sends, so changedFields compares like with like.
      else parsed.push({ description: l.description.trim(), amountCents: cents, revenueCategory: l.revenueCategory.trim() });
    }
    if (!lines.length) e.lines = "Add at least one line.";
    else if (parsed.length === lines.length && total < 0) e.lines = "The total can't be negative.";
    if (!Object.keys(e.line!).length) delete e.line;
    setErrors(e);
    if (Object.keys(e).length) return null;
    return {
      docNumber: docNumber.trim(),
      customerId: Number(customerId),
      txnDate,
      dueDate: dueDate || null,
      memo: memo.trim() || null,
      lines: parsed,
    };
  }

  const save = useMutation({
    mutationFn: async ({ body, issue }: { body: InvoiceInput; issue: boolean }) => {
      if (customerId === "new") {
        const c = await api.createCustomer(newCustomer.trim(), keys.customer);
        setCustomerId(String(c.id)); // a retry reuses it instead of creating another
        body = { ...body, customerId: c.id };
      }
      if (!invoice) return api.createInvoice({ ...body, status: issue ? "issued" : "draft" }, keys.invoice);
      const patch = changedFields(invoice, body);
      return Object.keys(patch).length ? api.updateInvoice(invoice, patch) : invoice;
    },
    onSuccess: (saved, { issue }) => {
      toast(invoice ? `Saved ${saved.docNumber}` : issue ? `Issued ${saved.docNumber}. It will appear in QBO shortly.` : `Saved ${saved.docNumber} as a draft`);
      navigate(`/invoices/${saved.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.isStale) setStale(true);
      else setErrors({ form: errorMessage(err) });
      window.scrollTo({ top: 0, behavior: "smooth" }); // the banner is at the top
    },
  });

  // After the first attempt, errors follow the fields as they're fixed.
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (tried) validate();
  }, [tried, docNumber, customerId, newCustomer, txnDate, dueDate, lines]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (issue: boolean) => {
    setTried(true);
    const body = validate();
    if (body) save.mutate({ body, issue });
    else requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  };

  const setLine = (key: string, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const back = invoice ? `/invoices/${invoice.id}` : "/invoices";

  return (
    <form
      className="section"
      style={{ gap: 24, maxWidth: 960 }}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <Link to={back} className="back">
        ← {invoice ? invoice.docNumber : "Invoices"}
      </Link>
      <div className="page-head">
        <div>
          <p className="eyebrow">{invoice ? "Edit invoice" : "New invoice"}</p>
          <h1>{invoice ? invoice.docNumber : "Create an invoice"}</h1>
        </div>
      </div>

      {stale && (
        <div className="banner banner-warn" role="alert">
          <span>
            <strong>This invoice changed while you were editing</strong>, maybe through the sync from QBO. Load the latest version and make your change
            again.
          </span>
          <Button size="sm" variant="primary" onClick={onReload}>
            Load latest version
          </Button>
        </div>
      )}
      {errors.form && (
        <div className="banner banner-danger" role="alert">
          {errors.form}
        </div>
      )}

      <section className="card card-pad" aria-labelledby={`${uid}-details`} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <h2 id={`${uid}-details`} style={{ fontSize: 18 }}>
          Details
        </h2>
        <div className="form-grid">
          <Field id={`${uid}-doc`} label="Invoice number" error={errors.docNumber} hint={linked ? "Fixed once the invoice is in QBO." : "Shared with QBO as its DocNumber."}>
            <input
              id={`${uid}-doc`}
              className="input mono"
              value={docNumber}
              onChange={(e) => setDocNumber(e.target.value)}
              placeholder="INV-1001"
              disabled={linked}
              autoFocus={!invoice}
              aria-invalid={!!errors.docNumber}
            />
          </Field>
          <Field id={`${uid}-cust`} label="Customer" error={errors.customer}>
            <select id={`${uid}-cust`} className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-invalid={!!errors.customer}>
              <option value="">{customers.isPending ? "Loading…" : "Choose a customer"}</option>
              {customers.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
              <option value="new">+ New customer…</option>
            </select>
          </Field>
          {customerId === "new" && (
            <Field id={`${uid}-newcust`} label="New customer name" error={errors.customer}>
              <input id={`${uid}-newcust`} className="input" value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)} autoFocus aria-invalid={!!errors.customer} />
            </Field>
          )}
          <Field id={`${uid}-date`} label="Invoice date" error={errors.txnDate}>
            <input id={`${uid}-date`} type="date" className="input" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} aria-invalid={!!errors.txnDate} />
          </Field>
          <Field id={`${uid}-due`} label="Due date (optional)" error={errors.dueDate}>
            <input id={`${uid}-due`} type="date" className="input" value={dueDate} min={txnDate} onChange={(e) => setDueDate(e.target.value)} aria-invalid={!!errors.dueDate} />
          </Field>
        </div>
      </section>

      <section className="card card-pad" aria-labelledby={`${uid}-lines`} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="section-head">
          <h2 id={`${uid}-lines`} style={{ fontSize: 18 }}>
            Lines
          </h2>
          <p className="hint">Each revenue category posts to the QBO item set in the Account Mapping.</p>
        </div>
        <datalist id={`${uid}-cats`}>
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <div className="lines">
          <div className="line-head" aria-hidden="true">
            <span className="label">Description</span>
            <span className="label">Revenue category</span>
            <span className="label" style={{ textAlign: "right" }}>
              Amount
            </span>
            <span />
          </div>
          {lines.map((l, i) => {
            const err = errors.line?.[l.key];
            return (
              <div key={l.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div className="line-row" role="group" aria-label={`Line ${i + 1}`}>
                  <input className="input" aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} aria-invalid={!!err && !l.description.trim()} />
                  <input
                    className="input mono"
                    aria-label={`Line ${i + 1} revenue category`}
                    list={`${uid}-cats`}
                    value={l.revenueCategory}
                    onChange={(e) => setLine(l.key, { revenueCategory: e.target.value })}
                    placeholder="consulting"
                    aria-invalid={!!err && !!l.description.trim() && !l.revenueCategory.trim()}
                  />
                  <input
                    className="input amount"
                    aria-label={`Line ${i + 1} amount in dollars`}
                    inputMode="decimal"
                    value={l.amount}
                    placeholder="0.00"
                    onChange={(e) => setLine(l.key, { amount: e.target.value })}
                    onBlur={() => {
                      const c = parseCents(l.amount);
                      if (c !== null) setLine(l.key, { amount: centsToInput(c) });
                    }}
                    aria-invalid={!!err && !!l.description.trim() && !!l.revenueCategory.trim()}
                  />
                  <button type="button" className="icon-btn" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                {err && <p className="error-text">{err}</p>}
              </div>
            );
          })}
        </div>
        {errors.lines && (
          <p className="error-text" role="alert">
            {errors.lines}
          </p>
        )}
        <div className="section-head" style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          <Button size="sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            + Add line
          </Button>
          <p style={{ display: "flex", gap: 24, alignItems: "baseline" }}>
            <span className="label">Total</span>
            <span className="num" style={{ font: "700 22px var(--display)" }} aria-live="polite">
              {formatCents(total)}
            </span>
          </p>
        </div>
      </section>

      <section className="card card-pad">
        <Field id={`${uid}-memo`} label="Memo (optional)" hint="Shown to the customer on the invoice.">
          <textarea id={`${uid}-memo`} className="textarea" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
      </section>

      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <Link to={back} className="btn btn-ghost">
          Cancel
        </Link>
        {invoice ? (
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save changes
          </Button>
        ) : (
          <>
            <Button type="submit" busy={save.isPending && !save.variables?.issue}>
              Save as draft
            </Button>
            <Button variant="primary" busy={save.isPending && save.variables?.issue} disabled={save.isPending} onClick={() => submit(true)}>
              Issue invoice
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? <p className="error-text">{error}</p> : hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/** Only what the person changed: an unchanged field sent anyway would still bump the version and wake the sync. */
function changedFields(inv: Invoice, next: InvoiceInput): Partial<InvoiceInput> {
  const patch: Partial<InvoiceInput> = {};
  for (const k of ["docNumber", "customerId", "txnDate", "dueDate", "memo", "lines"] as const) {
    if (JSON.stringify(inv[k]) !== JSON.stringify(next[k])) Object.assign(patch, { [k]: next[k] });
  }
  return patch;
}
