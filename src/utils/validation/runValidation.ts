import { z } from 'zod';
import {
	featureClassEnum,
	rasterTypeEnum,
	reviewStatusEnum,
	runStatusEnum,
	stacProviderEnum,
} from '../../config/db/schema/enums.js';
import { CustomAlgorithmParamsSchema } from '../geo/core/ndviClassifier.js';
import { CaseOperatorSummarySchema, GeoJsonPointTupleSchema } from './caseValidation.js';

export const RunIdParamsSchema = z
	.object({
		runId: z.string().uuid(),
	})
	.strict();

export const RunFeatureParamsSchema = z
	.object({
		runId: z.string().uuid(),
		featureId: z.string().uuid(),
	})
	.strict();

export const RunRasterParamsSchema = z
	.object({
		runId: z.string().uuid(),
		assetType: z.enum(rasterTypeEnum.enumValues),
	})
	.strict();

// Cabeçalho padrão OpenAPI (Fastify normaliza nomes de headers para lowercase)
export const CreateRunHeadersSchema = z.object({
	'idempotency-key': z.string().uuid(),
});

// Zero Trust (OpenAPI Seção 4.1): proíbe ?token=... ou parâmetros extras na query string do SSE
export const RunEventsQuerySchema = z.object({}).strict();

export const RunSceneSelectionSchema = z
	.object({
		provider: z.enum(stacProviderEnum.enumValues),
		collection: z.string().trim().min(1).max(140),
		itemIds: z
			.array(z.string().trim().min(1).max(140))
			.min(1)
			.max(8)
			.refine((ids) => new Set(ids).size === ids.length, {
				message: 'itemIds não pode conter identificadores duplicados.',
			}),
	})
	.strict();

export const CreateRunBodySchema = z
	.object({
		t0: RunSceneSelectionSchema,
		t1: RunSceneSelectionSchema,
		presetName: z.enum(['TECHNICAL_STANDARD', 'CONSERVATIVE', 'CUSTOM']),
		customParams: CustomAlgorithmParamsSchema.nullable().optional(),
	})
	.strict();

export const CreateRunAcceptedResponseSchema = z
	.object({
		runId: z.string().uuid(),
		caseId: z.string().uuid(),
		version: z.number().int().min(1),
		status: z.enum(runStatusEnum.enumValues),
		seasonalityWarning: z.boolean(),
		eventsUrl: z.string(),
	})
	.strict();

export const RunSceneMetadataSummarySchema = z
	.object({
		provider: z.enum(stacProviderEnum.enumValues),
		collection: z.string(),
		itemIds: z.array(z.string()),
		isMultiTile: z.boolean(),
		acquiredAt: z.string().datetime(),
		aoiCloudPct: z.number(),
		aoiCoveragePct: z.number(),
		globalCloudPct: z.number(),
		processingBaseline: z.string().nullable(),
		boaOffsetApplied: z.boolean(),
	})
	.strict();

export const RunAreaSummarySchema = z
	.object({
		validAnalyzedHa: z.number().nullable(),
		cloudMaskedHa: z.number().nullable(),
		deforestationHa: z.number().nullable(),
		degradationHa: z.number().nullable(),
		regrowthHa: z.number().nullable(),
		stableHa: z.number().nullable(),
		cloudObstructionPct: z.number().nullable(),
		visibilityCompromisedWarning: z.boolean(),
		activeFeatureCount: z.number().int(),
		dismissedFeatureCount: z.number().int(),
	})
	.strict();

export const RasterAssetItemSchema = z
	.object({
		id: z.string().uuid(),
		assetType: z.enum(rasterTypeEnum.enumValues),
		mimeType: z.string(),
		sizeBytes: z.number().int(),
		sha256: z.string().length(64),
		widthPx: z.number().int(),
		heightPx: z.number().int(),
		bounds4674: z.tuple([z.number(), z.number(), z.number(), z.number()]),
		url: z.string(),
		createdAt: z.string().datetime(),
	})
	.strict();

