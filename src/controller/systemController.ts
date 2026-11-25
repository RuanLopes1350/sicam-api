import type { FastifyReply, FastifyRequest } from 'fastify';
import systemService from '../service/systemService.js';
import { assertAuthorizedUser } from '../utils/helpers/requestGuard.js';

class SystemController {
	async live(_request: FastifyRequest, _reply: FastifyReply) {
		return systemService.getLiveStatus();
	}

	async ready(request: FastifyRequest, reply: FastifyReply) {
		const { allReady, payload } = await systemService.getReadinessStatus(request.log);
		return reply.code(allReady ? 200 : 503).send(payload);
	}

	async capabilities(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		return systemService.getCapabilities();
	}
}

export default new SystemController();
