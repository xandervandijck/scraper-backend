-- Migration 002: Use-case support
-- Run: node migrations/run.js (idempotent — safe to re-run)

ALTER TABLE lead_lists
  ADD COLUMN IF NOT EXISTS use_case TEXT NOT NULL DEFAULT 'erp';

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS use_case      TEXT NOT NULL DEFAULT 'erp',
  ADD COLUMN IF NOT EXISTS analysis_data JSONB;

CREATE INDEX IF NOT EXISTS idx_leads_use_case ON leads(use_case);

-- Constraint: only valid use cases allowed
DO $$ BEGIN
  ALTER TABLE lead_lists
    ADD CONSTRAINT lead_lists_use_case_check
    CHECK (use_case IN ('erp','recruitment'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE leads
    ADD CONSTRAINT leads_use_case_check
    CHECK (use_case IN ('erp','recruitment'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
