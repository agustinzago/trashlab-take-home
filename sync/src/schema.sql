-- A Change Hint: "this record on this Side may have changed". Dedupe key drops redeliveries.
CREATE TABLE IF NOT EXISTS change_hints (
  id bigserial PRIMARY KEY,
  side text NOT NULL CHECK (side IN ('internal', 'qbo')),
  record_type text NOT NULL,
  record_id text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Postgres queue: claimed with SKIP LOCKED and a lease.
CREATE TABLE IF NOT EXISTS sync_jobs (
  id bigserial PRIMARY KEY,
  side text NOT NULL,
  record_type text NOT NULL,
  record_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Bursts of hints coalesce into at most one pending job per record.
CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_one_pending ON sync_jobs (side, record_type, record_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS sync_jobs_due ON sync_jobs (next_run_at) WHERE status IN ('pending', 'running');

-- A Link joins the same record on both Sides and holds its Base.
CREATE TABLE IF NOT EXISTS links (
  id serial PRIMARY KEY,
  record_type text NOT NULL,
  internal_id text, -- null until a QBO-originated record is created internally
  qbo_id text, -- null until an internal record is created in QBO
  doc_number text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'linked', 'paused', 'attention', 'closed')),
  base jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_type, internal_id),
  UNIQUE (record_type, qbo_id)
);

-- Exactly one row per run: what was seen, what was written where, and the outcome.
CREATE TABLE IF NOT EXISTS sync_attempts (
  id bigserial PRIMARY KEY,
  link_id integer REFERENCES links(id),
  job_id bigint,
  trigger jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('synced', 'skipped', 'attention', 'failed')),
  summary text NOT NULL,
  snapshots jsonb NOT NULL DEFAULT '{}',
  writes jsonb NOT NULL DEFAULT '[]',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_attempts_link ON sync_attempts (link_id);

-- Account Mapping: internal revenue category -> QBO Item id (payment methods come later).
CREATE TABLE IF NOT EXISTS account_mappings (
  kind text NOT NULL CHECK (kind IN ('revenue_category', 'payment_method')),
  internal_key text NOT NULL,
  qbo_ref text NOT NULL,
  PRIMARY KEY (kind, internal_key)
);
