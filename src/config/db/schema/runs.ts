import {
	boolean,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from 'drizzle-orm/pg-core';
import type { AlgorithmParams } from '../../presets.js';
import { analysisCases } from './cases.js';
import { runStatusEnum, stacProviderEnum } from './enums.js';
import { users } from './users.js';

export const analysisRuns = pgTable(
	'analysis_runs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		caseId: uuid('case_id')
			.notNull()
			.references(() => analysisCases.id, { onDelete: 'restrict' }),
		version: integer('version').notNull(),
		status: runStatusEnum('status').notNull().default('queued'),
		t0Provider: stacProviderEnum('t0_provider').notNull(),
		t0Collection: text('t0_collection').notNull(),
		t0ItemIds: text('t0_item_ids').array().notNull(),
		t0AcquiredAt: timestamp('t0_acquired_at', { withTimezone: true }).notNull(),
		t0CloudPctAoi: numeric('t0_cloud_pct_aoi', { precision: 5, scale: 2 }).notNull(),
		t0StacMetadata: jsonb('t0_stac_metadata').$type<Record<string, unknown>>().notNull(),
		t1Provider: stacProviderEnum('t1_provider').notNull(),
		t1Collection: text('t1_collection').notNull(),
		t1ItemIds: text('t1_item_ids').array().notNull(),
		t1AcquiredAt: timestamp('t1_acquired_at', { withTimezone: true }).notNull(),
		t1CloudPctAoi: numeric('t1_cloud_pct_aoi', { precision: 5, scale: 2 }).notNull(),
		t1StacMetadata: jsonb('t1_stac_metadata').$type<Record<string, unknown>>().notNull(),
		seasonalityWarning: boolean('seasonality_warning').notNull().default(false),
		presetName: text('preset_name').notNull(),
		isCustomParams: boolean('is_custom_params').notNull().default(false),
		algorithmParams: jsonb('algorithm_params').$type<AlgorithmParams>().notNull(),
		engineVersion: text('engine_version').notNull(),
		validAnalyzedHa: numeric('valid_analyzed_ha', { precision: 14, scale: 4 }),
		cloudMaskedHa: numeric('cloud_masked_ha', { precision: 14, scale: 4 }),
		deforestationHa: numeric('deforestation_ha', { precision: 14, scale: 4 }),
		degradationHa: numeric('degradation_ha', { precision: 14, scale: 4 }),
		regrowthHa: numeric('regrowth_ha', { precision: 14, scale: 4 }),
		stableHa: numeric('stable_ha', { precision: 14, scale: 4 }),
		bullmqJobId: text('bullmq_job_id'),
		errorCode: text('error_code'),
		errorDetail: text('error_detail'),
		executedBy: uuid('executed_by')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
		startedAt: timestamp('started_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
	},
	(t) => [unique('analysis_runs_case_id_version_key').on(t.caseId, t.version)],
);
