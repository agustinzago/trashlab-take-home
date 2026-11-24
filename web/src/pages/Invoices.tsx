import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { q, syncStateOf, type Customer, type Invoice, type InvoiceStatus, type Link as SyncLink } from "../api.ts";
import { formatDate } from "../format.ts";
import { Empty, ErrorState, Money, PaymentPill, Skeleton, SyncPill, usePageTitle } from "../ui.tsx";

const FILTERS: { key: InvoiceStatus | "all" | "attention"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "issued", label: "Issued" },
  { key: "voided", label: "Voided" },
  { key: "attention", label: "Out of sync" },
];

export function Invoices() {
  usePageTitle("Invoices");
  const [params, setParams] = useSearchParams();
  const filter = params.get("status") ?? "all";
  const search = params.get("q") ?? "";
  const deferredSearch = useDeferredValue(search);
  const invoices = useQuery(q.invoices());
  const customers = useQuery(q.customers());
  const links = useQuery(q.links());

  const rows = useMemo(() => {
    const names = new Map(customers.data?.map((c) => [c.id, c.displayName]));
    const needle = deferredSearch.trim().toLowerCase();
    return (invoices.data ?? [])
      .filter((inv) => {
        if (filter === "attention") return ["paused", "attention"].includes(syncStateOf(inv, links.data));
        return filter === "all" || inv.status === filter;
      })
      .filter((inv) => !needle || inv.docNumber.toLowerCase().includes(needle) || names.get(inv.customerId)?.toLowerCase().includes(needle))
      .sort((a, b) => b.id - a.id);
  }, [invoices.data, customers.data, links.data, filter, deferredSearch]);

  const hrefFor = (status: string) => {
    const p = new URLSearchParams(params);
    if (status === "all") p.delete("status");
    else p.set("status", status);
    return `?${p}`;
  };
  const setSearch = (value: string) =>
    setParams(
      (p) => {
        if (value) p.set("q", value);
        else p.delete("q");
        return p;
      },
      { replace: true },
    );

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Receivables</p>
          <h1>Invoices</h1>
        </div>
        <Link to="/invoices/new" className="btn btn-cta">
          New invoice
        </Link>
      </div>

      <section className="section" aria-label="Invoice list">
        <div className="section-head">
          <nav className="segmented" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <Link key={f.key} to={hrefFor(f.key)} aria-current={filter === f.key} replace>
                {f.label}
              </Link>
            ))}
          </nav>
          <label className="field" style={{ flex: "0 1 300px" }}>
            <span className="sr-only">Search invoices</span>
            <input className="input search" type="search" placeholder="Search doc number or customer" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>

        {invoices.isPending ? (
          <Skeleton rows={8} />
        ) : invoices.isError ? (
          <ErrorState error={invoices.error} retry={() => invoices.refetch()} />
        ) : (
          <InvoiceTable
            invoices={rows}
            customers={customers.data}
            links={links.data}
            empty={
              invoices.data.length === 0 ? (
                <Empty title="No invoices yet" action={<Link to="/invoices/new" className="btn btn-primary">Create the first invoice</Link>}>
                  Invoices you issue here appear in QuickBooks Online with the same number. Ones created in QBO show up here too.
                </Empty>
              ) : (
                <Empty title="Nothing matches">Try another filter or search.</Empty>
              )
            }
          />
        )}
      </section>
    </>
  );
}

export function InvoiceTable({
  invoices,
  customers,
  links,
  empty,
}: {
  invoices: Invoice[];
  customers: Customer[] | undefined;
  links: SyncLink[] | undefined;
  empty: React.ReactNode;
}) {
  const navigate = useNavigate();
  const names = new Map(customers?.map((c) => [c.id, c.displayName]));
  if (!invoices.length) return <div className="card">{empty}</div>;
  return (
    <div className="card table-wrap">
      <table className="table" style={{ minWidth: 900 }}>
        <thead>
          <tr>
            <th scope="col">Invoice</th>
            <th scope="col">Customer</th>
            <th scope="col">Date</th>
            <th scope="col">Due</th>
            <th scope="col">Status</th>
            <th scope="col">QBO sync</th>
            <th scope="col" className="num">
              Total
            </th>
            <th scope="col" className="num">
              Balance
            </th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            // The row is a convenience target; the doc number link is the accessible one.
            <tr key={inv.id} className="row-link" onClick={(e) => !(e.target as HTMLElement).closest("a") && navigate(`/invoices/${inv.id}`)}>
              <td>
                <Link to={`/invoices/${inv.id}`} className="doc">
                  {inv.docNumber}
                </Link>
              </td>
              <td>{names.get(inv.customerId) ?? <span className="muted">#{inv.customerId}</span>}</td>
              <td className="muted">{formatDate(inv.txnDate)}</td>
              <td className="muted">{formatDate(inv.dueDate)}</td>
              <td>
                <PaymentPill invoice={inv} />
              </td>
              <td>
                <SyncPill state={syncStateOf(inv, links)} />
              </td>
              <td className={`num${inv.status === "voided" ? " strike" : ""}`}>
                <Money cents={inv.lines.reduce((s, l) => s + l.amountCents, 0)} />
              </td>
              <td className="num" style={{ fontWeight: 500 }}>
                <Money cents={inv.status === "draft" ? 0 : inv.balanceCents} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
