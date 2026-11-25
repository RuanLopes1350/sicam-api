import { z } from 'zod';
import { runStatusEnum } from '../../config/db/schema/enums.js';

export const GeoJsonPointTupleSchema = z.tuple([z.number().finite(), z.number().finite()]);

export const AoiPolygonGeoJsonSchema = z
	.object({
		type: z.literal('Polygon'),
		coordinates: z.array(z.array(GeoJsonPointTupleSchema)),
	})
	.strict();

export const CreateCaseBodySchema = z
	.object({
		title: z.string().trim().min(3).max(200),
		externalRef: z.string().trim().min(1).max(100).nullable().optional(),
		description: z.string().trim().max(2000).nullable().optional(),
		aoiGeoJson: AoiPolygonGeoJsonSchema,
	})
	.strict();

export const CaseIdParamsSchema = z
	.object({
		caseId: z.string().uuid(),
	})
	.strict();

// OpenAPI Seção 3 (Módulo 4): PATCH aceita exclusivamente metadados textuais (AOI e protocolo são imutáveis)
export const UpdateCaseBodySchema = z
	.object({
		title: z.string().trim().min(3).max(200).optional(),
		externalRef: z.string().trim().min(1).max(100).nullable().optional(),
		description: z.string().trim().max(2000).nullable().optional(),
	})
	.strict()
	.refine((obj) => Object.keys(obj).length > 0, {
		message: 'Informe ao menos um campo textual para atualização (title, externalRef ou description).',
	});

export const ListCasesQuerySchema = z
	.object({
		q: z.string().trim().min(1).max(120).optional(),
		stateUf: z
			.string()
			.trim()
			.toUpperCase()
			.regex(/^[A-Z]{2}$/)
			.optional(),
		municipalityIbge: z
			.string()
			.trim()
			.regex(/^[0-9]{7}$/)
			.optional(),
		bbox: z.string().trim().min(7).max(120).optional(),
		status: z.union([z.enum(runStatusEnum.enumValues), z.literal('no_runs')]).optional(),
		createdBy: z.string().uuid().optional(),
		from: z.string().datetime().optional(),
		to: z.string().datetime().optional(),
		page: z.coerce.number().int().min(1).default(1),
		limit: z.coerce.number().int().min(1).max(100).default(20),
	})
	.strict();

export const PrimaryMunicipalitySchema = z
	.object({
		ibgeCode: z.string().length(7),
		name: z.string(),
		ufCode: z.string().length(2),
	})
	.strict();

export const IntersectedMunicipalitySchema = z
	.object({
		ibgeCode: z.string().length(7),
		name: z.string(),
		ufCode: z.string().length(2),
		overlapHa: z.number(),
		overlapPct: z.number(),
	})
	.strict();

export const CaseOperatorSummarySchema = z
	.object({
		id: z.string().uuid(),
		fullName: z.string(),
		registrationCode: z.string(),
	})
	.strict();

export const CaseRecordSchema = z
	.object({
		id: z.string().uuid(),
		protocolCode: z.string(),
		externalRef: z.string().nullable(),
		title: z.string(),
		description: z.string().nullable(),
		aoiAreaHa: z.number(),
		aoiPerimeterM: z.number(),
		utmSrid: z.number().int(),
		stateUf: z.string().length(2).nullable(),
		primaryMunicipality: PrimaryMunicipalitySchema.nullable(),
		intersectedMunicipalities: z.array(IntersectedMunicipalitySchema),
		aoiGeoJson: AoiPolygonGeoJsonSchema,
		createdBy: CaseOperatorSummarySchema,
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.strict();

export const CaseListItemSchema = CaseRecordSchema.extend({
	runsCount: z.number().int(),
	latestRunStatus: z.enum(runStatusEnum.enumValues).nullable(),
}).strict();

export const ListCasesResponseSchema = z
	.object({
		items: z.array(CaseListItemSchema),
		pagination: z
			.object({
				page: z.number().int(),
				limit: z.number().int(),
				total: z.number().int(),
				totalPages: z.number().int(),
			})
			.strict(),
	})
	.strict();

export const CaseRunSummarySchema = z
	.object({
		id: z.string().uuid(),
		version: z.number().int(),
		status: z.enum(runStatusEnum.enumValues),
		presetName: z.string(),
		isCustomParams: z.boolean(),
		seasonalityWarning: z.boolean(),
		t0AcquiredAt: z.string().datetime(),
		t1AcquiredAt: z.string().datetime(),
		deforestationHa: z.number().nullable(),
		degradationHa: z.number().nullable(),
		regrowthHa: z.number().nullable(),
		cloudMaskedHa: z.number().nullable(),
		queuedAt: z.string().datetime(),
		finishedAt: z.string().datetime().nullable(),
	})
	.strict();

export const CaseDetailResponseSchema = CaseRecordSchema.extend({
	runs: z.array(CaseRunSummarySchema),
}).strict();

export type AoiPolygonGeoJson = z.infer<typeof AoiPolygonGeoJsonSchema>;
export type CreateCaseBody = z.infer<typeof CreateCaseBodySchema>;
export type UpdateCaseBody = z.infer<typeof UpdateCaseBodySchema>;
export type ListCasesQuery = z.infer<typeof ListCasesQuerySchema>;
