-- ERP Lead Engine — Initial Schema
-- Run via: node migrations/run.js

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Workspaces ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);

-- ── Lead Lists ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_lists (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  target_leads INTEGER DEFAULT 100,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lists_workspace_id ON lead_lists(workspace_id);

-- ── Leads ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id                  UUID NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  company_name             TEXT,
  domain                   TEXT NOT NULL,
  website                  TEXT,
  email                    TEXT,
  email_valid              BOOLEAN,
  email_validation_score   INTEGER,
  email_validation_reason  TEXT,
  erp_score                INTEGER,
  erp_breakdown            JSONB,
  sector                   TEXT,
  country                  TEXT,
  phone                    TEXT,
  address                  TEXT,
  description              TEXT,
  source                   TEXT DEFAULT 'puppeteer',
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

-- Deduplication: one domain per workspace
CREATE UNIQUE INDEX IF NOT EXISTS unique_workspace_domain ON leads(workspace_id, domain);

CREATE INDEX IF NOT EXISTS idx_leads_workspace_id ON leads(workspace_id);
CREATE INDEX IF NOT EXISTS idx_leads_list_id      ON leads(list_id);
CREATE INDEX IF NOT EXISTS idx_leads_domain       ON leads(domain);
CREATE INDEX IF NOT EXISTS idx_leads_erp_score    ON leads(erp_score DESC);

-- ── Scrape Sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scrape_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id             UUID NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','done','stopped','error')),
  config              JSONB,
  queries_used        JSONB,
  leads_found         INTEGER DEFAULT 0,
  duplicates_skipped  INTEGER DEFAULT 0,
  errors_count        INTEGER DEFAULT 0,
  started_at          TIMESTAMPTZ DEFAULT NOW(),
  finished_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON scrape_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_list_id      ON scrape_sessions(list_id);
