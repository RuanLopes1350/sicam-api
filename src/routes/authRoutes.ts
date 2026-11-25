import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import authController from '../controller/authController.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { ProblemDetailsSchema } from '../utils/helpers/problemDetails.js';
import {
	AuthenticatedUserSchema,
	AuthTokenResponseSchema,
	LoginBodySchema,
	LogoutResponseSchema,
} from '../utils/validation/authValidation.js';

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post(
		'/auth/login',
		{
			config: {
				rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req) => req.ip },
			},
			schema: {
				tags: ['Auth'],
				summary:
					'Autentica operador com Argon2id e emite Access Token EdDSA + Cookie Refresh HttpOnly',
				body: LoginBodySchema,
				response: {
					200: AuthTokenResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					429: ProblemDetailsSchema,
				},
			},
		},
		authController.login.bind(authController),
	);

	app.post(
		'/auth/refresh',
		{
			config: {
				rateLimit: { max: 15, timeWindow: '1 minute', keyGenerator: (req) => req.ip },
			},
			schema: {
				tags: ['Auth'],
				summary: 'Rotaciona Refresh Token via cookie HttpOnly com detecção de reuso por família',
				response: {
					200: AuthTokenResponseSchema,
					401: ProblemDetailsSchema,
					429: ProblemDetailsSchema,
				},
			},
		},
		authController.refresh.bind(authController),
	);

	app.post(
		'/auth/logout',
		{
			config: {
				rateLimit: { max: 30, timeWindow: '1 minute' },
			},
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Auth'],
				summary: 'Revoga o Refresh Token atual no banco e limpa o cookie HttpOnly',
				response: {
					200: LogoutResponseSchema,
					401: ProblemDetailsSchema,
				},
			},
		},
		authController.logout.bind(authController),
	);

	app.get(
		'/auth/me',
		{
			config: {
				rateLimit: { max: 60, timeWindow: '1 minute' },
			},
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Auth'],
				summary: 'Retorna os dados canônicos do operador autenticado',
				response: {
					200: AuthenticatedUserSchema,
					401: ProblemDetailsSchema,
				},
			},
		},
		authController.me.bind(authController),
	);
};
