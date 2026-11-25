import { z } from 'zod';
import { stacProviderEnum } from '../../config/db/schema/enums.js';

export const IsoDateOnlySchema = z
	.string()
	.trim()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data esperado: YYYY-MM-DD');

export const TemporalWindowSchema = z
	.object({
		from: IsoDateOnlySchema,
		to: IsoDateOnlySchema,
	})
	.strict();

// OpenAPI Seção 3 (Módulo 5): Janela limitada a 180 dias, limitPerWindow <= 25 e providers em enum fechado
export const SceneSearchBodySchema = z
	.object({
		t0Window: TemporalWindowSchema,
		t1Window: TemporalWindowSchema,
		providers: z
			.array(z.enum(stacProviderEnum.enumValues))
			.min(1)
			.max(2)
			.default(['aws_earth_search', 'inpe_bdc']),
		maxGlobalCloudPct: z.number().min(0).max(100).default(40),
		limitPerWindow: z.number().int().min(1).max(25).default(15),
	})
	.strict();

export const SceneCandidateSchema = z
	.object({
		candidateKey: z.string(),
		provider: z.enum(stacProviderEnum.enumValues),
		collection: z.string(),
		itemIds: z.array(z.string().min(1)),
		isMultiTile: z.boolean(),
		acquiredAt: z.string().datetime(),
		globalCloudPct: z.number(),
		aoiCloudPct: z.number(),
		aoiCoveragePct: z.number(),
		processingBaseline: z.string().nullable(),
		boaOffsetApplied: z.boolean(),
		previewUrl: z.string(),
	})
	.strict();

export const ProviderWarningSchema = z
	.object({
		provider: z.enum(stacProviderEnum.enumValues),
		code: z.string(),
		message: z.string(),
	})
	.strict();

export const SceneSearchResponseSchema = z
	.object({
		caseId: z.string().uuid(),
		t0Candidates: z.array(SceneCandidateSchema),
		t1Candidates: z.array(SceneCandidateSchema),
		providerWarnings: z.array(ProviderWarningSchema),
	})
	.strict();

export const ScenePreviewQuerySchema = z
	.object({
		token: z.string().trim().min(32).max(2048),
	})
	.strict();

export type TemporalWindow = z.infer<typeof TemporalWindowSchema>;
export type SceneSearchBody = z.infer<typeof SceneSearchBodySchema>;
export type SceneCandidate = z.infer<typeof SceneCandidateSchema>;
export type ProviderWarning = z.infer<typeof ProviderWarningSchema>;
