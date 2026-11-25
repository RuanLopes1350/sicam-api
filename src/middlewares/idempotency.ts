import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRedis } from '../config/redisConfig.js';
import { sha256Hex } from '../utils/helpers/crypto.js';
import { DomainError } from '../utils/helpers/domainError.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24h

interface CachedIdempotentRecord {
	payloadHash: string;
	statusCode: number;
	body: unknown;
}

// OpenAPI Seção 1.1: Idempotency-Key obrigatório em disparos assíncronos (24h no Redis vinculado a userId + hash do payload)
export async function checkIdempotencyOrReplay(
	request: FastifyRequest,
	reply: FastifyReply,
	scope: string,
): Promise<{ redisKey: string; payloadHash: string; replayed: boolean }> {
	const headerVal = request.headers['idempotency-key'];
	const rawKey = Array.isArray(headerVal) ? headerVal[0] : headerVal;

	if (!rawKey || !UUID_V4_REGEX.test(rawKey.trim())) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			'O cabeçalho Idempotency-Key (UUID v4) é obrigatório para esta operação.',
			{
				invalidParams: [{ field: 'Idempotency-Key', reason: 'REQUIRED_UUID_V4' }],
			},
		);
	}

	const userId = request.authUser?.id ?? 'anonymous';
	const normalizedKey = rawKey.trim().toLowerCase();
	const redisKey = `sicam:idemp:${scope}:${userId}:${normalizedKey}`;
	const payloadHash = sha256Hex(JSON.stringify(request.body ?? null));

	const redis = getRedis();
	const existingRaw = await redis.get(redisKey);

	if (existingRaw) {
		const existing = JSON.parse(existingRaw) as CachedIdempotentRecord;
		if (existing.payloadHash !== payloadHash) {
			throw new DomainError(
				'ERR_IDEMPOTENCY_CONFLICT',
				'A chave Idempotency-Key informada já foi utilizada com parâmetros diferentes.',
			);
		}
		reply.code(existing.statusCode).send(existing.body);
		return { redisKey, payloadHash, replayed: true };
	}

	return { redisKey, payloadHash, replayed: false };
}

export async function saveIdempotencyResponse(
	redisKey: string,
	payloadHash: string,
	statusCode: number,
	body: unknown,
): Promise<void> {
	const record: CachedIdempotentRecord = { payloadHash, statusCode, body };
	await getRedis().set(redisKey, JSON.stringify(record), 'EX', IDEMPOTENCY_TTL_SECONDS);
}
