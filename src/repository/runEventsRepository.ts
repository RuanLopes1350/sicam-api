import type { PaperFormat } from '../config/db/schema/enums.js';
import { logger } from '../config/loggerConfig.js';
import {
	createRedisSubscriber,
	getCartographyExportQueue,
	getGeoAnalysisQueue,
	getRedis,
} from '../config/redisConfig.js';
import { DomainError } from '../utils/helpers/domainError.js';

export type SseEventName =
	| 'snapshot'
	| 'progress'
	| 'run.ready_for_review'
	| 'export.frozen'
	| 'run.failed'
	| 'export.failed';

export interface PublishedSseEnvelope {
	id: string;
	event: SseEventName;
	data: Record<string, unknown>;
}

export interface GeoAnalysisJobPayload {
	runId: string;
	caseId: string;
	correlationId: string;
}

export interface CartographyExportJobPayload {
	runId: string;
	caseId: string;
	paperFormat: PaperFormat;
	observations: string | null;
	requestedByUserId: string;
	correlationId: string;
}

const TERMINAL_SSE_EVENTS = new Set<SseEventName>([
	'run.ready_for_review',
	'export.frozen',
	'run.failed',
	'export.failed',
]);

export function isTerminalSseEvent(event: SseEventName): boolean {
	return TERMINAL_SSE_EVENTS.has(event);
}

// Camada Repository ("Estoquista"): acesso exclusivo a filas BullMQ e Pub/Sub Redis para SSE
export class RunEventsRepository {
	private seq = 0;
	private readonly activeSseByUser = new Map<string, number>();

	getRunChannelName(runId: string): string {
		return `run:events:${runId}`;
	}

	nextEventId(): string {
		this.seq += 1;
		return `${Date.now()}-${this.seq}`;
	}

	formatSseFrame(id: string, event: SseEventName, data: Record<string, unknown>): string {
		return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	}

	async enqueueGeoAnalysisJob(jobData: GeoAnalysisJobPayload): Promise<string> {
		const queue = getGeoAnalysisQueue();
		const job = await queue.add('analyze-multitemporal', jobData, {
			jobId: jobData.runId,
		});
		return String(job.id ?? jobData.runId);
	}

	async enqueueCartographyExportJob(jobData: CartographyExportJobPayload): Promise<string> {
		const queue = getCartographyExportQueue();
		const job = await queue.add('build-technical-package', jobData, {
			jobId: `export-${jobData.runId}-${Date.now()}`,
		});
		return String(job.id ?? jobData.runId);
	}

	async publishEvent(
		runId: string,
		event: SseEventName,
		data: Record<string, unknown>,
	): Promise<PublishedSseEnvelope> {
		const envelope: PublishedSseEnvelope = {
			id: this.nextEventId(),
			event,
			data,
		};
		await getRedis().publish(this.getRunChannelName(runId), JSON.stringify(envelope));
		return envelope;
	}

	async subscribeRunChannel(
		runId: string,
		onEnvelope: (envelope: PublishedSseEnvelope) => void,
	): Promise<{ close: () => Promise<void> }> {
		const channel = this.getRunChannelName(runId);
		const subscriber = createRedisSubscriber();

		subscriber.on('message', (incomingChannel: string, rawMessage: string) => {
			if (incomingChannel !== channel) {
				return;
			}
			try {
				const parsed = JSON.parse(rawMessage) as PublishedSseEnvelope;
				if (parsed && typeof parsed.event === 'string' && parsed.data) {
					onEnvelope(parsed);
				}
			} catch (err) {
				logger.warn({ err, channel }, 'Mensagem SSE malformada recebida no canal Redis.');
			}
		});

		await subscriber.subscribe(channel);

		let closed = false;
		return {
			close: async () => {
				if (closed) return;
				closed = true;
				try {
					await subscriber.unsubscribe(channel);
				} catch {
					// Ignora se já desconectado
				}
				try {
					await subscriber.quit();
				} catch {
					subscriber.disconnect();
				}
			},
		};
	}

	// OpenAPI Seção 2: Limite de 10 conexões SSE simultâneas por operador
	acquireUserSseSlot(userId: string, maxConnections = 10): () => void {
		const current = this.activeSseByUser.get(userId) ?? 0;
		if (current >= maxConnections) {
			throw new DomainError(
				'ERR_RATE_LIMIT_EXCEEDED',
				`Limite máximo de ${maxConnections} conexões SSE simultâneas atingido para este operador.`,
			);
		}
		this.activeSseByUser.set(userId, current + 1);

		let released = false;
		return () => {
			if (released) return;
			released = true;
			const count = this.activeSseByUser.get(userId) ?? 0;
			if (count <= 1) {
				this.activeSseByUser.delete(userId);
			} else {
				this.activeSseByUser.set(userId, count - 1);
			}
		};
	}

	getActiveSseCount(userId: string): number {
		return this.activeSseByUser.get(userId) ?? 0;
	}
}

export default new RunEventsRepository();