export const RunDetailResponseSchema = z
	.object({
		id: z.string().uuid(),
		caseId: z.string().uuid(),
		version: z.number().int(),
		status: z.enum(runStatusEnum.enumValues),
		t0: RunSceneMetadataSummarySchema,
		t1: RunSceneMetadataSummarySchema,
		seasonalityWarning: z.boolean(),
		presetName: z.string(),
		isCustomParams: z.boolean(),
		algorithmParams: CustomAlgorithmParamsSchema,
		engineVersion: z.string(),
		summary: RunAreaSummarySchema,
		rasterAssets: z.array(RasterAssetItemSchema),
		executedBy: CaseOperatorSummarySchema,
		errorCode: z.string().nullable(),
		errorDetail: z.string().nullable(),
		queuedAt: z.string().datetime(),
		startedAt: z.string().datetime().nullable(),
		finishedAt: z.string().datetime().nullable(),
	})
	.strict();

export const ListRunFeaturesQuerySchema = z
	.object({
		format: z.enum(['geojson', 'json']).default('geojson'),
		reviewStatus: z.union([z.literal('all'), z.enum(reviewStatusEnum.enumValues)]).default('all'),
		class: z.union([z.literal('all'), z.enum(featureClassEnum.enumValues)]).default('all'),
		page: z.coerce.number().int().min(1).default(1),
		limit: z.coerce.number().int().min(1).max(500).default(100),
	})
	.strict();

export const DetectedFeaturePolygonGeoJsonSchema = z
	.object({
		type: z.literal('Polygon'),
		coordinates: z.array(z.array(GeoJsonPointTupleSchema)),
	})
	.strict();

export const DetectedFeatureCentroidSchema = z
	.object({
		lat: z.number(),
		lon: z.number(),
		utmE: z.number(),
		utmN: z.number(),
	})
	.strict();

export const DetectedFeatureItemSchema = z
	.object({
		id: z.string().uuid(),
		runId: z.string().uuid(),
		featureSequence: z.number().int(),
		label: z.string(),
		featureClass: z.enum(featureClassEnum.enumValues),
		areaHa: z.number(),
		pixelCount: z.number().int(),
		meanNdviT0: z.number(),
		meanNdviT1: z.number(),
		meanDeltaNdvi: z.number(),
		centroid: DetectedFeatureCentroidSchema,
		reviewStatus: z.enum(reviewStatusEnum.enumValues),
		dismissalReason: z.string().nullable(),
		reviewedBy: CaseOperatorSummarySchema.nullable(),
		reviewedAt: z.string().datetime().nullable(),
		createdAt: z.string().datetime(),
	})
	.strict();

export const RunFeaturesGeoJsonResponseSchema = z
	.object({
		type: z.literal('FeatureCollection'),
		runId: z.string().uuid(),
		features: z.array(
			z
				.object({
					type: z.literal('Feature'),
					id: z.string().uuid(),
					geometry: DetectedFeaturePolygonGeoJsonSchema,
					properties: DetectedFeatureItemSchema,
				})
				.strict(),
		),
	})
	.strict();

export const RunFeaturesJsonResponseSchema = z
	.object({
		format: z.literal('json'),
		runId: z.string().uuid(),
		items: z.array(DetectedFeatureItemSchema),
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

export const RunFeaturesResponseSchema = z.union([
	RunFeaturesGeoJsonResponseSchema,
	RunFeaturesJsonResponseSchema,
]);

export const ReviewFeatureBodySchema = z
	.object({
		reviewStatus: z.enum(reviewStatusEnum.enumValues),
		dismissalReason: z.string().trim().max(600).nullable().optional(),
	})
	.strict();

export const ReviewFeatureResponseSchema = z
	.object({
		feature: DetectedFeatureItemSchema,
		updatedSummary: RunAreaSummarySchema,
	})
	.strict();

export type RunSceneSelection = z.infer<typeof RunSceneSelectionSchema>;
export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;
export type ListRunFeaturesQuery = z.infer<typeof ListRunFeaturesQuerySchema>;
export type ReviewFeatureBody = z.infer<typeof ReviewFeatureBodySchema>;
export type RunAreaSummary = z.infer<typeof RunAreaSummarySchema>;
export type DetectedFeatureItem = z.infer<typeof DetectedFeatureItemSchema>;
export type DetectedFeaturePolygonGeoJson = z.infer<typeof DetectedFeaturePolygonGeoJsonSchema>;
