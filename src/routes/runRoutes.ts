import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import runController from '../controller/runController.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { ProblemDetailsSchema } from '../utils/helpers/problemDetails.js';
import { CaseIdParamsSchema } from '../utils/validation/caseValidation.js';
import {
	CreateRunAcceptedResponseSchema,
	CreateRunBodySchema,
	CreateRunHeadersSchema,
	ListRunFeaturesQuerySchema,
	ReviewFeatureBodySchema,
	ReviewFeatureResponseSchema,
	RunDetailResponseSchema,
	RunEventsQuerySchema,
	RunFeatureParamsSchema,
	RunFeaturesResponseSchema,
	RunIdParamsSchema,
	RunRasterParamsSchema,
	RunRasterQuerySchema,
} from '../utils/validation/runValidation.js';

export const runRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post(
		'/cases/:caseId/runs',
		{
			config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
			preHandler: [requireAuth(['analyst'])],
			schema: {
				tags: ['Runs'],
				summary:
					'Dispara execução analítica multitemporal assíncrona na fila BullMQ geo-analysis (Zero Trust + Idempotency-Key)',
				params: CaseIdParamsSchema,
				headers: CreateRunHeadersSchema,
				body: CreateRunBodySchema,
				response: {
					202: CreateRunAcceptedResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
					409: ProblemDetailsSchema,
					422: ProblemDetailsSchema,
					429: ProblemDetailsSchema,
					502: ProblemDetailsSchema,
				},
			},
		},
		runController.createRun.bind(runController),
	);

	app.get(
		'/runs/:runId',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Runs'],
				summary:
					'Retorna estado atual da execução, proveniência STAC, sumário consolidado de áreas e catálogo de rasters PNG',
				params: RunIdParamsSchema,
				response: {
					200: RunDetailResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
				},
			},
		},
		runController.getRun.bind(runController),
	);

	app.get(
		'/runs/:runId/events',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Runs'],
				summary:
					'Stream SSE em tempo real de progresso e conclusão da execução (snapshot + Pub/Sub Redis + heartbeat 15s)',
				params: RunIdParamsSchema,
				querystring: RunEventsQuerySchema,
				response: {
					200: z.any(),
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
					429: ProblemDetailsSchema,
				},
			},
		},
		runController.streamRunEvents.bind(runController),
	);

	app.get(
		'/runs/:runId/features',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Runs'],
				summary:
					'Lista polígonos detectados ordenados por área decrescente (FeatureCollection GeoJSON ou tabela JSON paginada)',
				params: RunIdParamsSchema,
				querystring: ListRunFeaturesQuerySchema,
				response: {
					200: RunFeaturesResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
				},
			},
		},
		runController.listFeatures.bind(runController),
	);

	app.patch(
		'/runs/:runId/features/:featureId/review',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['analyst'])],
			schema: {
				tags: ['Runs'],
				summary:
					'Confirma ou descarta polígono como falso positivo (dismissed_noise) com justificativa obrigatória e recálculo geodésico no PostGIS',
				params: RunFeatureParamsSchema,
				body: ReviewFeatureBodySchema,
				response: {
					200: ReviewFeatureResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
					409: ProblemDetailsSchema,
				},
			},
		},
		runController.reviewFeature.bind(runController),
	);

	app.get(
		'/runs/:runId/rasters/:assetType',
		{
			config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Runs'],
				summary:
					'Proxy autenticado em streaming da evidência PNG lossless armazenada no bucket S3 privado',
				params: RunRasterParamsSchema,
				querystring: RunRasterQuerySchema,
				response: {
					200: z.any(),
					304: z.any(),
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
				},
			},
		},
		runController.streamRasterAsset.bind(runController),
	);
};
