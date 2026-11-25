import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env.js';

let redisClient: Redis | null = null;
let geoAnalysisQueue: Queue | null = null;
let cartographyExportQueue: Queue | null = null;

export function getRedis(): Redis {
	if (!redisClient) {
		redisClient = new Redis(env.REDIS_URL, {
			maxRetriesPerRequest: null,
			enableReadyCheck: true,
		});
	}
	return redisClient;
}

export function createRedisSubscriber(): Redis {
	return new Redis(env.REDIS_URL, {
		maxRetriesPerRequest: null,
		enableReadyCheck: true,
	});
}

// ADR-10: Filas separadas para análise matricial COG e renderização cartográfica Playwright
export function getGeoAnalysisQueue(): Queue {
	if (!geoAnalysisQueue) {
		geoAnalysisQueue = new Queue('geo-analysis', {
			connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
			defaultJobOptions: {
				attempts: 2,
				backoff: { type: 'exponential', delay: 3000 },
				removeOnComplete: 100,
				removeOnFail: 200,
			},
		});
	}
	return geoAnalysisQueue;
}

export function getCartographyExportQueue(): Queue {
	if (!cartographyExportQueue) {
		cartographyExportQueue = new Queue('cartography-export', {
			connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
			defaultJobOptions: {
				attempts: 2,
				backoff: { type: 'exponential', delay: 3000 },
				removeOnComplete: 100,
				removeOnFail: 200,
			},
		});
	}
	return cartographyExportQueue;
}

export async function checkRedisReadiness(): Promise<boolean> {
	const pong = await getRedis().ping();
	return pong === 'PONG';
}

export async function closeRedis(): Promise<void> {
	if (geoAnalysisQueue) {
		await geoAnalysisQueue.close();
		geoAnalysisQueue = null;
	}
	if (cartographyExportQueue) {
		await cartographyExportQueue.close();
		cartographyExportQueue = null;
	}
	if (redisClient) {
		await redisClient.quit();
		redisClient = null;
	}
}
