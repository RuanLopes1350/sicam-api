-- Migration 0010: Triggers de Imutabilidade, Validação Geodésica e Cadeia de Custódia

CREATE OR REPLACE FUNCTION fn_trg_prevent_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Violação de imutabilidade: operação % bloqueada na tabela %.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_prevent_mutation();

DROP TRIGGER IF EXISTS trg_export_packages_immutable ON export_packages;
CREATE TRIGGER trg_export_packages_immutable
  BEFORE UPDATE OR DELETE ON export_packages
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_prevent_mutation();

CREATE OR REPLACE FUNCTION fn_trg_analysis_cases_geo_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT ST_Equals(OLD.aoi_geom, NEW.aoi_geom) THEN
      RAISE EXCEPTION 'A geometria da AOI de um caso criado é imutável. Crie um novo caso para outra área.'
        USING ERRCODE = '22023';
    END IF;
    NEW.utm_srid := OLD.utm_srid;
    NEW.aoi_area_ha := OLD.aoi_area_ha;
    NEW.aoi_perimeter_m := OLD.aoi_perimeter_m;
    NEW.protocol_code := OLD.protocol_code;
    RETURN NEW;
  END IF;

  NEW.utm_srid := fn_get_sirgas_utm_srid(NEW.aoi_geom);
  NEW.aoi_area_ha := fn_calc_area_ha_sirgas(NEW.aoi_geom, NEW.utm_srid);
  NEW.aoi_perimeter_m := ROUND(ST_Perimeter(ST_Transform(NEW.aoi_geom, NEW.utm_srid))::NUMERIC, 2);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analysis_cases_geo_guard ON analysis_cases;
CREATE TRIGGER trg_analysis_cases_geo_guard
  BEFORE INSERT OR UPDATE ON analysis_cases
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_analysis_cases_geo_guard();

CREATE OR REPLACE FUNCTION fn_trg_analysis_runs_freeze_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Execuções analíticas (analysis_runs) não podem ser excluídas.'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'frozen' THEN
    RAISE EXCEPTION 'A execução % está em estado FROZEN e é permanentemente imutável.', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'failed' THEN
    RAISE EXCEPTION 'A execução % falhou e é terminal. Crie uma nova versão (v+1).', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.t0_item_ids IS DISTINCT FROM OLD.t0_item_ids
     OR NEW.t1_item_ids IS DISTINCT FROM OLD.t1_item_ids
     OR NEW.algorithm_params IS DISTINCT FROM OLD.algorithm_params THEN
    RAISE EXCEPTION 'Proveniência de cenas e parâmetros do algoritmo são imutáveis após criação da execução.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analysis_runs_freeze_guard ON analysis_runs;
CREATE TRIGGER trg_analysis_runs_freeze_guard
  BEFORE UPDATE OR DELETE ON analysis_runs
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_analysis_runs_freeze_guard();

CREATE OR REPLACE FUNCTION fn_trg_detected_features_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_run_status run_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Feições detectadas nunca podem ser removidas. Utilize review_status = dismissed_noise.'
      USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_run_status
  FROM analysis_runs
  WHERE id = COALESCE(NEW.run_id, OLD.run_id);

  IF TG_OP = 'INSERT' AND v_run_status NOT IN ('vectorizing', 'processing_ndvi') THEN
    RAISE EXCEPTION 'Feições só podem ser inseridas enquanto a execução está em processamento (status atual: %).', v_run_status
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF v_run_status <> 'ready_for_review' THEN
      RAISE EXCEPTION 'Revisão bloqueada: a execução encontra-se em estado %.', v_run_status
        USING ERRCODE = '42501';
    END IF;
    IF NOT ST_Equals(OLD.geom, NEW.geom)
       OR OLD.area_ha <> NEW.area_ha
       OR OLD.feature_class <> NEW.feature_class
       OR OLD.mean_delta_ndvi <> NEW.mean_delta_ndvi THEN
      RAISE EXCEPTION 'Geometria, classe e métricas espectrais de feições detectadas são imutáveis.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_detected_features_guard ON detected_features;
CREATE TRIGGER trg_detected_features_guard
  BEFORE INSERT OR UPDATE OR DELETE ON detected_features
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_detected_features_guard();

CREATE OR REPLACE FUNCTION fn_trg_raster_assets_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_run_status run_status;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Evidências raster (raster_assets) são imutáveis após gravação.'
      USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_run_status FROM analysis_runs WHERE id = NEW.run_id;
  IF v_run_status = 'frozen' THEN
    RAISE EXCEPTION 'Não é possível adicionar rasters a uma execução já congelada.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_raster_assets_guard ON raster_assets;
CREATE TRIGGER trg_raster_assets_guard
  BEFORE INSERT OR UPDATE OR DELETE ON raster_assets
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_raster_assets_guard();
