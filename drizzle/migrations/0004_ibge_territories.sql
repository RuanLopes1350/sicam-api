-- Migration 0004: Malha Geográfica Incremental do IBGE
CREATE TABLE IF NOT EXISTS ibge_states (
  uf_code              CHAR(2) PRIMARY KEY CHECK (uf_code ~ '^[A-Z]{2}$'),
  ibge_state_id        SMALLINT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  geom_4674            GEOMETRY(MultiPolygon, 4674) NOT NULL CHECK (ST_IsValid(geom_4674)),
  geom_simplified_4674 GEOMETRY(MultiPolygon, 4674) NOT NULL CHECK (ST_IsValid(geom_simplified_4674)),
  dataset_version      TEXT NOT NULL,
  imported_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ibge_municipalities (
  ibge_code            CHAR(7) PRIMARY KEY CHECK (ibge_code ~ '^[0-9]{7}$'),
  uf_code              CHAR(2) NOT NULL REFERENCES ibge_states(uf_code) ON DELETE RESTRICT,
  name                 TEXT NOT NULL,
  geom_4674            GEOMETRY(MultiPolygon, 4674) NOT NULL CHECK (ST_IsValid(geom_4674)),
  geom_simplified_4674 GEOMETRY(MultiPolygon, 4674) NOT NULL CHECK (ST_IsValid(geom_simplified_4674)),
  dataset_version      TEXT NOT NULL,
  imported_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
