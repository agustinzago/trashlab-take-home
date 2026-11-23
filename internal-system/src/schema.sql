CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY,
  display_name text NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  doc_number text NOT NULL UNIQUE,
  customer_id integer NOT NULL REFERENCES customers(id),
  txn_date date NOT NULL,
  due_date date,
  memo text,
  lines jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'voided')),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id serial PRIMARY KEY,
  ref text NOT NULL UNIQUE,
  invoice_id integer NOT NULL REFERENCES invoices(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  txn_date date NOT NULL,
  method text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_invoice_id ON payments (invoice_id);

-- One row per (endpoint, Idempotency-Key); holds the original response to replay.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  body jsonb,
  PRIMARY KEY (scope, key)
);

-- Transactional outbox: written in the same transaction as every change.
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  record_type text NOT NULL,
  record_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (next_attempt_at) WHERE delivered_at IS NULL;
