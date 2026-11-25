import { char, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';
import { geometryMultiPolygon4674 } from '../customTypes.js';

export const ibgeStates = pgTable('ibge_states', {
	ufCode: char('uf_code', { length: 2 }).primaryKey(),
	ibgeStateId: smallint('ibge_state_id').notNull().unique(),
	name: text('name').notNull(),
	geom4674: geometryMultiPolygon4674('geom_4674').notNull(),
	geomSimplified4674: geometryMultiPolygon4674('geom_simplified_4674').notNull(),
	datasetVersion: text('dataset_version').notNull(),
	importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ibgeMunicipalities = pgTable('ibge_municipalities', {
	ibgeCode: char('ibge_code', { length: 7 }).primaryKey(),
	ufCode: char('uf_code', { length: 2 })
		.notNull()
		.references(() => ibgeStates.ufCode, { onDelete: 'restrict' }),
	name: text('name').notNull(),
	geom4674: geometryMultiPolygon4674('geom_4674').notNull(),
	geomSimplified4674: geometryMultiPolygon4674('geom_simplified_4674').notNull(),
	datasetVersion: text('dataset_version').notNull(),
	importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
});
