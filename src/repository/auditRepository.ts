import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import { type DbExecutor, getDb } from '../config/dbConfig.js';
import { auditLogs } from '../config/db/schema/audit.js';
import type { AuditAction } from '../config/db/schema/enums.js';
import { users } from '../config/db/schema/users.js';
import { parseDatabaseError } from '../utils/helpers/dbErrors.js';

export interface RecordAuditParams {
	actorUserId?: string | null;
	action: AuditAction;
	entityType: string;
	entityId?: string | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	correlationId: string;
	metadata?: Record<string, unknown>;
}

export interface ListAuditLogsFilter {
	cursorSeqId?: number;
	limit: number;
	actorUserId?: string;
	action?: AuditAction;
	entityType?: string;
	entityId?: string;
	correlationId?: string;
	from?: Date;
	to?: Date;
}

function sanitizeIpForInet(ip?: string | null): string | null {
	if (!ip) return null;
	const cleaned = ip.trim();
	return cleaned.length > 0 ? cleaned : null;
}

class AuditRepository {
	async insert(params: RecordAuditParams, db: DbExecutor = getDb()): Promise<void> {
		try {
			await db.insert(auditLogs).values({
				actorUserId: params.actorUserId ?? null,
				action: params.action,
				entityType: params.entityType,
				entityId: params.entityId ?? null,
				ipAddress: sanitizeIpForInet(params.ipAddress),
				userAgent: params.userAgent ?? null,
				correlationId: params.correlationId,
				metadata: params.metadata ?? {},
			});
		} catch (error) {
			throw parseDatabaseError(error, 'AuditRepository.insert');
		}
	}

	async findPaginated(filter: ListAuditLogsFilter, db: DbExecutor = getDb()) {
		try {
			const conditions: SQL[] = [];

			if (filter.cursorSeqId !== undefined) {
				conditions.push(lt(auditLogs.seqId, filter.cursorSeqId));
			}
			if (filter.actorUserId) {
				conditions.push(eq(auditLogs.actorUserId, filter.actorUserId));
			}
			if (filter.action) {
				conditions.push(eq(auditLogs.action, filter.action));
			}
			if (filter.entityType) {
				conditions.push(eq(auditLogs.entityType, filter.entityType));
			}
			if (filter.entityId) {
				conditions.push(eq(auditLogs.entityId, filter.entityId));
			}
			if (filter.correlationId) {
				conditions.push(eq(auditLogs.correlationId, filter.correlationId));
			}
			if (filter.from) {
				conditions.push(gte(auditLogs.occurredAt, filter.from));
			}
			if (filter.to) {
				conditions.push(lte(auditLogs.occurredAt, filter.to));
			}

			return await db
				.select({
					seqId: auditLogs.seqId,
					actorUserId: auditLogs.actorUserId,
					actorFullName: users.fullName,
					actorRegistrationCode: users.registrationCode,
					action: auditLogs.action,
					entityType: auditLogs.entityType,
					entityId: auditLogs.entityId,
					ipAddress: auditLogs.ipAddress,
					userAgent: auditLogs.userAgent,
					correlationId: auditLogs.correlationId,
					metadata: auditLogs.metadata,
					occurredAt: auditLogs.occurredAt,
				})
				.from(auditLogs)
				.leftJoin(users, eq(auditLogs.actorUserId, users.id))
				.where(conditions.length > 0 ? and(...conditions) : undefined)
				.orderBy(desc(auditLogs.seqId))
				.limit(filter.limit + 1);
		} catch (error) {
			throw parseDatabaseError(error, 'AuditRepository.findPaginated');
		}
	}
}

export default new AuditRepository();
