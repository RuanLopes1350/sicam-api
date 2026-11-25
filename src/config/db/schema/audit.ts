import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { inetType } from '../customTypes.js';
import { auditActionEnum } from './enums.js';
import { users } from './users.js';

export const auditLogs = pgTable('audit_logs', {
	seqId: bigint('seq_id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
	actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
	action: auditActionEnum('action').notNull(),
	entityType: text('entity_type').notNull(),
	entityId: uuid('entity_id'),
	ipAddress: inetType('ip_address'),
	userAgent: text('user_agent'),
	correlationId: uuid('correlation_id').notNull(),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
	occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});
