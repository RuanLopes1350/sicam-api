import type { FastifyReply, FastifyRequest } from 'fastify';
import {
	checkIdempotencyOrReplay,
	saveIdempotencyResponse,
} from '../middlewares/idempotency.js';
import runService from '../service/runService.js';
import {
	assertAuthorizedUser,
	assertRequiredBodyFields,
	assertRequiredParams,
	extractClientContext,
} from '../utils/helpers/requestGuard.js';

// Camada Controller ("Porteiro"): RBAC, presença de campos/parâmetros obrigatórios e Idempotency-Key
class RunController {
	async createRun(request: FastifyRequest, reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['analyst']);
		const { caseId } = assertRequiredParams(request.params, ['caseId']);

		const idempotency = await checkIdempotencyOrReplay(request, reply, `create-run:${caseId}`);
		if (idempotency.replayed) {
			return;
		}

		assertRequiredBodyFields(request.body, ['t0', 't1', 'presetName']);

		const created = await runService.createRun(
			request.params,
			request.body,
			actor,
			extractClientContext(request),
		);

		await saveIdempotencyResponse(idempotency.redisKey, idempotency.payloadHash, 202, created);
		return reply.code(202).send(created);
	}

	async getRun(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		assertRequiredParams(request.params, ['runId']);
		return runService.getRunById(request.params);
	}

	async listFeatures(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		assertRequiredParams(request.params, ['runId']);
		return runService.listRunFeatures(request.params, request.query);
	}

	async reviewFeature(request: FastifyRequest, _reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['analyst']);
		assertRequiredParams(request.params, ['runId', 'featureId']);
		assertRequiredBodyFields(request.body, ['reviewStatus']);

		return runService.reviewFeature(
			request.params,
			request.body,
			actor,
			extractClientContext(request),
		);
	}

	async streamRasterAsset(request: FastifyRequest, reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		assertRequiredParams(request.params, ['runId', 'assetType']);

		const headerVal = request.headers['if-none-match'];
		const ifNoneMatch = Array.isArray(headerVal) ? headerVal[0] : headerVal;

		const asset = await runService.getRasterAssetStream(
			request.params,
			ifNoneMatch,
			request.query,
		);

		reply
			.header('ETag', asset.etag)
			.header('Cache-Control', 'private, max-age=3600, immutable')
			.header('X-Artifact-SHA256', asset.sha256);

		if (asset.notModified) {
			return reply.code(304).send();
		}

		reply.header('Content-Type', asset.mimeType);
		if (asset.sizeBytes !== undefined) {
			reply.header('Content-Length', String(asset.sizeBytes));
		}

		return reply.code(200).send(asset.stream);
	}

	async streamRunEvents(request: FastifyRequest, reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		assertRequiredParams(request.params, ['runId']);

		const { stream, cleanup } = await runService.openRunEventsStream(
			request.params,
			request.query,
			actor,
		);

		reply.raw.once('close', () => {
			void cleanup();
		});
		request.raw.once('aborted', () => {
			void cleanup();
		});

		return reply
			.code(200)
			.header('Content-Type', 'text/event-stream; charset=utf-8')
			.header('Cache-Control', 'no-cache, no-transform')
			.header('Connection', 'keep-alive')
			.header('X-Accel-Buffering', 'no')
			.send(stream);
	}
}

export default new RunController();
