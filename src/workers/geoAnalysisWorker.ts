import { type Job, UnrecoverableError, Worker } from 'bullmq';
import type { RasterType } from '../config/db/schema/enums.js';
import { withTransaction } from '../config/dbConfig.js';
import { env } from '../config/env.js';
import { logger } from '../config/loggerConfig.js';
import auditRepository from '../repository/auditRepository.js';
import runEventsRepository, {
	type GeoAnalysisJobPayload,
} from '../repository/runEventsRepository.js';
import runRepository, {
	type PersistRasterAssetInput,
} from '../repository/runRepository.js';
import { storageRepository } from '../repository/storageRepository.js';
import { runGeoCoreAnalysisPipeline } from '../utils/geo/core/geoCorePipeline.js';
import type { SafeFetchOptions } from '../utils/helpers/antiSsrfHttp.js';
import { DomainError } from '../utils/helpers/domainError.js';

const RASTER_TYPES: readonly RasterType[] = [
	't0_rgb',
	't1_rgb',
	't0_false_color',
	't1_false_color',
	'delta_ndvi_mask',
];

const STAGE_PROGRESS_META: Record<
	'fetching_bands' | 'processing_ndvi' | 'vectorizing',
	{ progressPct: number; step: string }
> = {
	fetching_bands: {
		progressPct: 25,
		step: 'Lendo bandas COG Sentinel-2 (T0/T1)',
	},
	processing_ndvi: {
		progressPct: 60,
		step: 'Calculando Delta-NDVI e aplicando máscara SCL',
	},
	vectorizing: {
		progressPct: 85,
		step: 'Vetorizando polígonos e gerando evidências PNG',
	},
};

export interface GeoAnalysisWorkerOptions {
	concurrency?: number;
	safeFetchOptions?: SafeFetchOptions;
}

