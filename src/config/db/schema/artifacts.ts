import {
	bigint,
	char,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from 'drizzle-orm/pg-core';
import { paperFormatEnum, rasterTypeEnum } from './enums.js';
import { analysisRuns } from './runs.js';
import { users } from './users.js';

export const rasterAssets = pgTable(
	'raster_assets',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		runId: uuid('run_id')
			.notNull()
			.references(() => analysisRuns.id, { onDelete: 'restrict' }),
		assetType: rasterTypeEnum('asset_type').notNull(),
		storageBucket: text('storage_bucket').notNull(),
		storageKey: text('storage_key').notNull().unique(),
		mimeType: text('mime_type').notNull().default('image/png'),
		sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
		sha256: char('sha256', { length: 64 }).notNull(),
		widthPx: integer('width_px').notNull(),
		heightPx: integer('height_px').notNull(),
		bounds4674: jsonb('bounds_4674').$type<[number, number, number, number]>().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [unique('raster_assets_run_id_asset_type_key').on(t.runId, t.assetType)],
);

export const exportPackages = pgTable('export_packages', {
	id: uuid('id').primaryKey().defaultRandom(),
	runId: uuid('run_id')
		.notNull()
		.unique()
		.references(() => analysisRuns.id, { onDelete: 'restrict' }),
	paperFormat: paperFormatEnum('paper_format').notNull().default('A3'),
	cartographicScale: integer('cartographic_scale').notNull(),
	observations: text('observations'),
	storageBucket: text('storage_bucket').notNull(),
	pdfStorageKey: text('pdf_storage_key').notNull().unique(),
	pdfSizeBytes: bigint('pdf_size_bytes', { mode: 'number' }).notNull(),
	pdfSha256: char('pdf_sha256', { length: 64 }).notNull().unique(),
	zipStorageKey: text('zip_storage_key').notNull().unique(),
	zipSizeBytes: bigint('zip_size_bytes', { mode: 'number' }).notNull(),
	zipSha256: char('zip_sha256', { length: 64 }).notNull().unique(),
	auditManifest: jsonb('audit_manifest').$type<Record<string, unknown>>().notNull(),
	generatedBy: uuid('generated_by')
		.notNull()
		.references(() => users.id, { onDelete: 'restrict' }),
	generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});
