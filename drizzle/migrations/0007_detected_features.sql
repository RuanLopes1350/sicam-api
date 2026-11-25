-- Migration 0007: Polígonos Vetorizados e Curadoria
CREATE TABLE IF NOT EXISTS detected_features (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE RESTRICT,
  feature_sequence  INTEGER NOT NULL CHECK (feature_sequence >= 1),
  feature_class     feature_class NOT NULL,
  geom              GEOMETRY(Polygon, 4674) NOT NULL CHECK (ST_IsValid(geom)),
  area_ha           NUMERIC(14, 4) NOT NULL CHECK (area_ha > 0),
  pixel_count       INTEGER NOT NULL CHECK (pixel_count >= 1),
  mean_ndvi_t0      NUMERIC(6, 4) NOT NULL CHECK (mean_ndvi_t0 BETWEEN -1 AND 1),
  mean_ndvi_t1      NUMERIC(6, 4) NOT NULL CHECK (mean_ndvi_t1 BETWEEN -1 AND 1),
  mean_delta_ndvi   NUMERIC(6, 4) NOT NULL CHECK (mean_delta_ndvi BETWEEN -2 AND 2),
  centroid_lat      NUMERIC(10, 7) NOT NULL CHECK (centroid_lat BETWEEN -90 AND 90),
  centroid_lon      NUMERIC(10, 7) NOT NULL CHECK (centroid_lon BETWEEN -180 AND 180),
  centroid_utm_e    NUMERIC(12, 2) NOT NULL,
  centroid_utm_n    NUMERIC(12, 2) NOT NULL,
  review_status     review_status NOT NULL DEFAULT 'auto_detected',
  dismissal_reason  TEXT,
  reviewed_by       UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, feature_sequence),
  CHECK (
    (review_status <> 'dismissed_noise')
    OR (dismissal_reason IS NOT NULL AND char_length(trim(dismissal_reason)) >= 15 AND reviewed_by IS NOT NULL)
  )
);
