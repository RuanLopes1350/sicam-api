import { sql } from 'drizzle-orm';
import {
	char,
	integer,
	jsonb,
	numeric,
	pgTable,
	smallint,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core';
import { geometryPolygon4674 } from '../customTypes.js';
import { ibgeMunicipalities } from './territories.js';
import { users } from './users.js';

export interface IntersectedMunicipalityInfo {
	ibgeCode: string;
	name: string;
	ufCode: string;
	overlapHa: number;
	overlapPct: number;
}

export const protocolCounters = pgTable('protocol_counters', {
	year: smallint('year').primaryKey(),
	lastSeq: integer('last_seq').notNull().default(0),
});

export const analysisCases = pgTable('analysis_cases', {
	id: uuid('id').primaryKey().defaultRandom(),
	protocolCode: text('protocol_code')
		.notNull()
		.unique()
		.default(sql`fn_next_protocol_code('CI')`),
	externalRef: text('external_ref'),
	title: text('title').notNull(),
	description: text('description'),
	primaryMunicipalityIbge: char('primary_municipality_ibge', { length: 7 }).references(
		() => ibgeMunicipalities.ibgeCode,
	),
	primaryMunicipalityName: text('primary_municipality_name'),
	stateUf: char('state_uf', { length: 2 }),
	intersectedMunicipalities: jsonb('intersected_municipalities')
		.$type<IntersectedMunicipalityInfo[]>()
		.notNull()
		.default([]),
	aoiGeom: geometryPolygon4674('aoi_geom').notNull(),
	aoiAreaHa: numeric('aoi_area_ha', { precision: 14, scale: 4 }).notNull(),
	aoiPerimeterM: numeric('aoi_perimeter_m', { precision: 14, scale: 2 }).notNull(),
	utmSrid: integer('utm_srid').notNull(),
	createdBy: uuid('created_by')
		.notNull()
		.references(() => users.id, { onDelete: 'restrict' }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
