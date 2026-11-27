import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { withTransaction } from '../config/dbConfig.js';
import { env } from '../config/env.js';
import { logger } from '../config/loggerConfig.js';
import auditRepository from '../repository/auditRepository.js';
import cartographyRepository from '../repository/cartographyRepository.js';
import exportRepository from '../repository/exportRepository.js';
import runEventsRepository, {
	type CartographyExportJobPayload,
} from '../repository/runEventsRepository.js';
import runRepository from '../repository/runRepository.js';
import { storageRepository } from '../repository/storageRepository.js';
import { buildRunTechnicalPackage } from '../utils/geo/cartography/technicalPackagePipeline.js';
import { DomainError } from '../utils/helpers/domainError.js';

export interface CartographyExportWorkerOptions {
	concurrency?: number;
}

export async function processCartographyExportJob(
	job: Job<CartographyExportJobPayload>,
): Promise<void> {
	const {
		runId,
		paperFormat,
		observations,
		t0WaybackReleaseNum,
		t1WaybackReleaseNum,
		requestedByUserId,
		correlationId,
	} = job.data;

	const snap = await runRepository.findSnapshotById(runId);
	if (!snap) {
		logger.warn(
			{ runId },
			'Job cartography-export ignorado: runId inexistente no PostgreSQL.',
		);
		return;
	}

	if (snap.status === 'frozen' || snap.status === 'failed') {
		logger.info(
			{ runId, status: snap.status },
			'Job cartography-export ignorado de forma idempotente (execução já finalizada ou congelada).',
		);
		return;
	}

	try {
		await runEventsRepository.publishEvent(runId, 'progress', {
			runId,
			status: 'exporting',
			step: 'Compilando dados vetoriais, CSV e manifesto de custódia',
			progressPct: 25,
			timestamp: new Date().toISOString(),
		});

		let issuer = await exportRepository.findIssuerById(requestedByUserId);
		if (!issuer) {
			const fallbackBundle = await cartographyRepository.findCartographyRunBundle(runId);
			if (!fallbackBundle) {
				throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
			}
			issuer = fallbackBundle.executor;
		}

		const pkg = await buildRunTechnicalPackage({
			runId,
			paperFormat,
			observations,
			t0WaybackReleaseNum,
			t1WaybackReleaseNum,
			issuer,
			onProgress: async (progressPct, step) => {
				await runEventsRepository.publishEvent(runId, 'progress', {
					runId,
					status: 'exporting',
					step,
					progressPct,
					timestamp: new Date().toISOString(),
				});
			},
		});

		const pdfKey = storageRepository.buildExportPdfStorageKey(
			pkg.bundle.caseId,
			runId,
			pkg.bundle.protocolCode,
			pkg.bundle.version,
		);
		const zipKey = storageRepository.buildExportZipStorageKey(
			pkg.bundle.caseId,
			runId,
			pkg.bundle.protocolCode,
			pkg.bundle.version,
		);

		const [storedPdf, storedZip] = await Promise.all([
			storageRepository.putPrivateObject({
				key: pdfKey,
				body: pkg.pdfBuffer,
				contentType: 'application/pdf',
				sha256Hex: pkg.pdfSha256,
				metadata: {
					caseId: pkg.bundle.caseId,
					runId,
					artifact: 'pdf',
					protocolCode: pkg.bundle.protocolCode,
					version: String(pkg.bundle.version),
				},
			}),
			storageRepository.putPrivateObject({
				key: zipKey,
				body: pkg.zipBuffer,
				contentType: 'application/zip',
				sha256Hex: pkg.zipSha256,
				metadata: {
					caseId: pkg.bundle.caseId,
					runId,
					artifact: 'zip',
					protocolCode: pkg.bundle.protocolCode,
					version: String(pkg.bundle.version),
				},
			}),
		]);

		const persisted = await withTransaction(async (tx) => {
			const createdPkg = await exportRepository.persistExportAndFreezeRunInTransaction(
				{
					runId,
					paperFormat,
					cartographicScale: pkg.cartographicScale,
					observations,
					storageBucket: storedZip.bucket,
					pdfStorageKey: storedPdf.key,
					pdfSizeBytes: pkg.pdfSizeBytes,
					pdfSha256: pkg.pdfSha256,
					zipStorageKey: storedZip.key,
					zipSizeBytes: pkg.zipSizeBytes,
					zipSha256: pkg.zipSha256,
					auditManifest: pkg.auditManifest as unknown as Record<string, unknown>,
					generatedBy: issuer.id,
					generatedAt: pkg.emittedAt,
				},
				tx,
			);

			await auditRepository.insert(
				{
					actorUserId: issuer.id,
					action: 'export_generated',
					entityType: 'export_package',
					entityId: createdPkg.id,
					correlationId,
					metadata: {
						runId,
						caseId: pkg.bundle.caseId,
						protocolCode: pkg.bundle.protocolCode,
						runVersion: pkg.bundle.version,
						paperFormat,
						cartographicScale: pkg.cartographicScale,
						pdfSha256: pkg.pdfSha256,
						zipSha256: pkg.zipSha256,
						datasetFingerprintSha256: pkg.datasetFingerprintSha256,
						fileCount: pkg.fileCount,
					},
				},
				tx,
			);

			return createdPkg;
		});

		await runEventsRepository.publishEvent(runId, 'export.frozen', {
			runId,
			status: 'frozen',
			exportId: persisted.id,
			cartographicScale: pkg.cartographicScale,
			pdfSha256: pkg.pdfSha256,
			zipSha256: pkg.zipSha256,
		});
	} catch (err) {
		const isDomain4xx =
			err instanceof DomainError && err.statusCode >= 400 && err.statusCode < 500;
		const errorCode =
			err instanceof DomainError ? err.errorCode : 'ERR_INTERNAL_SERVER_ERROR';
		const safeMessage =
			err instanceof DomainError
				? err.message
				: 'Falha transitória na geração do pacote cartográfico e PDF 300 DPI.';

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
			'Erro ao processar job cartography-export',
		);

		if (isFinalAttempt) {
			await exportRepository.revertRunFromExportingToReview(runId, errorCode, safeMessage);
			await runEventsRepository.publishEvent(runId, 'export.failed', {
				runId,
				status: 'ready_for_review',
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

export function startCartographyExportWorker(
	opts: CartographyExportWorkerOptions = {},
): Worker<CartographyExportJobPayload> {
	const worker = new Worker<CartographyExportJobPayload>(
		'cartography-export',
		async (job) => processCartographyExportJob(job),
		{
			connection: {
				url: env.REDIS_URL,
				maxRetriesPerRequest: null,
			},
			concurrency: opts.concurrency ?? 1,
		},
	);

	worker.on('failed', (job, err) => {
		logger.error(
			{ jobId: job?.id, runId: job?.data?.runId, err: err.message },
			'Worker cartography-export registrou falha no job.',
		);
	});

	return worker;
}
