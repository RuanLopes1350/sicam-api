import type { FastifyReply, FastifyRequest } from 'fastify';
import auditService from '../service/auditService.js';
import { assertAuthorizedUser } from '../utils/helpers/requestGuard.js';

class AuditController {
	async listAuditLogs(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin', 'auditor']);
		return auditService.listAuditLogs(request.query);
	}
}

export default new AuditController();
