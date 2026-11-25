import type { FastifyReply, FastifyRequest } from 'fastify';
import territoryService from '../service/territoryService.js';
import { assertAuthorizedUser } from '../utils/helpers/requestGuard.js';

class TerritoryController {
	async listStates(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		return territoryService.listStates();
	}

	async listMunicipalities(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		return territoryService.searchMunicipalities(request.query);
	}
}

export default new TerritoryController();
