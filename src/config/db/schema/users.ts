import { AnyPgColumn, boolean, char, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { inetType } from '../customTypes.js';
import { userRoleEnum } from './enums.js';

export const users = pgTable('users', {
	id: uuid('id').primaryKey().defaultRandom(),
	fullName: text('full_name').notNull(),
	registrationCode: text('registration_code').notNull().unique(),
	email: text('email').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	role: userRoleEnum('role').notNull().default('analyst'),
	active: boolean('active').notNull().default(true),
	lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable('refresh_tokens', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'restrict' }),
	familyId: uuid('family_id').notNull(),
	tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
	replacedById: uuid('replaced_by_id').references((): AnyPgColumn => refreshTokens.id),
	userAgent: text('user_agent'),
	ipAddress: inetType('ip_address'),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
