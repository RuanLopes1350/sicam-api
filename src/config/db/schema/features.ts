import {
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from 'drizzle-orm/pg-core';
import { geometryPolygon4674 } from '../customTypes.js';
import { featureClassEnum, reviewStatusEnum } from './enums.js';
import { analysisRuns } from './runs.js';
import { users } from './users.js';

export const detectedFeatures = pgTable(
	'detected_features',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		runId: uuid('run_id')
			.notNull()
			.references(() => analysisRuns.id, { onDelete: 'restrict' }),
		featureSequence: integer('feature_sequence').notNull(),
		featureClass: featureClassEnum('feature_class').notNull(),
		geom: geometryPolygon4674('geom').notNull(),
		areaHa: numeric('area_ha', { precision: 14, scale: 4 }).notNull(),
		pixelCount: integer('pixel_count').notNull(),
		meanNdviT0: numeric('mean_ndvi_t0', { precision: 6, scale: 4 }).notNull(),
		meanNdviT1: numeric('mean_ndvi_t1', { precision: 6, scale: 4 }).notNull(),
		meanDeltaNdvi: numeric('mean_delta_ndvi', { precision: 6, scale: 4 }).notNull(),
		centroidLat: numeric('centroid_lat', { precision: 10, scale: 7 }).notNull(),
		centroidLon: numeric('centroid_lon', { precision: 10, scale: 7 }).notNull(),
		centroidUtmE: numeric('centroid_utm_e', { precision: 12, scale: 2 }).notNull(),
		centroidUtmN: numeric('centroid_utm_n', { precision: 12, scale: 2 }).notNull(),
		reviewStatus: reviewStatusEnum('review_status').notNull().default('auto_detected'),
		dismissalReason: text('dismissal_reason'),
		reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'restrict' }),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [unique('detected_features_run_id_feature_sequence_key').on(t.runId, t.featureSequence)],
);
