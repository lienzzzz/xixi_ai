-- Invalidate working context without rewriting raw audit events.
CREATE TABLE context_history_cutoffs (
  session_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  reason_code TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
