-- Migration 0001: Extensões e Tipos ENUM
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Perfis RBAC com segregação de funções
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'analyst', 'auditor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Provedores STAC oficiais na whitelist Anti-SSRF
DO $$ BEGIN
  CREATE TYPE stac_provider AS ENUM ('aws_earth_search', 'inpe_bdc');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Máquina de estados de uma execução analítica
DO $$ BEGIN
  CREATE TYPE run_status AS ENUM (
    'queued',
    'fetching_bands',
    'processing_ndvi',
    'vectorizing',
    'ready_for_review',
    'exporting',
    'frozen',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Classes temáticas detectadas pelo motor Delta-NDVI
DO $$ BEGIN
  CREATE TYPE feature_class AS ENUM ('deforestation', 'degradation', 'regrowth');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ciclo de revisão auditável de cada polígono
DO $$ BEGIN
  CREATE TYPE review_status AS ENUM ('auto_detected', 'confirmed', 'dismissed_noise');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tipos de imagens geradas como evidência visual no S3
DO $$ BEGIN
  CREATE TYPE raster_type AS ENUM (
    't0_rgb',
    't1_rgb',
    't0_false_color',
    't1_false_color',
    'delta_ndvi_mask'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Formatos físicos homologados de impressão cartográfica
DO $$ BEGIN
  CREATE TYPE paper_format AS ENUM ('A4', 'A3');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Catálogo fechado de eventos de auditoria (append-only)
DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM (
    'auth_login_success',
    'auth_login_failed',
    'auth_token_revoked',
    'auth_token_reuse_detected',
    'user_created',
    'user_updated',
    'user_deactivated',
    'ibge_state_imported',
    'case_created',
    'run_created',
    'run_completed',
    'run_failed',
    'feature_reviewed',
    'export_requested',
    'export_generated',
    'export_downloaded',
    'integrity_verified'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
