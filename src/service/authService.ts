import { randomUUID } from 'node:crypto';
import { withTransaction } from '../config/dbConfig.js';
import { env } from '../config/env.js';
import refreshTokenRepository from '../repository/refreshTokenRepository.js';
import userRepository from '../repository/userRepository.js';
import {
	generateRefreshTokenSecret,
	sha256Hex,
	signAccessToken,
	verifyDummyPassword,
	verifyPassword,
} from '../utils/helpers/crypto.js';
import { DomainError } from '../utils/helpers/domainError.js';
import type { RequestClientContext } from '../utils/helpers/requestGuard.js';
import { LoginBodySchema } from '../utils/validation/authValidation.js';
import auditService from './auditService.js';

export const REFRESH_COOKIE_NAME = 'refresh_token';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

class AuthService {
	async login(rawBody: unknown, ctx: RequestClientContext) {
		const input = LoginBodySchema.parse(rawBody);
		const email = input.email.trim().toLowerCase();

		const user = await userRepository.findByEmailWithHash(email);

		if (!user) {
			await verifyDummyPassword(input.password);
			await auditService.record({
				actorUserId: null,
				action: 'auth_login_failed',
				entityType: 'user',
				entityId: null,
				ipAddress: ctx.ipAddress,
				userAgent: ctx.userAgent,
				correlationId: ctx.correlationId,
				metadata: { reason: 'USER_NOT_FOUND' },
			});
			throw new DomainError('ERR_UNAUTHORIZED', 'Credenciais inválidas ou conta desativada.');
		}

		const passwordValid = await verifyPassword(user.passwordHash, input.password);
		if (!passwordValid || !user.active) {
			await auditService.record({
				actorUserId: user.id,
				action: 'auth_login_failed',
				entityType: 'user',
				entityId: user.id,
				ipAddress: ctx.ipAddress,
				userAgent: ctx.userAgent,
				correlationId: ctx.correlationId,
				metadata: { reason: !user.active ? 'USER_INACTIVE' : 'INVALID_PASSWORD' },
			});
			throw new DomainError('ERR_UNAUTHORIZED', 'Credenciais inválidas ou conta desativada.');
		}

		const { rawToken, tokenHash } = generateRefreshTokenSecret();
		const familyId = randomUUID();
		const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

		await withTransaction(async (tx) => {
			await userRepository.touchLastLogin(user.id, new Date(), tx);

			await refreshTokenRepository.create(
				{
					userId: user.id,
					familyId,
					tokenHash,
					userAgent: ctx.userAgent ?? null,
					ipAddress: ctx.ipAddress,
					expiresAt,
				},
				tx,
			);

			await auditService.record(
				{
					actorUserId: user.id,
					action: 'auth_login_success',
					entityType: 'user',
					entityId: user.id,
					ipAddress: ctx.ipAddress,
					userAgent: ctx.userAgent,
					correlationId: ctx.correlationId,
					metadata: { familyId },
				},
				tx,
			);
		});

		const accessToken = await signAccessToken({
			sub: user.id,
			role: user.role,
			registrationCode: user.registrationCode,
		});

		return {
			rawRefreshToken: rawToken,
			refreshExpiresAt: expiresAt,
			response: {
				accessToken,
				expiresInSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
				user: {
					id: user.id,
					fullName: user.fullName,
					registrationCode: user.registrationCode,
					email: user.email,
					role: user.role,
				},
			},
		};
	}

	// OpenAPI Seção 3 (Módulo 1): Rotação estrita de Refresh Token + Detecção de Reuso por family_id
	async refresh(rawRefreshToken: string | undefined, ctx: RequestClientContext) {
		if (!rawRefreshToken || rawRefreshToken.trim().length < 16) {
			throw new DomainError(
				'ERR_UNAUTHORIZED',
				'Cookie de renovação de sessão ausente ou inválido.',
			);
		}

		const tokenHash = sha256Hex(rawRefreshToken.trim());
		const storedToken = await refreshTokenRepository.findByTokenHash(tokenHash);

		if (!storedToken) {
			throw new DomainError('ERR_UNAUTHORIZED', 'Sessão de renovação não reconhecida.');
		}

		// Reuso de token já rotacionado ou revogado: revoga TODA a cadeia family_id!
		if (storedToken.replacedById !== null || storedToken.revokedAt !== null) {
			await withTransaction(async (tx) => {
				await refreshTokenRepository.revokeOpenByFamilyId(storedToken.familyId, tx);
				await auditService.record(
					{
						actorUserId: storedToken.userId,
						action: 'auth_token_reuse_detected',
						entityType: 'refresh_token_family',
						entityId: storedToken.familyId,
						ipAddress: ctx.ipAddress,
						userAgent: ctx.userAgent,
						correlationId: ctx.correlationId,
						metadata: { reusedTokenId: storedToken.id },
					},
					tx,
				);
			});

			throw new DomainError(
				'ERR_TOKEN_REUSE_DETECTED',
				'Tentativa de reutilização de Refresh Token já rotacionado detectada. Toda a família de sessão foi revogada.',
			);
		}

		if (storedToken.expiresAt.getTime() <= Date.now()) {
			await refreshTokenRepository.revokeById(storedToken.id);
			throw new DomainError('ERR_UNAUTHORIZED', 'Sessão expirada. Realize novo login.');
		}

		const user = await userRepository.findById(storedToken.userId);
		if (!user || !user.active) {
			await refreshTokenRepository.revokeOpenByFamilyId(storedToken.familyId);
			throw new DomainError('ERR_UNAUTHORIZED', 'Operador inexistente ou desativado.');
		}

		const { rawToken: nextRawToken, tokenHash: nextTokenHash } = generateRefreshTokenSecret();
		const nextExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

		await withTransaction(async (tx) => {
			const insertedNext = await refreshTokenRepository.create(
				{
					userId: user.id,
					familyId: storedToken.familyId,
					tokenHash: nextTokenHash,
					userAgent: ctx.userAgent ?? null,
					ipAddress: ctx.ipAddress,
					expiresAt: nextExpiresAt,
				},
				tx,
			);

			await refreshTokenRepository.markRotated(storedToken.id, insertedNext.id, tx);
		});

		const accessToken = await signAccessToken({
			sub: user.id,
			role: user.role,
			registrationCode: user.registrationCode,
		});

		return {
			rawRefreshToken: nextRawToken,
			refreshExpiresAt: nextExpiresAt,
			response: {
				accessToken,
				expiresInSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
				user: {
					id: user.id,
					fullName: user.fullName,
					registrationCode: user.registrationCode,
					email: user.email,
					role: user.role,
				},
			},
		};
	}

	async logout(
		rawRefreshToken: string | undefined,
		actorUserId: string,
		ctx: RequestClientContext,
	): Promise<{ revoked: boolean }> {
		await withTransaction(async (tx) => {
			let revokedTokenId: string | null = null;
			if (rawRefreshToken && rawRefreshToken.trim().length > 0) {
				const tokenHash = sha256Hex(rawRefreshToken.trim());
				revokedTokenId = await refreshTokenRepository.revokeOpenByTokenHash(tokenHash, tx);
			}

			await auditService.record(
				{
					actorUserId,
					action: 'auth_token_revoked',
					entityType: 'user',
					entityId: actorUserId,
					ipAddress: ctx.ipAddress,
					userAgent: ctx.userAgent,
					correlationId: ctx.correlationId,
					metadata: { revokedTokenId },
				},
				tx,
			);
		});

		return { revoked: true };
	}
}

export default new AuthService();
