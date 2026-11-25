import { withTransaction } from '../config/dbConfig.js';
import type { UserRole } from '../config/db/schema/enums.js';
import refreshTokenRepository from '../repository/refreshTokenRepository.js';
import userRepository, { type PublicUserRow } from '../repository/userRepository.js';
import { hashPassword } from '../utils/helpers/crypto.js';
import { DomainError } from '../utils/helpers/domainError.js';
import type { RequestClientContext } from '../utils/helpers/requestGuard.js';
import { sanitizePlainText } from '../utils/helpers/sanitizer.js';
import {
	CreateUserBodySchema,
	ListUsersQuerySchema,
	UpdateUserBodySchema,
	UpdateUserParamsSchema,
} from '../utils/validation/userValidation.js';
import auditService from './auditService.js';

function mapUserRow(u: PublicUserRow) {
	return {
		id: u.id,
		fullName: u.fullName,
		registrationCode: u.registrationCode,
		email: u.email,
		role: u.role,
		active: u.active,
		lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
		createdAt: u.createdAt.toISOString(),
		updatedAt: u.updatedAt.toISOString(),
	};
}

class UserService {
	async listUsers(rawQuery: unknown) {
		const filters = ListUsersQuerySchema.parse(rawQuery);
		const rows = await userRepository.findAll(filters);
		return {
			items: rows.map(mapUserRow),
		};
	}

	async createUser(rawBody: unknown, actorUserId: string, ctx: RequestClientContext) {
		const input = CreateUserBodySchema.parse(rawBody);
		const passwordHash = await hashPassword(input.password);
		const cleanFullName = sanitizePlainText(input.fullName);
		const cleanRegCode = sanitizePlainText(input.registrationCode);
		const cleanEmail = input.email.trim().toLowerCase();

		const created = await withTransaction(async (tx) => {
			const inserted = await userRepository.create(
				{
					fullName: cleanFullName,
					registrationCode: cleanRegCode,
					email: cleanEmail,
					passwordHash,
					role: input.role,
				},
				tx,
			);

			await auditService.record(
				{
					actorUserId,
					action: 'user_created',
					entityType: 'user',
					entityId: inserted.id,
					ipAddress: ctx.ipAddress,
					userAgent: ctx.userAgent,
					correlationId: ctx.correlationId,
					metadata: {
						email: inserted.email,
						registrationCode: inserted.registrationCode,
						role: inserted.role,
					},
				},
				tx,
			);

			return inserted;
		});

		return mapUserRow(created);
	}

	// RF-03 & OpenAPI Seção 3: Ao desativar active=false, revoga imediatamente todos os refresh_tokens abertos
	async updateUser(
		rawParams: unknown,
		rawBody: unknown,
		actorUserId: string,
		ctx: RequestClientContext,
	) {
		const { userId: targetUserId } = UpdateUserParamsSchema.parse(rawParams);
		const input = UpdateUserBodySchema.parse(rawBody);

		if (targetUserId === actorUserId && input.active === false) {
			throw new DomainError(
				'ERR_VALIDATION_FAILED',
				'Um administrador não pode desativar a própria conta ativa.',
			);
		}

		const existing = await userRepository.findById(targetUserId);
		if (!existing) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Operador não encontrado.');
		}

		const updatePatch: Partial<{ fullName: string; role: UserRole; active: boolean }> = {};
		if (input.fullName !== undefined) {
			updatePatch.fullName = sanitizePlainText(input.fullName);
		}
		if (input.role !== undefined) {
			updatePatch.role = input.role;
		}
		if (input.active !== undefined) {
			updatePatch.active = input.active;
		}

		const isDeactivating = existing.active === true && input.active === false;

		const updated = await withTransaction(async (tx) => {
			const row = await userRepository.updateById(targetUserId, updatePatch, tx);
			if (!row) {
				throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Operador não encontrado.');
			}

			let revokedSessions = 0;
			if (input.active === false) {
				revokedSessions = await refreshTokenRepository.revokeOpenByUserId(targetUserId, tx);
			}

			await auditService.record(
				{
					actorUserId,
					action: isDeactivating ? 'user_deactivated' : 'user_updated',
					entityType: 'user',
					entityId: row.id,
					ipAddress: ctx.ipAddress,
					userAgent: ctx.userAgent,
					correlationId: ctx.correlationId,
					metadata: {
						changedFields: Object.keys(updatePatch),
						active: row.active,
						role: row.role,
						revokedSessions,
					},
				},
				tx,
			);

			return row;
		});

		return mapUserRow(updated);
	}
}

export default new UserService();
