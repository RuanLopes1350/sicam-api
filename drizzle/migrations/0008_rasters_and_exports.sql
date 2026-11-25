-- Migration 0008: Evidências Rasters e Pacote Técnico Congelado
CREATE TABLE IF NOT EXISTS raster_assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE RESTRICT,
  asset_type        raster_type NOT NULL,
  storage_bucket    TEXT NOT NULL,
  storage_key       TEXT NOT NULL UNIQUE,
  mime_type         TEXT NOT NULL DEFAULT 'image/png',
  size_bytes        BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256            CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  width_px          INTEGER NOT NULL CHECK (width_px > 0),
  height_px         INTEGER NOT NULL CHECK (height_px > 0),
  bounds_4674       JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, asset_type)
);

CREATE TABLE IF NOT EXISTS export_packages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                UUID NOT NULL UNIQUE REFERENCES analysis_runs(id) ON DELETE RESTRICT,
  paper_format          paper_format NOT NULL DEFAULT 'A3',
  cartographic_scale    INTEGER NOT NULL CHECK (cartographic_scale > 0),
  observations          TEXT,
  storage_bucket        TEXT NOT NULL,
  pdf_storage_key       TEXT NOT NULL UNIQUE,
  pdf_size_bytes        BIGINT NOT NULL CHECK (pdf_size_bytes > 0),
  pdf_sha256            CHAR(64) NOT NULL UNIQUE CHECK (pdf_sha256 ~ '^[a-f0-9]{64}$'),
  zip_storage_key       TEXT NOT NULL UNIQUE,
  zip_size_bytes        BIGINT NOT NULL CHECK (zip_size_bytes > 0),
  zip_sha256            CHAR(64) NOT NULL UNIQUE CHECK (zip_sha256 ~ '^[a-f0-9]{64}$'),
  audit_manifest        JSONB NOT NULL,
  generated_by          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
