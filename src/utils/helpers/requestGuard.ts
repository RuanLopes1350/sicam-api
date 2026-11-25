import type { FastifyRequest } from 'fastify';
import type { UserRole } from '../../config/db/schema/enums.js';
import { DomainError, type InvalidParamDetail } from './domainError.js';

export interface AuthenticatedUser {
	id: string;
	fullName: string;
	registrationCode: string;
	email: string;
	role: UserRole;
}

export interface RequestClientContext {
	ipAddress: string;
	userAgent?: string;
	correlationId: string;
}

// Utilitários de borda para a camada Controller (Porteiro): presença de campos exigidos e RBAC
export function assertRequiredBodyFields(
	body: unknown,
	requiredFields: readonly string[],
): Record<string, unknown> {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			'Corpo da requisição deve ser um objeto JSON válido.',
			{
				invalidParams: [{ field: 'body', reason: 'EXPECTED_JSON_OBJECT' }],
			},
		);
	}

	const record = body as Record<string, unknown>;
	const missing: InvalidParamDetail[] = [];

	for (const field of requiredFields) {
		const value = record[field];
		if (
			value === undefined ||
			value === null ||
			(typeof value === 'string' && value.trim() === '')
		) {
			missing.push({
				field,
				reason: 'REQUIRED_FIELD_MISSING',
				meta: { message: `O campo obrigatório '${field}' não foi informado.` },
			});
		}
	}

	if (missing.length > 0) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			'Campos obrigatórios ausentes na requisição.',
			{ invalidParams: missing },
		);
	}

	return record;
}

export function assertBodyObject(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			'Corpo da requisição deve ser um objeto JSON não-vazio.',
			{
				invalidParams: [{ field: 'body', reason: 'EMPTY_OR_INVALID_OBJECT' }],
			},
		);
	}

	return body as Record<string, unknown>;
}

export function assertRequiredParams(
	params: unknown,
	requiredKeys: readonly string[],
): Record<string, string> {
	if (!params || typeof params !== 'object' || Array.isArray(params)) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			'Parâmetros de rota ausentes ou inválidos.',
			{
				invalidParams: [{ field: 'params', reason: 'EXPECTED_ROUTE_PARAMS' }],
			},
		);
	}

	const record = params as Record<string, unknown>;
	const missing: InvalidParamDetail[] = [];
	const out: Record<string, string> = {};

	for (const key of requiredKeys) {
		const value = record[key];
		if (typeof value !== 'string' || value.trim() === '') {
			missing.push({
				field: key,
				reason: 'REQUIRED_PARAM_MISSING',
				meta: { message: `O parâmetro obrigatório '${key}' não foi informado.` },
			});
		} else {
			out[key] = value;
		}
	}

	if (missing.length > 0) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			'Parâmetros de rota obrigatórios ausentes.',
			{ invalidParams: missing },
		);
	}

	return out;
}

export function assertAuthorizedUser(
	user: AuthenticatedUser | null | undefined,
	allowedRoles?: readonly UserRole[],
): AuthenticatedUser {
	if (!user) {
		throw new DomainError('ERR_UNAUTHORIZED', 'Sessão de operador ausente ou inválida.');
	}

	if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
		throw new DomainError(
			'ERR_FORBIDDEN_ROLE',
			`O perfil '${user.role}' não possui permissão para executar esta operação.`,
		);
	}

	return user;
}

export function extractClientContext(request: FastifyRequest): RequestClientContext {
	const userAgentHeader = request.headers['user-agent'];
	return {
		ipAddress: request.ip,
		userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader,
		correlationId: request.correlationId,
	};
}