export async function processGeoAnalysisJob(
	job: Job<GeoAnalysisJobPayload>,
	opts: { safeFetchOptions?: SafeFetchOptions } = {},
): Promise<void> {
	const { runId, correlationId } = job.data;

	const ctx = await runRepository.findWorkerExecutionContext(runId);
	if (!ctx) {
		logger.warn({ runId }, 'Job geo-analysis ignorado: runId inexistente no PostgreSQL.');
		return;
	}

	if (
		ctx.status === 'ready_for_review' ||
		ctx.status === 'frozen' ||
		ctx.status === 'failed'
	) {
		logger.info(
			{ runId, status: ctx.status },
			'Job geo-analysis ignorado de forma idempotente (execução já finalizada).',
		);
		return;
	}

	try {
		const t0Items = ctx.t0StacMetadata.items.map((item) => item.raw);
		const t1Items = ctx.t1StacMetadata.items.map((item) => item.raw);

		const pipelineResult = await runGeoCoreAnalysisPipeline({
			aoiGeoJson: ctx.aoiGeoJson,
			utmSrid: ctx.utmSrid,
			t0Provider: ctx.t0Provider,
			t0Items,
			t1Provider: ctx.t1Provider,
			t1Items,
			algorithmParams: ctx.algorithmParams,
			maxPixelsGuard: env.GEO_MAX_PIXELS_GUARD,
			safeFetchOptions: opts.safeFetchOptions,
			onStage: async (stage, detail) => {
				const stageMeta = STAGE_PROGRESS_META[stage];
				await runRepository.updateRunProcessingStage(runId, stage);
				await runEventsRepository.publishEvent(runId, 'progress', {
					runId,
					status: stage,
					step: stageMeta.step,
					progressPct: stageMeta.progressPct,
					message: detail,
					timestamp: new Date().toISOString(),
				});
			},
		});

		const uploadedRasters: PersistRasterAssetInput[] = await Promise.all(
			RASTER_TYPES.map(async (assetType) => {
				const rendered = pipelineResult.postClassification.rasterEvidences.rasters[assetType];
				const key = storageRepository.buildRasterStorageKey(ctx.caseId, runId, assetType);
				const stored = await storageRepository.putPrivateObject({
					key,
					body: rendered.buffer,
					contentType: rendered.mimeType,
					sha256Hex: rendered.sha256,
					metadata: {
						caseId: ctx.caseId,
						runId,
						assetType,
					},
				});

				return {
					assetType,
					storageBucket: stored.bucket,
					storageKey: stored.key,
					mimeType: rendered.mimeType,
					sizeBytes: rendered.sizeBytes,
					sha256: stored.sha256,
					widthPx: rendered.widthPx,
					heightPx: rendered.heightPx,
					bounds4674: rendered.bounds4674,
				};
			}),
		);

		const summary = await withTransaction(async (tx) => {
			const completed = await runRepository.completeRunInTransaction(
				{
					runId,
					utmSrid: ctx.utmSrid,
					aoiAreaHa: ctx.aoiAreaHa,
					aoiTotalPixels: pipelineResult.postClassification.filteredMetrics.aoiTotalPixels,
					cloudMaskedPixels: pipelineResult.postClassification.filteredMetrics.cloudMaskedPixels,
					rasters: uploadedRasters,
					features: pipelineResult.postClassification.features,
				},
				tx,
			);

			await auditRepository.insert(
				{
					actorUserId: ctx.executedBy,
					action: 'run_completed',
					entityType: 'analysis_run',
					entityId: runId,
					correlationId,
					metadata: {
						caseId: ctx.caseId,
						engineVersion: pipelineResult.engineVersion,
						...completed,
					},
				},
				tx,
			);

			return completed;
		});

		await runEventsRepository.publishEvent(runId, 'run.ready_for_review', {
			runId,
			status: 'ready_for_review',
			summary: {
				deforestationHa: summary.deforestationHa,
				degradationHa: summary.degradationHa,
				regrowthHa: summary.regrowthHa,
				cloudMaskedHa: summary.cloudMaskedHa,
				featureCount: summary.featureCount,
			},
		});
	} catch (err) {
		const isDomain4xx =
			err instanceof DomainError && err.statusCode >= 400 && err.statusCode < 500;
		const errorCode =
			err instanceof DomainError ? err.errorCode : 'ERR_INTERNAL_SERVER_ERROR';
		const safeMessage =
			err instanceof DomainError
				? err.message
				: 'Falha inesperada durante o processamento multitemporal geo-core.';

		const maxAttempts = job.opts.attempts ?? 1;
		const isFinalAttempt = isDomain4xx || job.attemptsMade + 1 >= maxAttempts;

		logger.error(
			{
				runId,
				attempt: job.attemptsMade + 1,
				maxAttempts,
				isFinalAttempt,
				errorCode,
				err,
			},
			'Erro ao processar job geo-analysis',
		);

		if (isFinalAttempt) {
			await withTransaction(async (tx) => {
				await runRepository.markRunFailed(runId, errorCode, safeMessage, tx);
				await auditRepository.insert(
					{
						actorUserId: ctx.executedBy,
						action: 'run_failed',
						entityType: 'analysis_run',
						entityId: runId,
						correlationId,
						metadata: {
							caseId: ctx.caseId,
							errorCode,
							errorDetail: safeMessage,
						},
					},
					tx,
				);
			});

			await runEventsRepository.publishEvent(runId, 'run.failed', {
				runId,
				status: 'failed',
				errorCode,
				message: safeMessage,
			});
		}

		if (isDomain4xx) {
			throw new UnrecoverableError(safeMessage);
		}
		throw err;
	}
}

export function startGeoAnalysisWorker(
	opts: GeoAnalysisWorkerOptions = {},
): Worker<GeoAnalysisJobPayload> {
	const worker = new Worker<GeoAnalysisJobPayload>(
		'geo-analysis',
		async (job) => processGeoAnalysisJob(job, { safeFetchOptions: opts.safeFetchOptions }),
		{
			connection: {
				url: env.REDIS_URL,
				maxRetriesPerRequest: null,
			},
			concurrency: opts.concurrency ?? 2,
		},
	);

	worker.on('failed', (job, err) => {
		logger.error(
			{ jobId: job?.id, runId: job?.data?.runId, err: err.message },
			'Worker geo-analysis registrou falha no job.',
		);
	});

	return worker;
}
