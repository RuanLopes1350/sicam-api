import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import territoryController from '../controller/territoryController.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { ProblemDetailsSchema } from '../utils/helpers/problemDetails.js';
import {
	MunicipalitiesQuerySchema,
	MunicipalitiesResponseSchema,
	StatesResponseSchema,
} from '../utils/validation/territoryValidation.js';

export const territoryRoutes: FastifyPluginAsyncZod = async (app) => {
	app.get(
		'/territories/states',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Territories'],
				summary: 'Lista as UFs importadas na malha territorial oficial do IBGE',
				response: {
					200: StatesResponseSchema,
					401: ProblemDetailsSchema,
				},
			},
		},
		territoryController.listStates.bind(territoryController),
	);

	app.get(
		'/territories/municipalities',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Territories'],
				summary: 'Busca municípios da malha IBGE com centroide e bounding box para navegação no mapa',
				querystring: MunicipalitiesQuerySchema,
				response: {
					200: MunicipalitiesResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
				},
			},
		},
		territoryController.listMunicipalities.bind(territoryController),
	);
};
