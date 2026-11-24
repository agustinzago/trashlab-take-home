import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api, q, session } from "./api.ts";
import { Button, Empty, errorMessage, Logo, useToast } from "./ui.tsx";

/** Open conflicts, candidates, attention items and failed jobs: everything waiting on a person. */
export function useReviewCount() {
  const results = useQueries({ queries: [q.conflicts(), q.candidates(), q.attention(), q.failedJobs()] });
  return results.reduce((n, r) => n + (r.data?.length ?? 0), 0);
}

export function Layout() {
  const location = useLocation();
  const signedIn = useSyncExternalStore(session.subscribe, session.signedIn);
  const queryClient = useQueryClient();

  // Drop cached data from the last session so nothing leaks into the sign-in screen or the next one.
  useEffect(() => {
    if (!signedIn) queryClient.clear();
  }, [signedIn, queryClient]);

  if (!signedIn) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Shell />;
}

function Shell() {
  const status = useQuery(q.status());
  const reviewCount = useReviewCount();
  const connected = status.data?.qbo.connected;

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <nav className="nav" aria-label="Primary">
          <Link to="/" className="brand">
            <Logo />
            Ledgerline
          </Link>
          <NavLink to="/" end className="nav-link">
            Overview
          </NavLink>
          <NavLink to="/invoices" className="nav-link">
            Invoices
          </NavLink>
          <NavLink to="/review" className="nav-link">
            Review
            {reviewCount > 0 && (
              <span className="nav-count" aria-label={`${reviewCount} waiting`}>
                {reviewCount}
              </span>
            )}
          </NavLink>
          <NavLink to="/customers" className="nav-link">
            Customers
          </NavLink>
          <span className="nav-spacer" />
          {status.data && (
            <Link to="/#qbo" className="nav-status" title={connected ? "QuickBooks Online is connected" : "QuickBooks Online is not connected"}>
              <span className="dot" style={{ background: connected ? "var(--mint)" : "#f0a58f" }} aria-hidden="true" />
              <span>{connected ? "QBO connected" : "QBO not connected"}</span>
            </Link>
          )}
          <button type="button" className="nav-signout" onClick={() => session.signOut()}>
            Sign out
          </button>
        </nav>
      </header>
      <main id="main" className="page" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Starts the Intuit sign-in in a new tab. The tab is opened during the click (so it isn't blocked as a popup)
 * and pointed at Intuit once the sync service has issued the URL; this tab sees the connection on its next poll.
 */
export function ConnectQboButton({ reconnect }: { reconnect?: boolean }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Button
      variant="cta"
      busy={busy}
      onClick={async () => {
        const tab = window.open("about:blank", "_blank");
        if (tab) tab.opener = null;
        setBusy(true);
        try {
          const { url } = await api.qboConnectUrl();
          if (tab) tab.location.href = url;
          else window.location.href = url;
          toast("Finish signing in to Intuit in the new tab. This page updates once QBO is connected.");
        } catch (err) {
          tab?.close();
          toast(errorMessage(err), { error: true });
        } finally {
          setBusy(false);
        }
      }}
    >
      {reconnect ? "Reconnect QBO" : "Connect QBO"}
    </Button>
  );
}

export function RouteError({ notFound }: { notFound?: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="card" style={{ margin: notFound ? 0 : "40px var(--gutter)" }}>
      <Empty
        title={notFound ? "Page not found" : "Something went wrong"}
        action={
          <Button variant="primary" onClick={() => navigate("/")}>
            Go to overview
          </Button>
        }
      >
        {notFound ? "There's nothing at this address." : "The page hit an unexpected error. Reloading usually fixes it."}
      </Empty>
    </div>
  );
}
