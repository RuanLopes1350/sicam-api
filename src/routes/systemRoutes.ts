import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import systemController from '../controller/systemController.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { ProblemDetailsSchema } from '../utils/helpers/problemDetails.js';
import {
	CapabilitiesResponseSchema,
	HealthLiveResponseSchema,
	HealthReadyResponseSchema,
} from '../utils/validation/systemValidation.js';

export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
	app.get(
		'/health/live',
		{
			config: { rateLimit: false },
			schema: {
				tags: ['System'],
				summary: 'Verifica vivacidade do processo HTTP',
				response: {
					200: HealthLiveResponseSchema,
				},
			},
		},
		systemController.live.bind(systemController),
	);

	app.get(
		'/health/ready',
		{
			config: { rateLimit: false },
			schema: {
				tags: ['System'],
				summary: 'Verifica conectividade ativa com PostgreSQL/PostGIS, Redis e Bucket S3',
				response: {
					200: HealthReadyResponseSchema,
					503: HealthReadyResponseSchema,
				},
			},
		},
		systemController.ready.bind(systemController),
	);

	app.get(
		'/system/capabilities',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['System'],
				summary:
					'Retorna os limites operacionais ativos, presets espectrais e UFs carregadas (ADR-13)',
				response: {
					200: CapabilitiesResponseSchema,
					401: ProblemDetailsSchema,
				},
			},
		},
		systemController.capabilities.bind(systemController),
	);
};
