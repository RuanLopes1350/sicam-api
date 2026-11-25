import { and, asc, eq, isNull, type SQL } from 'drizzle-orm';
import { type DbExecutor, getDb } from '../config/dbConfig.js';
import type { UserRole } from '../config/db/schema/enums.js';
import { users } from '../config/db/schema/users.js';
import { parseDatabaseError } from '../utils/helpers/dbErrors.js';

export interface PublicUserRow {
	id: string;
	fullName: string;
	registrationCode: string;
	email: string;
	role: UserRole;
	active: boolean;
	lastLoginAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

const publicUserColumns = {
	id: users.id,
	fullName: users.fullName,
	registrationCode: users.registrationCode,
	email: users.email,
	role: users.role,
	active: users.active,
	lastLoginAt: users.lastLoginAt,
	createdAt: users.createdAt,
	updatedAt: users.updatedAt,
};

class UserRepository {
	async findById(id: string, db: DbExecutor = getDb()): Promise<PublicUserRow | null> {
		try {
			const [found] = await db
				.select(publicUserColumns)
				.from(users)
				.where(eq(users.id, id))
				.limit(1);
			return found ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'UserRepository.findById');
		}
	}

	async findByEmailWithHash(email: string, db: DbExecutor = getDb()) {
		try {
			const [found] = await db
				.select()
				.from(users)
				.where(eq(users.email, email))
				.limit(1);
			return found ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'UserRepository.findByEmailWithHash');
		}
	}

	async findAll(
		filters: { role?: UserRole; active?: boolean },
		db: DbExecutor = getDb(),
	): Promise<PublicUserRow[]> {
		try {
			const conditions: SQL[] = [];
			if (filters.role) {
				conditions.push(eq(users.role, filters.role));
			}
			if (filters.active !== undefined) {
				conditions.push(eq(users.active, filters.active));
			}

			return await db
				.select(publicUserColumns)
				.from(users)
				.where(conditions.length > 0 ? and(...conditions) : undefined)
				.orderBy(asc(users.fullName));
		} catch (error) {
			throw parseDatabaseError(error, 'UserRepository.findAll');
		}
	}

	async create(
		data: {
			fullName: string;
			registrationCode: string;
			email: string;
			passwordHash: string;
			role: UserRole;
		},
		db: DbExecutor = getDb(),
	): Promise<PublicUserRow> {
		try {
			const [created] = await db
				.insert(users)
				.values({
					fullName: data.fullName,
					registrationCode: data.registrationCode,
					email: data.email,
					passwordHash: data.passwordHash,
					role: data.role,
					active: true,
				})
				.returning(publicUserColumns);

			if (!created) {
				throw new Error('Falha ao criar operador no banco de dados.');
			}
			return created;
		} catch (error) {
			throw parseDatabaseError(error, 'UserRepository.create');
		}
	}

	async updateById(
		id: string,
		patch: Partial<{ fullName: string; role: UserRole; active: boolean }>,
		db: DbExecutor = getDb(),
	): Promise<PublicUserRow | null> {
		try {
			const [updated] = await db
				.update(users)
				.set(patch)
				.where(eq(users.id, id))
				.returning(publicUserColumns);
			return updated ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'UserRepository.updateById');
		}
	}

	async touchLastLogin(id: string, at: Date, db: DbExecutor = getDb()): Promise<void> {
		try {
			await db.update(users).set({ lastLoginAt: at }).where(eq(users.id, id));
		} catch (error) {
			throw parseDatabaseError(error, 'UserRepository.touchLastLogin');
		}
	}

	async findActiveById(id: string, db: DbExecutor = getDb()): Promise<PublicUserRow | null> {
		try {
			const [found] = await db
				.select(publicUserColumns)
				.from(users)
				.where(and(eq(users.id, id), eq(users.active, true)))
				.limit(1);
			return found ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'UserRepository.findActiveById');
		}
	}

	// Mantido apenas para consultas internas pontuais onde isNull possa ser útil
	async existsByEmail(email: string, db: DbExecutor = getDb()): Promise<boolean> {
		try {
			const [found] = await db
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.email, email), isNull(users.lastLoginAt)))
				.limit(1);
			return Boolean(found);
		} catch (error) {
			throw parseDatabaseError(error, 'UserRepository.existsByEmail');
		}
	}
}

export default new UserRepository();
