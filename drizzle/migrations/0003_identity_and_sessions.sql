-- Migration 0003: Identidade e Controle de Sessões
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         TEXT NOT NULL CHECK (char_length(trim(full_name)) >= 3),
  registration_code TEXT NOT NULL UNIQUE CHECK (char_length(trim(registration_code)) >= 2),
  email             TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email))),
  password_hash     TEXT NOT NULL,
  role              user_role NOT NULL DEFAULT 'analyst',
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_set_updated_at();

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  family_id         UUID NOT NULL,
  token_hash        CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  replaced_by_id    UUID REFERENCES refresh_tokens(id),
  user_agent        TEXT,
  ip_address        INET,
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);
