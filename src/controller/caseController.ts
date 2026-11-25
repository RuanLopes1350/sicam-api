import type { FastifyReply, FastifyRequest } from 'fastify';
import caseService from '../service/caseService.js';
import {
	assertAuthorizedUser,
	assertBodyObject,
	assertRequiredBodyFields,
	assertRequiredParams,
	extractClientContext,
} from '../utils/helpers/requestGuard.js';

class CaseController {
	async createCase(request: FastifyRequest, reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['analyst']);
		assertRequiredBodyFields(request.body, ['title', 'aoiGeoJson']);

		const created = await caseService.createCase(
			request.body,
			actor,
			extractClientContext(request),
		);
		return reply.code(201).send(created);
	}

	async listCases(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		return caseService.listCases(request.query);
	}

	async getCase(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		assertRequiredParams(request.params, ['caseId']);
		return caseService.getCaseById(request.params);
	}

	async updateCase(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['analyst']);
		assertRequiredParams(request.params, ['caseId']);
		assertBodyObject(request.body);
		return caseService.updateCaseMetadata(request.params, request.body);
	}
}

export default new CaseController();
