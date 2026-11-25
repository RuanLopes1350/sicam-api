import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import authService, { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from '../service/authService.js';
import { DomainError } from '../utils/helpers/domainError.js';
import {
	assertAuthorizedUser,
	assertRequiredBodyFields,
	extractClientContext,
} from '../utils/helpers/requestGuard.js';

function setRefreshCookie(reply: FastifyReply, rawToken: string, expiresAt: Date): void {
	reply.setCookie(REFRESH_COOKIE_NAME, rawToken, {
		httpOnly: true,
		secure: env.COOKIE_SECURE,
		sameSite: 'strict',
		path: REFRESH_COOKIE_PATH,
		expires: expiresAt,
	});
}

function clearRefreshCookie(reply: FastifyReply): void {
	reply.clearCookie(REFRESH_COOKIE_NAME, {
		httpOnly: true,
		secure: env.COOKIE_SECURE,
		sameSite: 'strict',
		path: REFRESH_COOKIE_PATH,
	});
}

class AuthController {
	async login(request: FastifyRequest, reply: FastifyReply) {
		assertRequiredBodyFields(request.body, ['email', 'password']);

		const result = await authService.login(request.body, extractClientContext(request));
		setRefreshCookie(reply, result.rawRefreshToken, result.refreshExpiresAt);
		return result.response;
	}

	async refresh(request: FastifyRequest, reply: FastifyReply) {
		const rawCookie = request.cookies[REFRESH_COOKIE_NAME];
		if (!rawCookie || rawCookie.trim().length < 16) {
			clearRefreshCookie(reply);
			throw new DomainError(
				'ERR_UNAUTHORIZED',
				'Cookie de renovação de sessão ausente ou inválido.',
			);
		}

		try {
			const result = await authService.refresh(rawCookie, extractClientContext(request));
			setRefreshCookie(reply, result.rawRefreshToken, result.refreshExpiresAt);
			return result.response;
		} catch (err) {
			clearRefreshCookie(reply);
			throw err;
		}
	}

	async logout(request: FastifyRequest, reply: FastifyReply) {
		const actor = assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
		const rawCookie = request.cookies[REFRESH_COOKIE_NAME];

		const res = await authService.logout(rawCookie, actor.id, extractClientContext(request));
		clearRefreshCookie(reply);
		return res;
	}

	async me(request: FastifyRequest, _reply: FastifyReply) {
		return assertAuthorizedUser(request.authUser, ['admin', 'analyst', 'auditor']);
	}
}

export default new AuthController();
