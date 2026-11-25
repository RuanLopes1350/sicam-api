import { z } from 'zod';

export const HealthLiveResponseSchema = z
	.object({
		status: z.literal('ok'),
		timestamp: z.string().datetime(),
	})
	.strict();

export const HealthReadyResponseSchema = z
	.object({
		status: z.enum(['ready', 'degraded']),
		checks: z
			.object({
				postgis: z.boolean(),
				redis: z.boolean(),
				s3: z.boolean(),
			})
			.strict(),
		timestamp: z.string().datetime(),
	})
	.strict();

export const AlgorithmPresetSchema = z
	.object({
		ndviForestMin: z.number(),
		ndviClearedMax: z.number(),
		deforestationDeltaMax: z.number(),
		degradationDeltaMax: z.number(),
		regrowthStartMax: z.number(),
		regrowthEndMin: z.number(),
		regrowthDeltaMin: z.number(),
		morphologicalKernel: z.union([z.literal(0), z.literal(3)]),
		minMappingUnitHa: z.number(),
	})
	.strict();

export const RangeBoundSchema = z
	.object({
		min: z.number(),
		max: z.number(),
	})
	.strict();

export const CapabilitiesResponseSchema = z
	.object({
		aoi: z
			.object({
				minAreaHa: z.number(),
				maxAreaHa: z.number(),
				maxVertices: z.number().int(),
				enforceLoadedUfs: z.boolean(),
				loadedUfs: z.array(
					z
						.object({
							ufCode: z.string().length(2),
							name: z.string(),
							datasetVersion: z.string(),
						})
						.strict(),
				),
			})
			.strict(),
		analysis: z
			.object({
				maxActiveRunsPerUser: z.number().int(),
				presets: z
					.object({
						TECHNICAL_STANDARD: AlgorithmPresetSchema,
						CONSERVATIVE: AlgorithmPresetSchema,
					})
					.strict(),
				hardBounds: z
					.object({
						ndviForestMin: RangeBoundSchema,
						ndviClearedMax: RangeBoundSchema,
						deforestationDeltaMax: RangeBoundSchema,
						degradationDeltaMax: RangeBoundSchema,
						regrowthStartMax: RangeBoundSchema,
						regrowthEndMin: RangeBoundSchema,
						regrowthDeltaMin: RangeBoundSchema,
						morphologicalKernel: z.tuple([z.literal(0), z.literal(3)]),
						minMappingUnitHa: RangeBoundSchema,
					})
					.strict(),
			})
			.strict(),
		export: z
			.object({
				supportedPaperFormats: z.array(z.enum(['A4', 'A3'])),
				defaultPaperFormat: z.enum(['A4', 'A3']),
			})
			.strict(),
	})
	.strict();
