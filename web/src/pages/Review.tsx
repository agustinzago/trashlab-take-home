import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { api, q, SYNCED_FIELDS, type Candidate, type Conflict, type FieldName, type Line, type Link as SyncLink, type Side } from "../api.ts";
import { formatAgo, formatDate, formatStamp } from "../format.ts";
import { Button, Empty, ErrorState, errorMessage, LinesValue, Skeleton, usePageTitle, useToast } from "../ui.tsx";

const TABS = [
  { key: "conflicts", label: "Conflicts" },
  { key: "candidates", label: "Link candidates" },
  { key: "attention", label: "Needs attention" },
  { key: "failed", label: "Failed jobs" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const FIELD_LABEL: Record<FieldName, string> = { customer: "Customer", txnDate: "Invoice date", lines: "Lines", dueDate: "Due date", memo: "Memo" };
const SIDE_LABEL: Record<Side, string> = { internal: "Internal System", qbo: "QuickBooks Online" };

export function Review() {
  usePageTitle("Review");
  const [params] = useSearchParams();
  const queries = useQueries({ queries: [q.conflicts(), q.candidates(), q.attention(), q.failedJobs()] });
  const links = useQuery(q.links());
  const [conflicts, candidates, attention, failed] = queries;
  const counts: Record<Tab, number | undefined> = {
    conflicts: conflicts.data?.length,
    candidates: candidates.data?.length,
    attention: attention.data?.length,
    failed: failed.data?.length,
  };
  const total = Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);
  const asked = params.get("tab") as Tab | null;
  const tab: Tab = asked && asked in counts ? asked : (TABS.find((t) => counts[t.key])?.key ?? "conflicts");
  const loading = queries.some((x) => x.isPending);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Review queue</p>
          <h1>{loading ? "Review" : total === 0 ? "Nothing needs a person." : total === 1 ? "One thing needs a person." : `${total} things need a person.`}</h1>
          <p className="lede">Each item here is held, not lost. Pick a side and the sync carries the winning version across on its next run.</p>
        </div>
      </div>

      <nav className="tabs" aria-label="Review queues">
        {TABS.map((t) => (
          <Link key={t.key} to={`?tab=${t.key}`} replace aria-current={tab === t.key}>
            {t.label}
            {counts[t.key] !== undefined && <span className={`tab-count${counts[t.key] ? " hot" : ""}`}>{counts[t.key]}</span>}
          </Link>
        ))}
      </nav>

      {tab === "conflicts" &&
        (conflicts.isPending ? (
          <Skeleton />
        ) : conflicts.isError ? (
          <ErrorState error={conflicts.error} retry={() => conflicts.refetch()} />
        ) : conflicts.data.length === 0 ? (
          <div className="card">
            <Empty title="No conflicts">A conflict appears when the same money field changes to different values on both sides.</Empty>
          </div>
        ) : (
          conflicts.data.map((c) => <ConflictCard key={c.id} conflict={c} links={links.data} />)
        ))}

      {tab === "candidates" &&
        (candidates.isPending ? (
          <Skeleton />
        ) : candidates.isError ? (
          <ErrorState error={candidates.error} retry={() => candidates.refetch()} />
        ) : candidates.data.length === 0 ? (
          <div className="card">
            <Empty title="No link candidates">The backfill proposes a link when invoices that existed before the sync share a number but differ.</Empty>
          </div>
        ) : (
          candidates.data.map((c) => <CandidateCard key={c.id} candidate={c} />)
        ))}

      {tab === "attention" &&
        (attention.isPending ? (
          <Skeleton />
        ) : attention.isError ? (
          <ErrorState error={attention.error} retry={() => attention.refetch()} />
        ) : attention.data.length === 0 ? (
          <div className="card">
            <Empty title="Nothing needs attention">Records the sync can't move safely on its own show up here.</Empty>
          </div>
        ) : (
          <section className="card">
            <p className="card-pad muted" style={{ fontSize: 14, borderBottom: "1px solid var(--line)" }}>
              Fix the cause (for example, add the missing Account Mapping and restart the sync service), then edit the invoice to run the sync again.
            </p>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Record</th>
                    <th scope="col">Why</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.data.map((a) => (
                    <tr key={a.attemptId}>
                      <td>
                        <InvoiceRef docNumber={a.docNumber} internalId={internalIdOf(a, links.data)} />
                      </td>
                      <td className="mono muted">{a.record}</td>
                      <td>{a.summary}</td>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>
                        <time dateTime={a.at} title={formatStamp(a.at)}>
                          {formatAgo(a.at)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

      {tab === "failed" &&
        (failed.isPending ? (
          <Skeleton />
        ) : failed.isError ? (
          <ErrorState error={failed.error} retry={() => failed.refetch()} />
        ) : failed.data.length === 0 ? (
          <div className="card">
            <Empty title="No failed jobs">A job fails after its retries run out or on an error that retrying can't fix.</Empty>
          </div>
        ) : (
          <section className="card table-wrap">
            <table className="table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col" className="num">
                    Attempts
                  </th>
                  <th scope="col">Last error</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {failed.data.map((j) => (
                  <tr key={j.id}>
                    <td className="mono">{j.record}</td>
                    <td className="num">{j.attempts}</td>
                    <td className="mono" style={{ fontSize: 12, overflowWrap: "anywhere", maxWidth: 520 }}>
                      {j.error ?? "—"}
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {formatAgo(j.at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
    </>
  );
}

const internalIdOf = (a: { linkId: number | null; record: string }, links: SyncLink[] | undefined) =>
  a.linkId ? links?.find((l) => l.id === a.linkId)?.internalId : /^internal invoice (\d+)$/.exec(a.record)?.[1];

function InvoiceRef({ docNumber, internalId }: { docNumber: string | null | undefined; internalId: string | null | undefined }) {
  if (!internalId) return <span className="mono">{docNumber ?? "—"}</span>;
  return (
    <Link to={`/invoices/${internalId}`} className="doc">
      {docNumber ?? `#${internalId}`}
    </Link>
  );
}

function FieldValue({ field, value, against }: { field: FieldName; value: unknown; against?: unknown }) {
  if (field === "lines") return <LinesValue lines={(value as Line[]) ?? []} highlight={against as Line[] | undefined} />;
  const text = field === "txnDate" || field === "dueDate" ? formatDate(value as string | null) : ((value as string | null) ?? "");
  const changed = against !== undefined && value !== against;
  return <span className={`value${changed ? " changed" : ""}`}>{text || <span className="muted">(empty)</span>}</span>;
}

/** Pick-a-side buttons shared by Conflicts and Link Candidates. */
function PickSide({ label, onPick }: { label: string; onPick: (winner: Side) => Promise<unknown> }) {
  const toast = useToast();
  const pick = useMutation({
    mutationFn: onPick,
    onSuccess: (_r, winner) => toast(`${label}: keeping the ${SIDE_LABEL[winner]} version. The sync copies it across next.`),
    onError: (err) => toast(errorMessage(err), { error: true }),
  });
  return (
    <div className="actions">
      <Button busy={pick.isPending && pick.variables === "internal"} disabled={pick.isPending} onClick={() => pick.mutate("internal")}>
        Keep Internal
      </Button>
      <Button variant="primary" busy={pick.isPending && pick.variables === "qbo"} disabled={pick.isPending} onClick={() => pick.mutate("qbo")}>
        Keep QBO
      </Button>
    </div>
  );
}

function ConflictCard({ conflict, links }: { conflict: Conflict; links: SyncLink[] | undefined }) {
  const internalId = links?.find((l) => l.id === conflict.linkId)?.internalId;
  const fields = conflict.fields.map((f) => FIELD_LABEL[f.field].toLowerCase()).join(", ");
  return (
    <article className="card" aria-labelledby={`conflict-${conflict.id}`}>
      <header className="card-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 id={`conflict-${conflict.id}`} style={{ fontSize: 20 }}>
            <InvoiceRef docNumber={conflict.docNumber} internalId={internalId} />
          </h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {fields.charAt(0).toUpperCase() + fields.slice(1)} changed on both sides · raised {formatAgo(conflict.raisedAt)}
          </span>
        </div>
        <PickSide label={conflict.docNumber} onPick={(w) => api.resolveConflict(conflict.id, w)} />
      </header>
      <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {conflict.fields.map((f) => (
          <div key={f.field} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p className="eyebrow" style={{ color: "var(--ink)" }}>
              {FIELD_LABEL[f.field]}
            </p>
            <div className="compare">
              <div className="compare-col base">
                <h4>Last agreed</h4>
                <FieldValue field={f.field} value={f.base} />
              </div>
              <div className="compare-col">
                <h4>{SIDE_LABEL.internal}</h4>
                <FieldValue field={f.field} value={f.internal} against={f.base} />
              </div>
              <div className="compare-col">
                <h4>{SIDE_LABEL.qbo}</h4>
                <FieldValue field={f.field} value={f.qbo} against={f.base} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function CandidateCard({ candidate }: { candidate: Candidate }) {
  const differing = SYNCED_FIELDS.filter((f) => JSON.stringify(candidate.internal[f]) !== JSON.stringify(candidate.qbo[f]));
  return (
    <article className="card" aria-labelledby={`candidate-${candidate.id}`}>
      <header className="card-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 id={`candidate-${candidate.id}`} style={{ fontSize: 20 }}>
            <InvoiceRef docNumber={candidate.docNumber} internalId={candidate.internalId} />
          </h2>
          <span className="muted" style={{ fontSize: 13 }}>
            Same number on both sides, but they differ · QBO invoice <span className="mono">{candidate.qboId}</span> · found {formatAgo(candidate.raisedAt)}
          </span>
        </div>
        <PickSide label={candidate.docNumber} onPick={(w) => api.confirmCandidate(candidate.id, w)} />
      </header>
      <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {differing.map((f) => (
          <div key={f} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p className="eyebrow" style={{ color: "var(--ink)" }}>
              {FIELD_LABEL[f]}
            </p>
            <div className="compare">
              <div className="compare-col">
                <h4>{SIDE_LABEL.internal}</h4>
                <FieldValue field={f} value={candidate.internal[f]} />
              </div>
              <div className="compare-col">
                <h4>{SIDE_LABEL.qbo}</h4>
                <FieldValue field={f} value={candidate.qbo[f]} against={candidate.internal[f]} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
