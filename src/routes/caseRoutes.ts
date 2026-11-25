import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import caseController from '../controller/caseController.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { ProblemDetailsSchema } from '../utils/helpers/problemDetails.js';
import {
	CaseDetailResponseSchema,
	CaseIdParamsSchema,
	CaseRecordSchema,
	CreateCaseBodySchema,
	ListCasesQuerySchema,
	ListCasesResponseSchema,
	UpdateCaseBodySchema,
} from '../utils/validation/caseValidation.js';

export const caseRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post(
		'/cases',
		{
			config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['analyst'])],
			schema: {
				tags: ['Cases'],
				summary:
					'Cria Caso de Análise validando topologia, cobertura IBGE e área oficial em SIRGAS 2000 UTM',
				body: CreateCaseBodySchema,
				response: {
					201: CaseRecordSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
					422: ProblemDetailsSchema,
				},
			},
		},
		caseController.createCase.bind(caseController),
	);

	app.get(
		'/cases',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Cases'],
				summary: 'Lista e filtra casos por protocolo, município, UF, período, operador, status ou bbox',
				querystring: ListCasesQuerySchema,
				response: {
					200: ListCasesResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
				},
			},
		},
		caseController.listCases.bind(caseController),
	);

	app.get(
		'/cases/:caseId',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Cases'],
				summary: 'Retorna detalhe completo do caso acompanhado do resumo de suas execuções (v1..vN)',
				params: CaseIdParamsSchema,
				response: {
					200: CaseDetailResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
				},
			},
		},
		caseController.getCase.bind(caseController),
	);

	app.patch(
		'/cases/:caseId',
		{
			config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['analyst'])],
			schema: {
				tags: ['Cases'],
				summary: 'Atualiza exclusivamente metadados textuais do caso (AOI e protocolo são imutáveis)',
				params: CaseIdParamsSchema,
				body: UpdateCaseBodySchema,
				response: {
					200: CaseRecordSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
				},
			},
		},
		caseController.updateCase.bind(caseController),
	);
};
