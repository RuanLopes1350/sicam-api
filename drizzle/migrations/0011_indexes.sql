-- Migration 0011: Estratégia de Índices (GiST, Parciais e B-Tree)

-- Índices Espaciais (GiST)
CREATE INDEX IF NOT EXISTS idx_ibge_states_geom          ON ibge_states USING GIST (geom_4674);
CREATE INDEX IF NOT EXISTS idx_ibge_municipalities_geom  ON ibge_municipalities USING GIST (geom_4674);
CREATE INDEX IF NOT EXISTS idx_analysis_cases_aoi_geom   ON analysis_cases USING GIST (aoi_geom);
CREATE INDEX IF NOT EXISTS idx_detected_features_geom    ON detected_features USING GIST (geom);

-- Malha IBGE
CREATE INDEX IF NOT EXISTS idx_ibge_municipalities_uf    ON ibge_municipalities (uf_code);

-- Sessões e Autenticação
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user       ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family     ON refresh_tokens (family_id);

-- Consultas Operacionais de Casos e Execuções
CREATE INDEX IF NOT EXISTS idx_analysis_cases_created_at ON analysis_cases (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_cases_uf_mun     ON analysis_cases (state_uf, primary_municipality_ibge);
CREATE INDEX IF NOT EXISTS idx_analysis_cases_created_by ON analysis_cases (created_by);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_case_ver    ON analysis_runs (case_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_active_user ON analysis_runs (executed_by)
  WHERE status IN ('queued', 'fetching_bands', 'processing_ndvi', 'vectorizing', 'exporting');

-- Polígonos Detectados
CREATE INDEX IF NOT EXISTS idx_detected_features_run_area
  ON detected_features (run_id, review_status, area_ha DESC);

-- Auditoria
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity         ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor          ON audit_logs (actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation    ON audit_logs (correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at    ON audit_logs (occurred_at DESC);
