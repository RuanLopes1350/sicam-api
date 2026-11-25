-- Migration 0012: Segregação de Privilégios (Least Privilege para app_runtime)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO app_runtime;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

    -- Tabelas estritamente append-only (sem UPDATE, sem DELETE)
    REVOKE ALL ON audit_logs, export_packages, raster_assets FROM app_runtime;
    GRANT SELECT, INSERT ON audit_logs, export_packages, raster_assets TO app_runtime;

    -- Tabelas operacionais auditáveis (sem DELETE, sem TRUNCATE)
    REVOKE ALL ON
      protocol_counters,
      users,
      refresh_tokens,
      ibge_states,
      ibge_municipalities,
      analysis_cases,
      analysis_runs,
      detected_features
    FROM app_runtime;

    GRANT SELECT, INSERT, UPDATE ON
      protocol_counters,
      users,
      refresh_tokens,
      ibge_states,
      ibge_municipalities,
      analysis_cases,
      analysis_runs,
      detected_features
    TO app_runtime;
  END IF;
END
$$;
