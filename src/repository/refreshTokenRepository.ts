import { and, eq, isNull } from 'drizzle-orm';
import { type DbExecutor, getDb } from '../config/dbConfig.js';
import { refreshTokens } from '../config/db/schema/users.js';
import { parseDatabaseError } from '../utils/helpers/dbErrors.js';

export interface CreateRefreshTokenInput {
	userId: string;
	familyId: string;
	tokenHash: string;
	userAgent: string | null;
	ipAddress: string;
	expiresAt: Date;
}

class RefreshTokenRepository {
	async create(
		data: CreateRefreshTokenInput,
		db: DbExecutor = getDb(),
	): Promise<{ id: string }> {
		try {
			const [inserted] = await db
				.insert(refreshTokens)
				.values({
					userId: data.userId,
					familyId: data.familyId,
					tokenHash: data.tokenHash,
					userAgent: data.userAgent,
					ipAddress: data.ipAddress,
					expiresAt: data.expiresAt,
				})
				.returning({ id: refreshTokens.id });

			if (!inserted) {
				throw new Error('Falha ao persistir refresh token.');
			}
			return inserted;
		} catch (error) {
			throw parseDatabaseError(error, 'RefreshTokenRepository.create');
		}
	}

	async findByTokenHash(tokenHash: string, db: DbExecutor = getDb()) {
		try {
			const [found] = await db
				.select()
				.from(refreshTokens)
				.where(eq(refreshTokens.tokenHash, tokenHash))
				.limit(1);
			return found ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'RefreshTokenRepository.findByTokenHash');
		}
	}

	async revokeById(
		id: string,
		revokedAt: Date = new Date(),
		db: DbExecutor = getDb(),
	): Promise<void> {
		try {
			await db
				.update(refreshTokens)
				.set({ revokedAt })
				.where(eq(refreshTokens.id, id));
		} catch (error) {
			throw parseDatabaseError(error, 'RefreshTokenRepository.revokeById');
		}
	}

	async revokeOpenByTokenHash(
		tokenHash: string,
		db: DbExecutor = getDb(),
	): Promise<string | null> {
		try {
			const [revoked] = await db
				.update(refreshTokens)
				.set({ revokedAt: new Date() })
				.where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
				.returning({ id: refreshTokens.id });
			return revoked?.id ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'RefreshTokenRepository.revokeOpenByTokenHash');
		}
	}

	async revokeOpenByFamilyId(familyId: string, db: DbExecutor = getDb()): Promise<number> {
		try {
			const revoked = await db
				.update(refreshTokens)
				.set({ revokedAt: new Date() })
				.where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
				.returning({ id: refreshTokens.id });
			return revoked.length;
		} catch (error) {
			throw parseDatabaseError(error, 'RefreshTokenRepository.revokeOpenByFamilyId');
		}
	}

	async revokeOpenByUserId(userId: string, db: DbExecutor = getDb()): Promise<number> {
		try {
			const revoked = await db
				.update(refreshTokens)
				.set({ revokedAt: new Date() })
				.where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
				.returning({ id: refreshTokens.id });
			return revoked.length;
		} catch (error) {
			throw parseDatabaseError(error, 'RefreshTokenRepository.revokeOpenByUserId');
		}
	}

	async markRotated(
		oldTokenId: string,
		newTokenId: string,
		db: DbExecutor = getDb(),
	): Promise<void> {
		try {
			await db
				.update(refreshTokens)
				.set({
					revokedAt: new Date(),
					replacedById: newTokenId,
				})
				.where(eq(refreshTokens.id, oldTokenId));
		} catch (error) {
			throw parseDatabaseError(error, 'RefreshTokenRepository.markRotated');
		}
	}
}

export default new RefreshTokenRepository();
