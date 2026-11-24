import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api, ApiError, session } from "../api.ts";
import { Button, errorMessage, Logo, usePageTitle } from "../ui.tsx";

export function SignIn() {
  usePageTitle("Sign in");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only same-app paths: never an open redirect.
  const next = params.get("next")?.startsWith("/") && !params.get("next")?.startsWith("//") ? params.get("next")! : "/";

  if (session.signedIn() && !busy) return <Navigate to={next} replace />;

  return (
    <div className="signin">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          session.signIn(password);
          try {
            await api.status(); // checks the password
            navigate(next, { replace: true });
          } catch (err) {
            session.signOut();
            setError(err instanceof ApiError && err.status === 401 ? "That password isn't right." : errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <div className="brand" style={{ color: "var(--ink)" }}>
          <span style={{ background: "var(--ink)", borderRadius: 8, padding: 5, display: "grid" }}>
            <Logo />
          </span>
          Ledgerline
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p className="eyebrow">Invoice sync console</p>
          <h1 style={{ fontSize: 30 }}>Sign in</h1>
          <p className="muted">Use the sync admin password (ADMIN_PASSWORD) for this deployment.</p>
        </div>
        <div className="field">
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-error" : undefined}
          />
          {error && (
            <p id="signin-error" className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" variant="primary" busy={busy}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
