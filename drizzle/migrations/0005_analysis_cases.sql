-- Migration 0005: Casos de Análise e Área de Interesse (AOI)
CREATE TABLE IF NOT EXISTS analysis_cases (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_code              TEXT NOT NULL UNIQUE DEFAULT fn_next_protocol_code('CI'),
  external_ref               TEXT,
  title                      TEXT NOT NULL CHECK (char_length(trim(title)) >= 3),
  description                TEXT,
  primary_municipality_ibge  CHAR(7) REFERENCES ibge_municipalities(ibge_code),
  primary_municipality_name  TEXT,
  state_uf                   CHAR(2) CHECK (state_uf IS NULL OR state_uf ~ '^[A-Z]{2}$'),
  intersected_municipalities JSONB NOT NULL DEFAULT '[]'::JSONB
                             CHECK (jsonb_typeof(intersected_municipalities) = 'array'),
  aoi_geom                   GEOMETRY(Polygon, 4674) NOT NULL
                             CHECK (ST_IsValid(aoi_geom) AND ST_NRings(aoi_geom) = 1),
  aoi_area_ha                NUMERIC(14, 4) NOT NULL CHECK (aoi_area_ha > 0),
  aoi_perimeter_m            NUMERIC(14, 2) NOT NULL CHECK (aoi_perimeter_m > 0),
  utm_srid                   INTEGER NOT NULL CHECK (utm_srid BETWEEN 31965 AND 31985),
  created_by                 UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_analysis_cases_updated_at ON analysis_cases;
CREATE TRIGGER trg_analysis_cases_updated_at
  BEFORE UPDATE ON analysis_cases
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_set_updated_at();
