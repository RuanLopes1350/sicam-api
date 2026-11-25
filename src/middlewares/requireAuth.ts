import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { UserRole } from '../config/db/schema/enums.js';
import userRepository from '../repository/userRepository.js';
import { verifyAccessToken } from '../utils/helpers/crypto.js';
import { DomainError } from '../utils/helpers/domainError.js';
import type { AuthenticatedUser } from '../utils/helpers/requestGuard.js';
import fp from './fpHelper.js';

declare module 'fastify' {
	interface FastifyRequest {
		authUser: AuthenticatedUser | null;
	}
}

// ADR-02 & Matriz Zero Trust: Verifica assinatura EdDSA, expiração, status active no PostgreSQL e RBAC
export const authPlugin = fp(async (app: FastifyInstance) => {
	app.decorateRequest('authUser', null);
});

export function requireAuth(allowedRoles?: readonly UserRole[]): preHandlerHookHandler {
	return async (request: FastifyRequest, _reply: FastifyReply) => {
		const authHeader = request.headers.authorization;
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			throw new DomainError(
				'ERR_UNAUTHORIZED',
				'Cabeçalho Authorization Bearer ausente ou malformado.',
			);
		}

		const rawToken = authHeader.slice('Bearer '.length).trim();
		if (!rawToken) {
			throw new DomainError('ERR_UNAUTHORIZED', 'Token de acesso ausente.');
		}

		let claims: Awaited<ReturnType<typeof verifyAccessToken>>;
		try {
			claims = await verifyAccessToken(rawToken);
		} catch {
			throw new DomainError(
				'ERR_UNAUTHORIZED',
				'Token de acesso inválido, expirado ou com assinatura rejeitada.',
			);
		}

		const dbUser = await userRepository.findById(claims.sub);

		if (!dbUser || !dbUser.active) {
			throw new DomainError(
				'ERR_UNAUTHORIZED',
				'Operador inexistente ou com credenciais revogadas/desativadas.',
			);
		}

		if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(dbUser.role)) {
			throw new DomainError(
				'ERR_FORBIDDEN_ROLE',
				`O perfil '${dbUser.role}' não possui permissão para executar esta operação.`,
			);
		}

		request.authUser = {
			id: dbUser.id,
			fullName: dbUser.fullName,
			registrationCode: dbUser.registrationCode,
			email: dbUser.email,
			role: dbUser.role,
		};
	};
}
