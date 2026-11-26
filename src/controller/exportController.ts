import type { FastifyReply, FastifyRequest } from 'fastify';
import {
	checkIdempotencyOrReplay,
	saveIdempotencyResponse,
} from '../middlewares/idempotency.js';
import exportService from '../service/exportService.js';
import { DomainError } from '../utils/helpers/domainError.js';
import {
	assertAuthorizedUser,
	assertRequiredBodyFields,
	assertRequiredParams,
	extractClientContext,
} from '../utils/helpers/requestGuard.js';

// Camada Controller ("Porteiro"): RBAC, presença de campos/parâmetros obrigatórios e Idempotency-Key
class ExportController {
	async requestExport(request: FastifyRequest, reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['analyst']);
		const { runId } = assertRequiredParams(request.params, ['runId']);

		const idempotency = await checkIdempotencyOrReplay(request, reply, `export-run:${runId}`);
		if (idempotency.replayed) {
			return;
		}

		if (
			request.body !== undefined &&
			request.body !== null &&
			(typeof request.body !== 'object' || Array.isArray(request.body))
		) {
			throw new DomainError(
				'ERR_VALIDATION_FAILED',
				'Corpo da requisição deve ser um objeto JSON válido.',
				{
					invalidParams: [{ field: 'body', reason: 'EXPECTED_JSON_OBJECT' }],
				},
			);
		}

		const accepted = await exportService.requestExport(
			request.params,
			request.body,
			actor,
			extractClientContext(request),
		);

		await saveIdempotencyResponse(idempotency.redisKey, idempotency.payloadHash, 202, accepted);
		return reply.code(202).send(accepted);
	}

	async getExportMetadata(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		assertRequiredParams(request.params, ['runId']);
		return exportService.getRunExportMetadata(request.params);
	}

	async downloadExport(request: FastifyRequest, reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		assertRequiredParams(request.params, ['exportId']);

		const result = await exportService.downloadExportArtifact(
			request.params,
			request.query,
			actor,
			extractClientContext(request),
		);

		reply
			.code(200)
			.header('Content-Type', result.contentType)
			.header('Content-Disposition', `attachment; filename="${result.fileName}"`)
			.header('X-Artifact-SHA256', result.sha256)
			.header('Cache-Control', 'private, no-store');

		if (result.sizeBytes !== undefined) {
			reply.header('Content-Length', String(result.sizeBytes));
		}

		return reply.send(result.stream);
	}

	async verifyIntegrity(request: FastifyRequest, _reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		const clientCtx = extractClientContext(request);

		if (request.isMultipart()) {
			const part = await request.file();
			if (!part) {
				throw new DomainError(
					'ERR_VALIDATION_FAILED',
					'Nenhum arquivo binário (.pdf ou .zip) foi enviado no formulário multipart.',
					{
						invalidParams: [{ field: 'file', reason: 'REQUIRED_MULTIPART_FILE' }],
					},
				);
			}

			return exportService.verifyIntegrityByStream(
				{
					filename: part.filename,
					mimetype: part.mimetype,
					file: part.file,
				},
				actor,
				clientCtx,
			);
		}

		assertRequiredBodyFields(request.body, ['sha256']);
		return exportService.verifyIntegrityByJson(request.body, actor, clientCtx);
	}
}

export default new ExportController();
