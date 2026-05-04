-- ============================================================
-- Migration: Data Retention Policy v1
-- Adds superadmin override columns to audit_log.
-- Run once against the live database.
-- ============================================================

-- 1. Extend audit_log with override tracking columns
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS old_value         JSONB,
  ADD COLUMN IF NOT EXISTS new_value         JSONB,
  ADD COLUMN IF NOT EXISTS superadmin_override BOOLEAN NOT NULL DEFAULT false;

-- 2. Fast lookup for compliance reports (only indexes true rows)
CREATE INDEX IF NOT EXISTS idx_audit_superadmin_override
  ON audit_log(superadmin_override)
  WHERE superadmin_override = true;

CREATE INDEX IF NOT EXISTS idx_audit_created_at
  ON audit_log(created_at DESC);
