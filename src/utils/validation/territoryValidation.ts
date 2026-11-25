import { z } from 'zod';

export const StateItemSchema = z
	.object({
		ufCode: z.string().length(2),
		ibgeStateId: z.number().int(),
		name: z.string(),
		datasetVersion: z.string(),
		importedAt: z.string().datetime(),
	})
	.strict();

export const StatesResponseSchema = z
	.object({
		items: z.array(StateItemSchema),
	})
	.strict();

export const MunicipalitiesQuerySchema = z
	.object({
		uf: z
			.string()
			.trim()
			.toUpperCase()
			.regex(/^[A-Z]{2}$/)
			.optional(),
		q: z.string().trim().min(1).max(100).optional(),
		limit: z.coerce.number().int().min(1).max(100).default(20),
	})
	.strict();

export const MunicipalityItemSchema = z
	.object({
		ibgeCode: z.string().length(7),
		name: z.string(),
		ufCode: z.string().length(2),
		centroid: z
			.object({
				lat: z.number(),
				lon: z.number(),
			})
			.strict(),
		bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
	})
	.strict();

export const MunicipalitiesResponseSchema = z
	.object({
		items: z.array(MunicipalityItemSchema),
	})
	.strict();

export type MunicipalitiesQuery = z.infer<typeof MunicipalitiesQuerySchema>;
