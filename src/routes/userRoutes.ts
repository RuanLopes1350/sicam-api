import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import userController from '../controller/userController.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { ProblemDetailsSchema } from '../utils/helpers/problemDetails.js';
import {
	CreateUserBodySchema,
	ListUsersQuerySchema,
	ListUsersResponseSchema,
	UpdateUserBodySchema,
	UpdateUserParamsSchema,
	UserRecordSchema,
} from '../utils/validation/userValidation.js';

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
	app.get(
		'/users',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin'])],
			schema: {
				tags: ['Users'],
				summary: 'Lista contas de operadores cadastrados (Administrador apenas)',
				querystring: ListUsersQuerySchema,
				response: {
					200: ListUsersResponseSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
				},
			},
		},
		userController.listUsers.bind(userController),
	);

	app.post(
		'/users',
		{
			config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin'])],
			schema: {
				tags: ['Users'],
				summary: 'Cadastra novo operador com matrícula obrigatória e senha Argon2id (>= 12 chars)',
				body: CreateUserBodySchema,
				response: {
					201: UserRecordSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
					409: ProblemDetailsSchema,
				},
			},
		},
		userController.createUser.bind(userController),
	);

	app.patch(
		'/users/:userId',
		{
			config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin'])],
			schema: {
				tags: ['Users'],
				summary: 'Atualiza perfil/status de operador e revoga sessões imediatamente ao desativar',
				params: UpdateUserParamsSchema,
				body: UpdateUserBodySchema,
				response: {
					200: UserRecordSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
				},
			},
		},
		userController.updateUser.bind(userController),
	);
};
