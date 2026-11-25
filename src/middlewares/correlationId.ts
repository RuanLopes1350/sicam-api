import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import fp from './fpHelper.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare module 'fastify' {
	interface FastifyRequest {
		correlationId: string;
	}
}

// RNF-14 & OpenAPI Seção 1.1: Propaga X-Request-Id (UUID v4 validado ou gerado pelo servidor)
export const correlationIdPlugin = fp(async (app: FastifyInstance) => {
	app.decorateRequest('correlationId', '');

	app.addHook('onRequest', async (request, reply) => {
		const incoming = request.headers['x-request-id'];
		const headerVal = Array.isArray(incoming) ? incoming[0] : incoming;
		const correlationId =
			headerVal && UUID_V4_REGEX.test(headerVal.trim()) ? headerVal.trim() : randomUUID();

		request.correlationId = correlationId;
		reply.header('X-Request-Id', correlationId);
	});
});
