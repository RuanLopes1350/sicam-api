import { z } from 'zod';
import { auditActionEnum } from '../../config/db/schema/enums.js';

export const AuditLogQuerySchema = z
	.object({
		cursorSeqId: z.coerce.number().int().positive().optional(),
		limit: z.coerce.number().int().min(1).max(100).default(50),
		actorUserId: z.string().uuid().optional(),
		action: z.enum(auditActionEnum.enumValues).optional(),
		entityType: z.string().min(1).max(64).optional(),
		entityId: z.string().uuid().optional(),
		correlationId: z.string().uuid().optional(),
		from: z.string().datetime().optional(),
		to: z.string().datetime().optional(),
	})
	.strict();

export const AuditLogItemSchema = z
	.object({
		seqId: z.number().int(),
		actorUserId: z.string().uuid().nullable(),
		actor: z
			.object({
				fullName: z.string(),
				registrationCode: z.string(),
			})
			.strict()
			.nullable(),
		action: z.enum(auditActionEnum.enumValues),
		entityType: z.string(),
		entityId: z.string().uuid().nullable(),
		ipAddress: z.string().nullable(),
		userAgent: z.string().nullable(),
		correlationId: z.string().uuid(),
		metadata: z.record(z.unknown()),
		occurredAt: z.string().datetime(),
	})
	.strict();

export const AuditLogResponseSchema = z
	.object({
		items: z.array(AuditLogItemSchema),
		nextCursorSeqId: z.number().int().nullable(),
	})
	.strict();

export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;
