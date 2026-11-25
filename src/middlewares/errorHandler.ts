import { randomUUID } from 'node:crypto';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { parseDatabaseError } from '../utils/helpers/dbErrors.js';
import { DomainError, type InvalidParamDetail } from '../utils/helpers/domainError.js';
import { buildProblemDetails, domainErrorToProblem } from '../utils/helpers/problemDetails.js';
import fp from './fpHelper.js';

const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

// RNF-02 & Contrato OpenAPI Seção 1.2: Padronização universal RFC 9457 sem vazamento de stack trace
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
	app.setNotFoundHandler((request, reply) => {
		const correlationId = request.correlationId || randomUUID();
		const problem = buildProblemDetails({
			code: 'ERR_RESOURCE_NOT_FOUND',
			detail: `Rota ${request.method} ${request.url.split('?')[0]} não encontrada.`,
			instance: request.url.split('?')[0] ?? request.url,
			correlationId,
		});

		return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problem);
	});

	app.setErrorHandler((error: FastifyError | Error, request, reply) => {
		const correlationId = request.correlationId || randomUUID();
		const instance = request.url.split('?')[0] ?? request.url;

		// 1. Rate Limiting (@fastify/rate-limit)
		if ((error as FastifyError).statusCode === 429) {
			const problem = buildProblemDetails({
				code: 'ERR_RATE_LIMIT_EXCEEDED',
				detail: 'Excesso de requisições na janela configurada. Aguarde antes de tentar novamente.',
				instance,
				correlationId,
			});
			return reply.code(429).type(PROBLEM_CONTENT_TYPE).send(problem);
		}

		// 2. Payload muito grande (ex: upload multipart > 100 MB)
		if ((error as FastifyError).statusCode === 413) {
			const problem = buildProblemDetails({
				code: 'ERR_VALIDATION_FAILED',
				statusOverride: 413,
				titleOverride: 'Payload excede o limite permitido',
				detail: 'O tamanho do corpo ou arquivo enviado excede o teto operacional permitido.',
				instance,
				correlationId,
			});
			return reply.code(413).type(PROBLEM_CONTENT_TYPE).send(problem);
		}

		// 3. Erros de validação Zod (disparados na camada Service)
		const zodCause =
			error instanceof ZodError
				? error
				: (error as { cause?: unknown }).cause instanceof ZodError
					? (error as { cause: ZodError }).cause
					: null;

		if (zodCause) {
			const invalidParams: InvalidParamDetail[] = zodCause.issues.map((issue) => ({
				field: issue.path.length > 0 ? issue.path.join('.') : 'root',
				reason: issue.code.toUpperCase(),
				meta: { message: issue.message },
			}));

			const problem = buildProblemDetails({
				code: 'ERR_VALIDATION_FAILED',
				detail: 'O payload enviado contém campos inválidos, ausentes ou não reconhecidos.',
				instance,
				correlationId,
				invalidParams,
			});
			return reply.code(400).type(PROBLEM_CONTENT_TYPE).send(problem);
		}

		if ((error as FastifyError).validation) {
			const validationItems = (error as FastifyError).validation ?? [];
			const invalidParams: InvalidParamDetail[] = validationItems.map((item) => ({
				field: item.instancePath ? item.instancePath.replace(/^\//, '') : 'body',
				reason: (item.keyword ?? 'VALIDATION').toUpperCase(),
				meta: item.message ? { message: item.message } : undefined,
			}));

			const problem = buildProblemDetails({
				code: 'ERR_VALIDATION_FAILED',
				detail: 'O payload enviado viola o contrato de entrada esperado.',
				instance,
				correlationId,
				invalidParams,
			});
			return reply.code(400).type(PROBLEM_CONTENT_TYPE).send(problem);
		}

		// 4. DomainError explícito (Controller / Service / Repository)
		if (error instanceof DomainError) {
			const problem = domainErrorToProblem(error, instance, correlationId);
			return reply.code(error.statusCode).type(PROBLEM_CONTENT_TYPE).send(problem);
		}

		// 5. JSON sintaticamente malformado
		if ((error as FastifyError).statusCode === 400) {
			const problem = buildProblemDetails({
				code: 'ERR_VALIDATION_FAILED',
				detail: 'Corpo JSON malformado ou cabeçalho inválido.',
				instance,
				correlationId,
			});
			return reply.code(400).type(PROBLEM_CONTENT_TYPE).send(problem);
		}

		// 6. Erros oriundos do PostgreSQL / Triggers (sem vazar SQL)
		if ((error as { code?: string }).code && typeof (error as { code?: string }).code === 'string') {
			const mapped = parseDatabaseError(error, `${request.method} ${instance}`);
			const problem = domainErrorToProblem(mapped, instance, correlationId);
			return reply.code(mapped.statusCode).type(PROBLEM_CONTENT_TYPE).send(problem);
		}

		// 7. Fallback 500 blindado
		request.log.error(
			{ err: error, correlationId, instance },
			'Erro interno não tratado interceptado pela barreira RFC 9457',
		);

		const problem = buildProblemDetails({
			code: 'ERR_INTERNAL_SERVER_ERROR',
			detail: 'Ocorreu um erro inesperado no servidor. Informe o correlationId ao suporte técnico.',
			instance,
			correlationId,
		});
		return reply.code(500).type(PROBLEM_CONTENT_TYPE).send(problem);
	});
});
