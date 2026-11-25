-- Migration 0002: Funções Geodésicas SIRGAS 2000 e Contador de Protocolo

-- 1. Determina dinamicamente o SRID UTM SIRGAS 2000 a partir do centroide
-- Hemisfério Norte: 11N..22N (31954 + zona -> 31965..31976)
-- Hemisfério Sul:   17S..25S (31960 + zona -> 31977..31985; ex: 20S RO = 31980)
CREATE OR REPLACE FUNCTION fn_get_sirgas_utm_srid(p_geom GEOMETRY)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  v_centroid GEOMETRY;
  v_lon DOUBLE PRECISION;
  v_lat DOUBLE PRECISION;
  v_utm_zone INTEGER;
  v_srid INTEGER;
BEGIN
  IF ST_SRID(p_geom) = 0 THEN
    RAISE EXCEPTION 'Geometria sem SRID definido. Esperado EPSG:4674.';
  END IF;

  v_centroid := ST_Centroid(ST_Transform(p_geom, 4674));
  v_lon := ST_X(v_centroid);
  v_lat := ST_Y(v_centroid);

  IF v_lon < -180.0 OR v_lon > 180.0 OR v_lat < -90.0 OR v_lat > 90.0 THEN
    RAISE EXCEPTION 'Coordenadas fora dos limites geográficos válidos (lon: %, lat: %).', v_lon, v_lat;
  END IF;

  v_utm_zone := FLOOR((v_lon + 180.0) / 6.0) + 1;

  IF v_lat >= 0 THEN
    IF v_utm_zone < 11 OR v_utm_zone > 22 THEN
      RAISE EXCEPTION 'Zona UTM Norte % fora da cobertura oficial SIRGAS 2000.', v_utm_zone;
    END IF;
    v_srid := 31954 + v_utm_zone;
  ELSE
    IF v_utm_zone < 17 OR v_utm_zone > 25 THEN
      RAISE EXCEPTION 'Zona UTM Sul % fora da cobertura oficial SIRGAS 2000.', v_utm_zone;
    END IF;
    v_srid := 31960 + v_utm_zone;
  END IF;

  RETURN v_srid;
END;
$$;

-- 2. Calcula a área oficial em hectares usando o fuso UTM SIRGAS 2000 da geometria
CREATE OR REPLACE FUNCTION fn_calc_area_ha_sirgas(p_geom GEOMETRY, p_forced_srid INTEGER DEFAULT NULL)
RETURNS NUMERIC(14, 4)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_srid INTEGER;
BEGIN
  IF p_geom IS NULL THEN
    RETURN NULL;
  END IF;
  v_srid := COALESCE(p_forced_srid, fn_get_sirgas_utm_srid(p_geom));
  RETURN ROUND((ST_Area(ST_Transform(p_geom, v_srid)) / 10000.0)::NUMERIC, 4);
END;
$$;

-- 3. Contador atômico anual para emissão de códigos de protocolo (ex: CI-2026-000001)
CREATE TABLE IF NOT EXISTS protocol_counters (
  year SMALLINT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
);

CREATE OR REPLACE FUNCTION fn_next_protocol_code(p_prefix TEXT DEFAULT 'CI')
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_year SMALLINT := EXTRACT(YEAR FROM NOW() AT TIME ZONE 'UTC')::SMALLINT;
  v_seq INTEGER;
BEGIN
  INSERT INTO protocol_counters (year, last_seq)
  VALUES (v_year, 1)
  ON CONFLICT (year)
  DO UPDATE SET last_seq = protocol_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  RETURN FORMAT('%s-%s-%s', p_prefix, v_year, LPAD(v_seq::TEXT, 6, '0'));
END;
$$;

-- 4. Função genérica para atualização automática de updated_at
CREATE OR REPLACE FUNCTION fn_trg_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
