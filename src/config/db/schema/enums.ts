import { pgEnum } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['admin', 'analyst', 'auditor']);

export const stacProviderEnum = pgEnum('stac_provider', ['aws_earth_search', 'inpe_bdc']);

export const runStatusEnum = pgEnum('run_status', [
	'queued',
	'fetching_bands',
	'processing_ndvi',
	'vectorizing',
	'ready_for_review',
	'exporting',
	'frozen',
	'failed',
]);

export const featureClassEnum = pgEnum('feature_class', [
	'deforestation',
	'degradation',
	'regrowth',
]);

export const reviewStatusEnum = pgEnum('review_status', [
	'auto_detected',
	'confirmed',
	'dismissed_noise',
]);

export const rasterTypeEnum = pgEnum('raster_type', [
	't0_rgb',
	't1_rgb',
	't0_false_color',
	't1_false_color',
	'delta_ndvi_mask',
]);

export const paperFormatEnum = pgEnum('paper_format', ['A4', 'A3']);

export const auditActionEnum = pgEnum('audit_action', [
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
	'integrity_verified',
]);

export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type StacProvider = (typeof stacProviderEnum.enumValues)[number];
export type RunStatus = (typeof runStatusEnum.enumValues)[number];
export type FeatureClass = (typeof featureClassEnum.enumValues)[number];
export type ReviewStatus = (typeof reviewStatusEnum.enumValues)[number];
export type RasterType = (typeof rasterTypeEnum.enumValues)[number];
export type PaperFormat = (typeof paperFormatEnum.enumValues)[number];
export type AuditAction = (typeof auditActionEnum.enumValues)[number];
