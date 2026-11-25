import type { FastifyReply, FastifyRequest } from 'fastify';
import sceneService from '../service/sceneService.js';
import { DomainError } from '../utils/helpers/domainError.js';
import {
	assertAuthorizedUser,
	assertRequiredBodyFields,
	assertRequiredParams,
} from '../utils/helpers/requestGuard.js';

class SceneController {
	async searchScenes(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['analyst']);
		assertRequiredParams(request.params, ['caseId']);
		assertRequiredBodyFields(request.body, ['t0Window', 't1Window']);

		return sceneService.searchScenes(request.params, request.body);
	}

	async previewScene(request: FastifyRequest, reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		assertRequiredParams(request.params, ['caseId']);

		const queryObj = (request.query ?? {}) as Record<string, unknown>;
		if (typeof queryObj.token !== 'string' || queryObj.token.trim() === '') {
			throw new DomainError(
				'ERR_VALIDATION_FAILED',
				'O parâmetro obrigatório token deve ser informado na query string.',
				{
					invalidParams: [{ field: 'token', reason: 'REQUIRED_QUERY_PARAM_MISSING' }],
				},
			);
		}

		const { contentType, buffer } = await sceneService.getScenePreview(
			request.params,
			request.query,
		);

		return reply
			.code(200)
			.header('Content-Type', contentType)
			.header('Cache-Control', 'private, max-age=1800')
			.send(buffer);
	}
}

export default new SceneController();
