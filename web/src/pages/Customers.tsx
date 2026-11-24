import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api, newIdempotencyKey, q } from "../api.ts";
import { formatCents } from "../format.ts";
import { Button, Empty, ErrorState, errorMessage, Skeleton, usePageTitle, useToast } from "../ui.tsx";

export function Customers() {
  usePageTitle("Customers");
  const customers = useQuery(q.customers());
  const invoices = useQuery(q.invoices());

  const totals = useMemo(() => {
    const m = new Map<number, { count: number; owed: number }>();
    for (const inv of invoices.data ?? []) {
      const t = m.get(inv.customerId) ?? { count: 0, owed: 0 };
      t.count++;
      if (inv.status === "issued") t.owed += inv.balanceCents;
      m.set(inv.customerId, t);
    }
    return m;
  }, [invoices.data]);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Customers</p>
          <h1>Customers</h1>
          <p className="lede">Matched to QBO customers by name, and created there on first use.</p>
        </div>
      </div>
      <div className="split">
        <section className="split-main" aria-label="Customer list">
          {customers.isPending ? (
            <Skeleton />
          ) : customers.isError ? (
            <ErrorState error={customers.error} retry={() => customers.refetch()} />
          ) : customers.data.length === 0 ? (
            <div className="card">
              <Empty title="No customers yet">Add one here, or when creating an invoice.</Empty>
            </div>
          ) : (
            <div className="card table-wrap">
              <table className="table" style={{ minWidth: 480 }}>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col" className="num">
                      Invoices
                    </th>
                    <th scope="col" className="num">
                      Outstanding
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {customers.data.map((c) => {
                    const t = totals.get(c.id);
                    return (
                      <tr key={c.id}>
                        <td>{c.displayName}</td>
                        <td className="num">{t?.count ? <Link to={`/invoices?q=${encodeURIComponent(c.displayName)}`}>{t.count}</Link> : <span className="muted">0</span>}</td>
                        <td className="num" style={{ fontWeight: 500 }}>
                          {formatCents(t?.owed ?? 0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <aside className="split-side">
          <NewCustomer existing={customers.data?.map((c) => c.displayName.toLowerCase()) ?? []} />
        </aside>
      </div>
    </>
  );
}

function NewCustomer({ existing }: { existing: string[] }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createCustomer(name.trim(), key),
    onSuccess: (c) => {
      toast(`Added ${c.displayName}`);
      setName("");
      setKey(newIdempotencyKey()); // the next customer is a new create
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <form
      className="card card-pad"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return setError("Enter a name.");
        // QBO matches customers by display name, so two with one name would be one customer there.
        if (existing.includes(name.trim().toLowerCase())) return setError("A customer with this name already exists.");
        setError(null);
        create.mutate();
      }}
    >
      <h2 style={{ fontSize: 18 }}>Add a customer</h2>
      <div className="field">
        <label className="label" htmlFor="customer-name">
          Display name
        </label>
        <input id="customer-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "customer-error" : undefined} />
        {error && (
          <p id="customer-error" className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" variant="primary" busy={create.isPending}>
        Add customer
      </Button>
    </form>
  );
}
