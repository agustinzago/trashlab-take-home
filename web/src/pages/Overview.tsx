import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { q, type Status } from "../api.ts";
import { formatAgo, formatCents, formatStamp } from "../format.ts";
import { ConnectQboButton } from "../Layout.tsx";
import { Empty, ErrorState, Skeleton, usePageTitle } from "../ui.tsx";
import { InvoiceTable } from "./Invoices.tsx";

export function Overview() {
  usePageTitle("Overview");
  const location = useLocation();
  const invoices = useQuery(q.invoices());
  const customers = useQuery(q.customers());
  const links = useQuery(q.links());
  const status = useQuery(q.status());
  const [conflicts, candidates, attention, failed] = useQueries({ queries: [q.conflicts(), q.candidates(), q.attention(), q.failedJobs()] });

  useEffect(() => {
    if (location.hash === "#qbo" && status.data) document.getElementById("qbo")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [location.hash, status.data]);

  const all = invoices.data ?? [];
  const issued = all.filter((i) => i.status === "issued");
  const outstanding = issued.reduce((s, i) => s + i.balanceCents, 0);
  const collected = all.reduce((s, i) => s + i.paidCents, 0);
  const synced = all.filter((i) => i.status !== "draft");
  const linked = synced.filter((i) => links.data?.some((l) => l.internalId === String(i.id) && l.state === "linked")).length;
  const n = { conflicts: conflicts.data?.length ?? 0, candidates: candidates.data?.length ?? 0, attention: attention.data?.length ?? 0, failed: failed.data?.length ?? 0 };
  const waiting = n.conflicts + n.candidates + n.attention + n.failed;
  const recent = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Overview</p>
          <h1 style={{ maxWidth: 760 }}>
            Invoices and payments, <span style={{ color: "var(--blue-ink)" }}>in step with</span> <span style={{ color: "var(--ink-3)" }}>QuickBooks Online.</span>
          </h1>
        </div>
        <Link to="/invoices/new" className="btn btn-cta">
          New invoice
        </Link>
      </div>

      {invoices.isError ? (
        <ErrorState error={invoices.error} retry={() => invoices.refetch()} />
      ) : (
        <section className="stats" aria-label="Totals">
          <div className="card stat">
            <p className="eyebrow">Outstanding</p>
            <p className="stat-value">{invoices.isPending ? "—" : formatCents(outstanding)}</p>
            <p className="stat-note">
              Across {issued.length} issued invoice{issued.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="card stat">
            <p className="eyebrow">Collected</p>
            <p className="stat-value">{invoices.isPending ? "—" : formatCents(collected)}</p>
            <p className="stat-note">Active payments applied to invoices</p>
          </div>
          <Link to="/review" className={`card stat${waiting ? " stat-accent" : ""}`}>
            <p className="eyebrow">Needs a person</p>
            <p className="stat-value">{waiting}</p>
            <p className="stat-note">
              {waiting
                ? [
                    n.conflicts && `${n.conflicts} conflict${n.conflicts > 1 ? "s" : ""}`,
                    n.candidates && `${n.candidates} link candidate${n.candidates > 1 ? "s" : ""}`,
                    n.attention && `${n.attention} attention`,
                    n.failed && `${n.failed} failed`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "Nothing waiting. The sync is handling everything."}
            </p>
          </Link>
          <div className="card stat">
            <p className="eyebrow">In sync</p>
            <p className="stat-value">{synced.length ? `${Math.round((linked / synced.length) * 100)}%` : "—"}</p>
            <p className="stat-note">
              {linked} of {synced.length} issued or voided invoices agree with QBO
            </p>
          </div>
        </section>
      )}

      {status.data && <Connection status={status.data} />}

      <section className="section">
        <div className="section-head">
          <h2>Recently changed</h2>
          <Link to="/invoices">All invoices →</Link>
        </div>
        {invoices.isPending ? (
          <Skeleton rows={6} />
        ) : (
          <InvoiceTable
            invoices={recent}
            customers={customers.data}
            links={links.data}
            empty={
              <Empty title="No invoices yet" action={<Link to="/invoices/new" className="btn btn-primary">Create an invoice</Link>}>
                Create one here or in QuickBooks Online; either way it appears on both sides.
              </Empty>
            }
          />
        )}
      </section>
    </>
  );
}

function Connection({ status }: { status: Status }) {
  const { qbo, jobs } = status;
  const daysLeft = qbo.connected ? Math.floor((new Date(qbo.refreshExpiresAt).getTime() - Date.now()) / 86_400_000) : 0;
  const expiringSoon = qbo.connected && daysLeft < 14;
  return (
    <section id="qbo" className="card card-pad dark-card" aria-labelledby="qbo-title" style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: "1 1 360px" }}>
        <p className="eyebrow" id="qbo-title">
          QuickBooks Online
        </p>
        {qbo.connected ? (
          <>
            <p style={{ fontSize: 17 }}>
              Connected to company <span className="mono">{qbo.realmId}</span>
            </p>
            <p className="muted" style={{ fontSize: 14 }}>
              {daysLeft > 0 ? `Sign-in valid for ${daysLeft} more day${daysLeft === 1 ? "" : "s"}` : "Sign-in has expired: reconnect to resume syncing"}
              {" · "}connected {formatStamp(qbo.connectedAt)}
              {status.cdcCursor && ` · last change poll ${formatAgo(status.cdcCursor)}`}
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: 17 }}>Not connected</p>
            <p className="muted" style={{ fontSize: 14, maxWidth: 560 }}>
              Sync work waits, nothing is lost. Connect the sandbox company to start. "Custom transaction numbers" must be on in QBO.
            </p>
          </>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          Queue: {jobs.pending} waiting · {jobs.running} running · {jobs.failed} failed
        </p>
      </div>
      {(!qbo.connected || expiringSoon) && <ConnectQboButton reconnect={qbo.connected} />}
      {qbo.connected && !expiringSoon && (
        <details>
          <summary className="btn btn-sm" style={{ color: "var(--sky)", listStyle: "none" }}>
            Reconnect…
          </summary>
          <div style={{ paddingTop: 8 }}>
            <ConnectQboButton reconnect />
          </div>
        </details>
      )}
    </section>
  );
}
