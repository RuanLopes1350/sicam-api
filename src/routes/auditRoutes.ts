import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import auditController from '../controller/auditController.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { ProblemDetailsSchema } from '../utils/helpers/problemDetails.js';
import {
	AuditLogQuerySchema,
	AuditLogResponseSchema,
} from '../utils/validation/auditValidation.js';

export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
	app.get(
		'/audit-logs',
		{
			config: {
				rateLimit: { max: 30, timeWindow: '1 minute' },
			},
			preHandler: [requireAuth(['admin', 'auditor'])],
			schema: {
				tags: ['Audit'],
				summary: 'Consulta paginada (keyset) da trilha de auditoria append-only',
				querystring: AuditLogQuerySchema,
				response: {
					200: AuditLogResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
				},
			},
		},
		auditController.listAuditLogs.bind(auditController),
	);
};
