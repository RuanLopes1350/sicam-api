import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import exportController from '../controller/exportController.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { ProblemDetailsSchema } from '../utils/helpers/problemDetails.js';
import {
	DownloadExportQuerySchema,
	ExportIdParamsSchema,
	ExportPackageMetadataResponseSchema,
	RequestExportAcceptedResponseSchema,
	RequestExportBodySchema,
	RequestExportHeadersSchema,
	VerifyIntegrityOpenApiBodySchema,
	VerifyIntegrityResponseSchema,
} from '../utils/validation/exportValidation.js';
import { RunIdParamsSchema } from '../utils/validation/runValidation.js';

export const exportRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post(
		'/runs/:runId/export',
		{
			config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
			preHandler: [requireAuth(['analyst'])],
			schema: {
				tags: ['Exports'],
				summary:
					'Solicita emissão assíncrona da Carta-Imagem PDF 300 DPI + Pacote Técnico .zip (Idempotency-Key + fila cartography-export)',
				params: RunIdParamsSchema,
				headers: RequestExportHeadersSchema,
				body: RequestExportBodySchema,
				response: {
					202: RequestExportAcceptedResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					403: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
					409: ProblemDetailsSchema,
					429: ProblemDetailsSchema,
				},
			},
		},
		exportController.requestExport.bind(exportController),
	);

	app.get(
		'/runs/:runId/export',
		{
			config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Exports'],
				summary:
					'Retorna metadados, hashes SHA-256, manifesto de auditoria e rotas de download do pacote técnico congelado',
				params: RunIdParamsSchema,
				response: {
					200: ExportPackageMetadataResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
				},
			},
		},
		exportController.getExportMetadata.bind(exportController),
	);

	app.get(
		'/exports/:exportId/download',
		{
			config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Exports'],
				summary:
					'Download autenticado e auditado (export_downloaded) da Carta-Imagem PDF ou do Pacote Técnico .zip direto do S3 privado',
				params: ExportIdParamsSchema,
				querystring: DownloadExportQuerySchema,
				response: {
					200: z.any(),
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					404: ProblemDetailsSchema,
					429: ProblemDetailsSchema,
				},
			},
		},
		exportController.downloadExport.bind(exportController),
	);

	app.post(
		'/integrity/verify',
		{
			config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
			preHandler: [requireAuth(['admin', 'analyst', 'auditor'])],
			schema: {
				tags: ['Integrity'],
				summary:
					'Verifica autenticidade criptográfica de Carta-Imagem PDF ou Pacote .zip via hash SHA-256 JSON ou upload multipart em streaming (até 100 MB)',
				consumes: ['application/json', 'multipart/form-data'],
				body: VerifyIntegrityOpenApiBodySchema,
				response: {
					200: VerifyIntegrityResponseSchema,
					400: ProblemDetailsSchema,
					401: ProblemDetailsSchema,
					413: ProblemDetailsSchema,
					429: ProblemDetailsSchema,
				},
			},
		},
		exportController.verifyIntegrity.bind(exportController),
	);
};
