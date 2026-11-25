import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import sceneController from '../controller/sceneController.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { ProblemDetailsSchema } from '../utils/helpers/problemDetails.js';
import { CaseIdParamsSchema } from '../utils/validation/caseValidation.js';
import {
	ScenePreviewQuerySchema,
	SceneSearchBodySchema,
	SceneSearchResponseSchema,
} from '../utils/validation/sceneValidation.js';

export const sceneRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post(
		'/cases/:caseId/scenes/search',
		{
			config: {
				rateLimit: { max: 15, timeWindow: '1 minute' },
			},
			preHandler: [requireAuth(['analyst'])],
			schema: {
				tags: ['Scenes'],
				summary:
					'Busca cenas STAC (AWS Earth Search + INPE BDC), agrupa mosaicos MGRS e mede % nuvem real na AOI via SCL COG',
				params: CaseIdParamsSchema,
				body: SceneSearchBodySchema,
				response: {
					200: SceneSearchResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
					422: ProblemDetailsSchema,
					429: ProblemDetailsSchema,
					502: ProblemDetailsSchema,
				},
			},
		},
		sceneController.searchScenes.bind(sceneController),
	);

	app.get(
		'/cases/:caseId/scenes/preview',
		{
			config: {
				rateLimit: { max: 60, timeWindow: '1 minute' },
			},
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Scenes'],
				summary: 'Faz proxy autenticado e Anti-SSRF da miniatura de cena assinada pelo servidor',
				params: CaseIdParamsSchema,
				querystring: ScenePreviewQuerySchema,
				response: {
					200: z.any(),
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
					422: ProblemDetailsSchema,
					502: ProblemDetailsSchema,
				},
			},
		},
		sceneController.previewScene.bind(sceneController),
	);
};
