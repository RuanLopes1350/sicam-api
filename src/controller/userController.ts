import type { FastifyReply, FastifyRequest } from 'fastify';
import userService from '../service/userService.js';
import {
	assertAuthorizedUser,
	assertBodyObject,
	assertRequiredBodyFields,
	assertRequiredParams,
	extractClientContext,
} from '../utils/helpers/requestGuard.js';

class UserController {
	async listUsers(request: FastifyRequest, _reply: FastifyReply) {
		assertAuthorizedUser(request.authUser, ['admin']);
		return userService.listUsers(request.query);
	}

	async createUser(request: FastifyRequest, reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['admin']);
		assertRequiredBodyFields(request.body, [
			'fullName',
			'registrationCode',
			'email',
			'password',
			'role',
		]);

		const created = await userService.createUser(
			request.body,
			actor.id,
			extractClientContext(request),
		);
		return reply.code(201).send(created);
	}

	async updateUser(request: FastifyRequest, _reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['admin']);
		assertRequiredParams(request.params, ['userId']);
		assertBodyObject(request.body);

		return userService.updateUser(
			request.params,
			request.body,
			actor.id,
			extractClientContext(request),
		);
	}
}

export default new UserController();
