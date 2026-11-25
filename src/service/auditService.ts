import type { DbExecutor } from '../config/dbConfig.js';
import auditRepository, { type RecordAuditParams } from '../repository/auditRepository.js';
import { AuditLogQuerySchema } from '../utils/validation/auditValidation.js';

class AuditService {
	// RF-31: Gravação append-only na trilha de auditoria (aceita transação externa ou conexão padrão)
	async record(params: RecordAuditParams, tx?: DbExecutor): Promise<void> {
		await auditRepository.insert(params, tx);
	}

	// OpenAPI Seção 3 (Módulo 8): Paginação keyset descendente sobre seq_id para performance constante
	async listAuditLogs(rawQuery: unknown) {
		const q = AuditLogQuerySchema.parse(rawQuery);
		const rows = await auditRepository.findPaginated({
			cursorSeqId: q.cursorSeqId,
			limit: q.limit,
			actorUserId: q.actorUserId,
			action: q.action,
			entityType: q.entityType,
			entityId: q.entityId,
			correlationId: q.correlationId,
			from: q.from ? new Date(q.from) : undefined,
			to: q.to ? new Date(q.to) : undefined,
		});

		const hasMore = rows.length > q.limit;
		const items = hasMore ? rows.slice(0, q.limit) : rows;
		const lastItem = items[items.length - 1];
		const nextCursorSeqId = hasMore && lastItem ? lastItem.seqId : null;

		return {
			items: items.map((r) => ({
				seqId: r.seqId,
				actorUserId: r.actorUserId,
				actor: r.actorUserId
					? {
							fullName: r.actorFullName ?? '',
							registrationCode: r.actorRegistrationCode ?? '',
						}
					: null,
				action: r.action,
				entityType: r.entityType,
				entityId: r.entityId,
				ipAddress: r.ipAddress,
				userAgent: r.userAgent,
				correlationId: r.correlationId,
				metadata: r.metadata,
				occurredAt: r.occurredAt.toISOString(),
			})),
			nextCursorSeqId,
		};
	}
}

export default new AuditService();
