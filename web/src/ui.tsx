import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ApiError, type Invoice, type LinkState, type Line } from "./api.ts";
import { formatCents } from "./format.ts";

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Ledgerline`;
  }, [title]);
}

export const Logo = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
    <rect x="1" y="4" width="20" height="14" rx="4" fill="none" stroke="#ccdaff" strokeWidth="2" />
    <path d="M6 11h10M11 7v8" stroke="#ccdaff" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "danger-solid" | "ghost" | "cta";
  size?: "sm";
  busy?: boolean;
};

/** A button that shows progress and can't be pressed twice while its action runs. */
export function Button({ variant = "secondary", size, busy, disabled, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={["btn", `btn-${variant}`, size && `btn-${size}`, className].filter(Boolean).join(" ")}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

// --- Status pills ---

export function PaymentPill({ invoice }: { invoice: Pick<Invoice, "status" | "paymentStatus"> }) {
  if (invoice.status === "draft") return <span className="pill pill-draft">Draft</span>;
  if (invoice.status === "voided") return <span className="pill pill-voided">Voided</span>;
  const map = {
    paid: ["pill-paid", "Paid"],
    partially_paid: ["pill-partial", "Partially paid"],
    unpaid: ["pill-unpaid", "Unpaid"],
  } as const;
  const [cls, label] = map[invoice.paymentStatus];
  return <span className={`pill ${cls}`}>{label}</span>;
}

const SYNC: Record<LinkState | "none" | "draft", [string, string, string]> = {
  linked: ["pill-ok", "In sync", "Both sides agree."],
  pending: ["pill-wait", "Syncing", "Being written to the other side."],
  paused: ["pill-warn", "Conflict", "Changed differently on both sides; paused until someone picks one."],
  attention: ["pill-danger", "Needs attention", "The sync can't continue safely without a person."],
  closed: ["pill-muted", "Closed", "No longer synced."],
  none: ["pill-wait", "Waiting", "Not linked to QBO yet."],
  draft: ["pill-muted", "Not synced", "Drafts stay in the Internal System until issued."],
};

export function SyncPill({ state }: { state: LinkState | "none" | "draft" }) {
  const [cls, label, title] = SYNC[state];
  const solid = cls === "pill-warn" || cls === "pill-danger";
  return (
    <span className={`pill ${cls}`} title={title}>
      {!solid && <span className="dot" aria-hidden="true" />}
      {label}
    </span>
  );
}

// --- Values ---

export const Money = ({ cents, className }: { cents: number; className?: string }) => <span className={className}>{formatCents(cents)}</span>;

export function LinesValue({ lines, highlight }: { lines: Line[]; highlight?: Line[] }) {
  if (!lines.length) return <span className="muted">No lines</span>;
  return (
    <ul className="value-lines">
      {lines.map((l, i) => {
        const other = highlight?.[i];
        const changed = highlight && (!other || other.description !== l.description || other.amountCents !== l.amountCents || other.revenueCategory !== l.revenueCategory);
        return (
          <li key={i}>
            <span className={changed ? "changed" : undefined}>
              {l.description} <span className="cat">{l.revenueCategory}</span>
            </span>
            <span className={`num${changed ? " changed" : ""}`}>{formatCents(l.amountCents)}</span>
          </li>
        );
      })}
    </ul>
  );
}

// --- Loading, empty, error ---

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="card card-pad" aria-busy="true" aria-label="Loading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 18, width: `${90 - ((i * 17) % 35)}%` }} />
      ))}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="card">
      <Empty title="Couldn't load this" action={retry && <Button onClick={retry}>Try again</Button>}>
        {errorMessage(error)}
      </Empty>
    </div>
  );
}

export const errorMessage = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong.");

// --- Dialog: the native <dialog>, which traps focus and closes on Escape ---

export function Dialog({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={labelledBy}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()} // backdrop
    >
      {open && children}
    </dialog>
  );
}

/** Asks before an action that can't be undone, and shows its error in place. */
export function Confirm({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} labelledBy="confirm-title">
      <div className="dialog-body">
        <h2 id="confirm-title">{title}</h2>
        <div className="muted">{children}</div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger-solid" : "primary"}
            busy={busy}
            autoFocus
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                setBusy(false);
                onClose();
              } catch (err) {
                setBusy(false);
                setError(errorMessage(err));
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Toasts ---

type Toast = { id: number; text: string; error?: boolean };
const ToastContext = createContext<(text: string, opts?: { error?: boolean }) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (text: string, opts?: { error?: boolean }) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-2), { id, text, error: opts?.error }]);
      setTimeout(() => dismiss(id), opts?.error ? 8000 : 4000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " error" : ""}`}>
            <span>{t.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
