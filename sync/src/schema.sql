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
  outcome text NOT NULL,
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

-- A Financial Field changed to different values on both Sides; the Link is paused until a person picks a Side.
CREATE TABLE IF NOT EXISTS conflicts (
  id serial PRIMARY KEY,
  link_id integer NOT NULL REFERENCES links(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  fields jsonb NOT NULL, -- [{ field, base, internal, qbo }]
  winner text CHECK (winner IN ('internal', 'qbo')),
  raised_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
-- At most one open Conflict per Link.
CREATE UNIQUE INDEX IF NOT EXISTS conflicts_one_open ON conflicts (link_id) WHERE status = 'open';

-- A Link Candidate: pre-existing Invoices on both Sides with the same DocNumber but
-- different fields, waiting for a person to pick a Side. Nothing is written until then.
CREATE TABLE IF NOT EXISTS link_candidates (
  id serial PRIMARY KEY,
  doc_number text NOT NULL,
  internal_id text NOT NULL,
  qbo_id text NOT NULL,
  internal_fields jsonb NOT NULL,
  qbo_fields jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open',
  winner text CHECK (winner IN ('internal', 'qbo')),
  raised_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS link_candidates_one_open ON link_candidates (doc_number) WHERE status = 'open';

-- The connected QBO company and its OAuth tokens (one row). A refresh replaces both tokens in one UPDATE.
CREATE TABLE IF NOT EXISTS qbo_connection (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  realm_id text NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz
);

-- OAuth state values issued by /admin/qbo/connect, each accepted once by the callback.
CREATE TABLE IF NOT EXISTS oauth_states (
  state text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Where the QBO change-data-capture poll got to (one row).
CREATE TABLE IF NOT EXISTS cdc_cursor (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cursor timestamptz NOT NULL
);

-- Idempotent changes to tables created by earlier versions of this file.
ALTER TABLE links ALTER COLUMN internal_id DROP NOT NULL;
-- The QBO requestid of a create in flight, kept on the pending Link so every retry reuses it.
ALTER TABLE links ADD COLUMN IF NOT EXISTS pending_request_id text;
-- Fences a claimed job: set at each claim, checked when the run settles it.
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
-- A Payment's Link points at its Invoice's Link: its lock, and where it must stay applied.
ALTER TABLE links ADD COLUMN IF NOT EXISTS parent_link_id integer REFERENCES links(id);
-- Notes a person may need, e.g. an edit discarded because a Void won.
ALTER TABLE sync_attempts ADD COLUMN IF NOT EXISTS notes jsonb NOT NULL DEFAULT '[]';
DO $$ BEGIN
  -- Rebuild the outcome CHECK only when it predates the current list (avoids a table scan on every start).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sync_attempts_outcome_check'
                 AND pg_get_constraintdef(oid) LIKE '%candidate%') THEN
    ALTER TABLE sync_attempts DROP CONSTRAINT IF EXISTS sync_attempts_outcome_check;
    ALTER TABLE sync_attempts ADD CONSTRAINT sync_attempts_outcome_check
      CHECK (outcome IN ('synced', 'skipped', 'attention', 'candidate', 'conflict', 'paused', 'failed'));
  END IF;
  -- 'closed': the pair was linked some other way (it became identical) before anyone confirmed it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'link_candidates_status_check'
                 AND pg_get_constraintdef(oid) LIKE '%closed%') THEN
    ALTER TABLE link_candidates DROP CONSTRAINT IF EXISTS link_candidates_status_check;
    ALTER TABLE link_candidates ADD CONSTRAINT link_candidates_status_check CHECK (status IN ('open', 'confirmed', 'closed'));
  END IF;
END $$;
