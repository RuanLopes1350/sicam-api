-- Migration 0009: Trilha de Auditoria Append-Only
CREATE TABLE IF NOT EXISTS audit_logs (
  seq_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id  UUID REFERENCES users(id) ON DELETE RESTRICT,
  action         audit_action NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      UUID,
  ip_address     INET,
  user_agent     TEXT,
  correlation_id UUID NOT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
