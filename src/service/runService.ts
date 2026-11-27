import { PassThrough, Readable } from 'node:stream';
import type { RunStatus } from '../config/db/schema/enums.js';
import { withTransaction } from '../config/dbConfig.js';
import { env } from '../config/env.js';
import { logger } from '../config/loggerConfig.js';
import auditRepository from '../repository/auditRepository.js';
import cartographyRepository from '../repository/cartographyRepository.js';
import caseRepository from '../repository/caseRepository.js';
import runEventsRepository, {
	isTerminalSseEvent,
	type PublishedSseEnvelope,
} from '../repository/runEventsRepository.js';
import runRepository, {
	type StoredRunStacMetadata,
} from '../repository/runRepository.js';
import { storageRepository } from '../repository/storageRepository.js';
import { resolveAndValidateAlgorithmParams } from '../utils/geo/core/ndviClassifier.js';
import { upscaleEvidencePngProgressively } from '../utils/geo/core/rasterRenderer.js';
import { computeAoiSclMetrics, type SclTileInput } from '../utils/geo/sclAnalyzer.js';
import {
	HttpStacCatalogAdapter,
	type NormalizedStacItem,
	type StacCatalogAdapter,
} from '../utils/geo/stacClient.js';
import {
	discoverLocalWaybackVintages,
	selectBestWaybackPair,
} from '../utils/geo/waybackClient.js';
import { StacCircuitBreaker } from '../utils/helpers/antiSsrfHttp.js';
import { DomainError } from '../utils/helpers/domainError.js';
import type {
	AuthenticatedUser,
	RequestClientContext,
} from '../utils/helpers/requestGuard.js';
import {
	CaseIdParamsSchema,
	type AoiPolygonGeoJson,
} from '../utils/validation/caseValidation.js';
import {
	CreateRunBodySchema,
	type DetectedFeatureItem,
	ListRunFeaturesQuerySchema,
	ReviewFeatureBodySchema,
	RunEventsQuerySchema,
	RunFeatureParamsSchema,
	RunIdParamsSchema,
	RunRasterParamsSchema,
	RunRasterQuerySchema,
	type RunSceneSelection,
} from '../utils/validation/runValidation.js';
import type { SclEvaluatorFn } from './sceneService.js';

const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
const SAME_PASS_MAX_SPAN_MS = 3_600_000;

export function computeSeasonalityWarning(t0Iso: string, t1Iso: string): boolean {
	const d0 = new Date(t0Iso);
	const d1 = new Date(t1Iso);
	const y1 = d1.getUTCFullYear();
	const month0 = d0.getUTCMonth();
	const day0 = d0.getUTCDate();
	const t1Ms = d1.getTime();

	let minDiffDays = Number.POSITIVE_INFINITY;
	for (const candidateYear of [y1 - 1, y1, y1 + 1]) {
		// Trata 29 de fevereiro em anos não bissextos ajustando para o último dia do mês se necessário
		const clampedDay =
			month0 === 1 && day0 === 29 && !(candidateYear % 4 === 0 && (candidateYear % 100 !== 0 || candidateYear % 400 === 0))
				? 28
				: day0;
		const candidateMs = Date.UTC(
			candidateYear,
			month0,
			clampedDay,
			d0.getUTCHours(),
			d0.getUTCMinutes(),
			d0.getUTCSeconds(),
		);
		const diffDays = Math.abs(t1Ms - candidateMs) / 86_400_000;
		if (diffDays < minDiffDays) {
			minDiffDays = diffDays;
		}
	}

	return minDiffDays > 60;
}

function bboxIntersects(
	aoiBbox: [number, number, number, number],
	itemBbox: number[] | undefined,
): boolean {
	if (!itemBbox || itemBbox.length < 4) {
		return true;
	}
	const [aMinLon, aMinLat, aMaxLon, aMaxLat] = aoiBbox;
	const [iMinLon, iMinLat, iMaxLon, iMaxLat] = itemBbox;
	if (
		iMinLon === undefined ||
		iMinLat === undefined ||
		iMaxLon === undefined ||
		iMaxLat === undefined
	) {
		return true;
	}
	return !(iMaxLon < aMinLon || iMinLon > aMaxLon || iMaxLat < aMinLat || iMinLat > aMaxLat);
}

function describeRunStageForSnapshot(status: RunStatus): {
	progressPct: number;
	step: string;
} {
	switch (status) {
		case 'queued':
			return { progressPct: 0, step: 'Aguardando worker disponível' };
		case 'fetching_bands':
			return { progressPct: 25, step: 'Lendo bandas COG Sentinel-2 (T0/T1)' };
		case 'processing_ndvi':
			return { progressPct: 60, step: 'Calculando Delta-NDVI e aplicando máscara SCL' };
		case 'vectorizing':
			return { progressPct: 85, step: 'Vetorizando polígonos e gerando evidências PNG' };
		case 'ready_for_review':
			return { progressPct: 100, step: 'Análise concluída e pronta para curadoria' };
		case 'exporting':
			return { progressPct: 90, step: 'Renderizando Carta-Imagem 300 DPI e pacote técnico' };
		case 'frozen':
			return { progressPct: 100, step: 'Pacote técnico emitido e execução congelada' };
		case 'failed':
			return { progressPct: 100, step: 'Execução encerrada com falha' };
	}
}

function isSseTerminalRunStatus(status: RunStatus): boolean {
	return status === 'ready_for_review' || status === 'frozen' || status === 'failed';
}

function mapFeatureRowToItem(row: {
	id: string;
	runId: string;
	featureSequence: number;
	featureClass: 'deforestation' | 'degradation' | 'regrowth';
	areaHa: string;
	pixelCount: number;
	meanNdviT0: string;
	meanNdviT1: string;
	meanDeltaNdvi: string;
	centroidLat: string;
	centroidLon: string;
	centroidUtmE: string;
	centroidUtmN: string;
	reviewStatus: 'auto_detected' | 'confirmed' | 'dismissed_noise';
	dismissalReason: string | null;
	reviewedAt: Date | null;
	createdAt: Date;
	reviewerId: string | null;
	reviewerFullName: string | null;
	reviewerRegistrationCode: string | null;
}): DetectedFeatureItem {
	return {
		id: row.id,
		runId: row.runId,
		featureSequence: row.featureSequence,
		label: `P${row.featureSequence}`,
		featureClass: row.featureClass,
		areaHa: Number(row.areaHa),
		pixelCount: row.pixelCount,
		meanNdviT0: Number(row.meanNdviT0),
		meanNdviT1: Number(row.meanNdviT1),
		meanDeltaNdvi: Number(row.meanDeltaNdvi),
		centroid: {
			lat: Number(row.centroidLat),
			lon: Number(row.centroidLon),
			utmE: Number(row.centroidUtmE),
			utmN: Number(row.centroidUtmN),
		},
		reviewStatus: row.reviewStatus,
		dismissalReason: row.dismissalReason,
		reviewedBy: row.reviewerId
			? {
					id: row.reviewerId,
					fullName: row.reviewerFullName ?? '',
					registrationCode: row.reviewerRegistrationCode ?? '',
				}
			: null,
		reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
		createdAt: row.createdAt.toISOString(),
	};
}

// Camada Service ("Segurança"): Zod estrito + Zero Trust sobre cenas STAC, limites operacionais, curadoria e SSE
export class RunService {
	private catalogAdapter: StacCatalogAdapter;
	private sclEvaluator: SclEvaluatorFn;
	private readonly circuitBreaker: StacCircuitBreaker;
	private heartbeatMs: number;
	private enqueueJobFn: (payload: {
		runId: string;
		caseId: string;
		correlationId: string;
	}) => Promise<string>;

	constructor(deps?: {
		catalogAdapter?: StacCatalogAdapter;
		sclEvaluator?: SclEvaluatorFn;
		circuitBreaker?: StacCircuitBreaker;
		heartbeatMs?: number;
		enqueueJobFn?: (payload: {
			runId: string;
			caseId: string;
			correlationId: string;
		}) => Promise<string>;
	}) {
		this.catalogAdapter = deps?.catalogAdapter ?? new HttpStacCatalogAdapter();
		this.sclEvaluator = deps?.sclEvaluator ?? computeAoiSclMetrics;
		this.circuitBreaker = deps?.circuitBreaker ?? new StacCircuitBreaker();
		this.heartbeatMs = deps?.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
		this.enqueueJobFn =
			deps?.enqueueJobFn ??
			((payload) => runEventsRepository.enqueueGeoAnalysisJob(payload));
	}

	setAdaptersForTesting(deps: {
		catalogAdapter?: StacCatalogAdapter;
		sclEvaluator?: SclEvaluatorFn;
		heartbeatMs?: number;
		enqueueJobFn?: (payload: {
			runId: string;
			caseId: string;
			correlationId: string;
		}) => Promise<string>;
		resetBreaker?: boolean;
	}): void {
		if (deps.catalogAdapter) this.catalogAdapter = deps.catalogAdapter;
		if (deps.sclEvaluator) this.sclEvaluator = deps.sclEvaluator;
		if (deps.heartbeatMs !== undefined) this.heartbeatMs = deps.heartbeatMs;
		if (deps.enqueueJobFn) this.enqueueJobFn = deps.enqueueJobFn;
		if (deps.resetBreaker) this.circuitBreaker.reset();
	}

	private async verifySceneSelectionOnProvider(params: {
		selection: RunSceneSelection;
		field: 't0' | 't1';
		aoiGeoJson: AoiPolygonGeoJson;
		aoiBbox: [number, number, number, number];
		utmSrid: number;
	}): Promise<StoredRunStacMetadata> {
		const { selection, field, aoiGeoJson, aoiBbox, utmSrid } = params;

		let items: NormalizedStacItem[];
		try {
			this.circuitBreaker.assertAvailable(selection.provider);
			items = await Promise.all(
				selection.itemIds.map((itemId) =>
					this.catalogAdapter.getItem({
						provider: selection.provider,
						collection: selection.collection,
						itemId,
					}),
				),
			);
			this.circuitBreaker.recordSuccess(selection.provider);
		} catch (err) {
			if (!(err instanceof DomainError) || err.errorCode === 'ERR_UPSTREAM_STAC_UNAVAILABLE') {
				this.circuitBreaker.recordFailure(selection.provider);
			}
			if (err instanceof DomainError) {
				throw err;
			}
			throw new DomainError(
				'ERR_UPSTREAM_STAC_UNAVAILABLE',
				`Falha ao consultar os itens STAC de ${field.toUpperCase()} no provedor '${selection.provider}'.`,
			);
		}

		// Garante interseção espacial com a AOI quando o catálogo retorna bbox e mesma passagem para mosaico multi-tile
		const hasIntersectingTile = items.some((item) => bboxIntersects(aoiBbox, item.raw.bbox));
		if (!hasIntersectingTile) {
			throw new DomainError(
				'ERR_STAC_ITEM_INVALID',
				`Os itens informados para ${field.toUpperCase()} não intersectam a área de interesse.`,
				{
					invalidParams: [{ field, reason: 'STAC_BBOX_OUTSIDE_AOI' }],
				},
			);
		}

		const acquiredTimes = items.map((i) => Date.parse(i.acquiredAt));
		const minTime = Math.min(...acquiredTimes);
		const maxTime = Math.max(...acquiredTimes);
		if (maxTime - minTime > SAME_PASS_MAX_SPAN_MS) {
			throw new DomainError(
				'ERR_STAC_ITEM_INVALID',
				`Todos os tiles MGRS de um mesmo mosaico (${field.toUpperCase()}) devem pertencer à mesma passagem orbital.`,
				{
					invalidParams: [{ field: `${field}.itemIds`, reason: 'MULTI_TILE_DATE_MISMATCH' }],
				},
			);
		}

		const sclTiles: SclTileInput[] = items.map((item) => ({
			href: item.sclHref,
			projEpsg: item.projEpsg,
			isInpeBdc: item.provider === 'inpe_bdc',
		}));

		const sclMetrics = await this.sclEvaluator({
			aoiGeoJson,
			utmSrid,
			sclTiles,
		});

		if (sclMetrics.aoiCoveragePct <= 0) {
			throw new DomainError(
				'ERR_STAC_ITEM_INVALID',
				`Os rasters selecionados para ${field.toUpperCase()} não possuem cobertura de pixels válidos dentro da AOI.`,
				{
					invalidParams: [{ field, reason: 'ZERO_AOI_COVERAGE' }],
				},
			);
		}

		const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
		const primary = sortedItems[0]!;
		const globalCloudPct = Number(
			(
				sortedItems.reduce((acc, item) => acc + item.globalCloudPct, 0) / sortedItems.length
			).toFixed(2),
		);

		return {
			provider: selection.provider,
			collection: selection.collection,
			acquiredAt: primary.acquiredAt,
			aoiCloudPct: sclMetrics.aoiCloudPct,
			aoiCoveragePct: sclMetrics.aoiCoveragePct,
			globalCloudPct,
			isMultiTile: sortedItems.length > 1,
			processingBaseline: primary.processingBaseline,
			boaOffsetApplied: sortedItems.some((item) => item.boaOffsetApplied),
			items: sortedItems.map((item) => ({
				id: item.id,
				acquiredAt: item.acquiredAt,
				mgrsTile: item.mgrsTile,
				globalCloudPct: item.globalCloudPct,
				processingBaseline: item.processingBaseline,
				boaOffsetApplied: item.boaOffsetApplied,
				projEpsg: item.projEpsg,
				raw: item.raw,
			})),
		};
	}

	async createRun(
		rawParams: unknown,
		rawBody: unknown,
		actor: AuthenticatedUser,
		clientCtx: RequestClientContext,
	) {
		const { caseId } = CaseIdParamsSchema.parse(rawParams);
		const body = CreateRunBodySchema.parse(rawBody);

		const { params: algorithmParams, isCustomParams } = resolveAndValidateAlgorithmParams(
			body.presetName,
			body.customParams,
		);

		const caseEnvelope = await caseRepository.findSpatialEnvelopeById(caseId);
		if (!caseEnvelope) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Caso de análise não encontrado.');
		}

		const preCheckActiveCount = await runRepository.countActiveRunsByUser(actor.id);
		if (preCheckActiveCount >= env.MAX_ACTIVE_RUNS_PER_USER) {
			throw new DomainError(
				'ERR_CONCURRENT_JOBS_LIMIT',
				`Limite de ${env.MAX_ACTIVE_RUNS_PER_USER} execuções simultâneas atingido para este operador.`,
			);
		}

		const [t0Meta, t1Meta] = await Promise.all([
			this.verifySceneSelectionOnProvider({
				selection: body.t0,
				field: 't0',
				aoiGeoJson: caseEnvelope.aoiGeoJson,
				aoiBbox: caseEnvelope.bbox,
				utmSrid: caseEnvelope.utmSrid,
			}),
			this.verifySceneSelectionOnProvider({
				selection: body.t1,
				field: 't1',
				aoiGeoJson: caseEnvelope.aoiGeoJson,
				aoiBbox: caseEnvelope.bbox,
				utmSrid: caseEnvelope.utmSrid,
			}),
		]);

		if (Date.parse(t1Meta.acquiredAt) <= Date.parse(t0Meta.acquiredAt)) {
			throw new DomainError(
				'ERR_TEMPORAL_ORDER_INVALID',
				'A cena alvo (T1) deve possuir data de aquisição estritamente posterior à cena base (T0).',
				{
					invalidParams: [{ field: 't1', reason: 'TEMPORAL_ORDER_INVALID' }],
				},
			);
		}

		const seasonalityWarning = computeSeasonalityWarning(t0Meta.acquiredAt, t1Meta.acquiredAt);

		const created = await withTransaction(async (tx) => {
			await runRepository.lockUserAndCaseForRun(actor.id, caseId, tx);

			const activeInTx = await runRepository.countActiveRunsByUser(actor.id, tx);
			if (activeInTx >= env.MAX_ACTIVE_RUNS_PER_USER) {
				throw new DomainError(
					'ERR_CONCURRENT_JOBS_LIMIT',
					`Limite de ${env.MAX_ACTIVE_RUNS_PER_USER} execuções simultâneas atingido para este operador.`,
				);
			}

			const version = await runRepository.getNextVersionForCase(caseId, tx);

			const run = await runRepository.createRun(
				{
					caseId,
					version,
					t0Provider: t0Meta.provider,
					t0Collection: t0Meta.collection,
					t0ItemIds: t0Meta.items.map((i) => i.id),
					t0AcquiredAt: new Date(t0Meta.acquiredAt),
					t0CloudPctAoi: t0Meta.aoiCloudPct.toFixed(2),
					t0StacMetadata: t0Meta,
					t1Provider: t1Meta.provider,
					t1Collection: t1Meta.collection,
					t1ItemIds: t1Meta.items.map((i) => i.id),
					t1AcquiredAt: new Date(t1Meta.acquiredAt),
					t1CloudPctAoi: t1Meta.aoiCloudPct.toFixed(2),
					t1StacMetadata: t1Meta,
					seasonalityWarning,
					presetName: body.presetName,
					isCustomParams,
					algorithmParams,
					engineVersion: env.ENGINE_VERSION,
					executedBy: actor.id,
				},
				tx,
			);

			await auditRepository.insert(
				{
					actorUserId: actor.id,
					action: 'run_created',
					entityType: 'analysis_run',
					entityId: run.id,
					ipAddress: clientCtx.ipAddress,
					userAgent: clientCtx.userAgent,
					correlationId: clientCtx.correlationId,
					metadata: {
						caseId,
						version,
						presetName: body.presetName,
						isCustomParams,
						seasonalityWarning,
						t0ItemIds: t0Meta.items.map((i) => i.id),
						t1ItemIds: t1Meta.items.map((i) => i.id),
					},
				},
				tx,
			);

			return run;
		});

		try {
			const jobId = await this.enqueueJobFn({
				runId: created.id,
				caseId,
				correlationId: clientCtx.correlationId,
			});
			await runRepository.attachBullmqJobId(created.id, jobId);
		} catch (enqueueErr) {
			await runRepository.markRunFailed(
				created.id,
				'ERR_QUEUE_ENQUEUE_FAILED',
				'Falha ao enfileirar análise assíncrona no Redis/BullMQ.',
			);
			throw enqueueErr instanceof DomainError
				? enqueueErr
				: new DomainError(
						'ERR_SERVICE_UNAVAILABLE',
						'Fila de processamento geoespacial temporariamente indisponível.',
					);
		}

		return {
			runId: created.id,
			caseId: created.caseId,
			version: created.version,
			status: created.status,
			seasonalityWarning: created.seasonalityWarning,
			eventsUrl: `/api/v1/runs/${created.id}/events`,
		};
	}

	async getRunById(rawParams: unknown) {
		const { runId } = RunIdParamsSchema.parse(rawParams);
		const found = await runRepository.findDetailById(runId);

		if (!found) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
		}

		const { runRow, rasters, summary } = found;
		const t0Meta = runRow.t0StacMetadata as unknown as Partial<StoredRunStacMetadata>;
		const t1Meta = runRow.t1StacMetadata as unknown as Partial<StoredRunStacMetadata>;

		return {
			id: runRow.id,
			caseId: runRow.caseId,
			version: runRow.version,
			status: runRow.status,
			t0: {
				provider: runRow.t0Provider,
				collection: runRow.t0Collection,
				itemIds: runRow.t0ItemIds,
				isMultiTile: t0Meta.isMultiTile ?? runRow.t0ItemIds.length > 1,
				acquiredAt: runRow.t0AcquiredAt.toISOString(),
				aoiCloudPct: Number(runRow.t0CloudPctAoi),
				aoiCoveragePct: t0Meta.aoiCoveragePct ?? 100,
				globalCloudPct: t0Meta.globalCloudPct ?? Number(runRow.t0CloudPctAoi),
				processingBaseline: t0Meta.processingBaseline ?? null,
				boaOffsetApplied: t0Meta.boaOffsetApplied ?? false,
			},
			t1: {
				provider: runRow.t1Provider,
				collection: runRow.t1Collection,
				itemIds: runRow.t1ItemIds,
				isMultiTile: t1Meta.isMultiTile ?? runRow.t1ItemIds.length > 1,
				acquiredAt: runRow.t1AcquiredAt.toISOString(),
				aoiCloudPct: Number(runRow.t1CloudPctAoi),
				aoiCoveragePct: t1Meta.aoiCoveragePct ?? 100,
				globalCloudPct: t1Meta.globalCloudPct ?? Number(runRow.t1CloudPctAoi),
				processingBaseline: t1Meta.processingBaseline ?? null,
				boaOffsetApplied: t1Meta.boaOffsetApplied ?? false,
			},
			seasonalityWarning: runRow.seasonalityWarning,
			presetName: runRow.presetName,
			isCustomParams: runRow.isCustomParams,
			algorithmParams: runRow.algorithmParams,
			engineVersion: runRow.engineVersion,
			summary,
			rasterAssets: rasters.map((asset) => ({
				id: asset.id,
				assetType: asset.assetType,
				mimeType: asset.mimeType,
				sizeBytes: asset.sizeBytes,
				sha256: asset.sha256,
				widthPx: asset.widthPx,
				heightPx: asset.heightPx,
				bounds4674: asset.bounds4674,
				url: `/api/v1/runs/${runRow.id}/rasters/${asset.assetType}`,
				createdAt: asset.createdAt.toISOString(),
			})),
			executedBy: {
				id: runRow.executorId,
				fullName: runRow.executorFullName,
				registrationCode: runRow.executorRegistrationCode,
			},
			errorCode: runRow.errorCode,
			errorDetail: runRow.errorDetail,
			queuedAt: runRow.queuedAt.toISOString(),
			startedAt: runRow.startedAt ? runRow.startedAt.toISOString() : null,
			finishedAt: runRow.finishedAt ? runRow.finishedAt.toISOString() : null,
		};
	}

	async listRunFeatures(rawParams: unknown, rawQuery: unknown) {
		const { runId } = RunIdParamsSchema.parse(rawParams);
		const query = ListRunFeaturesQuerySchema.parse(rawQuery ?? {});

		const runSnap = await runRepository.findSnapshotById(runId);
		if (!runSnap) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
		}

		const result = await runRepository.findFeaturesByRun({
			runId,
			reviewStatus: query.reviewStatus === 'all' ? undefined : query.reviewStatus,
			featureClass: query.class === 'all' ? undefined : query.class,
			page: query.page,
			limit: query.limit,
			includePagination: query.format === 'json',
		});

		if (query.format === 'json') {
			return {
				format: 'json' as const,
				runId,
				items: result.rows.map(mapFeatureRowToItem),
				pagination: {
					page: query.page,
					limit: query.limit,
					total: result.total,
					totalPages: Math.max(1, Math.ceil(result.total / query.limit)),
				},
			};
		}

		return {
			type: 'FeatureCollection' as const,
			runId,
			features: result.rows.map((row) => ({
				type: 'Feature' as const,
				id: row.id,
				geometry: row.geomGeoJson,
				properties: mapFeatureRowToItem(row),
			})),
		};
	}

	async reviewFeature(
		rawParams: unknown,
		rawBody: unknown,
		actor: AuthenticatedUser,
		clientCtx: RequestClientContext,
	) {
		const { runId, featureId } = RunFeatureParamsSchema.parse(rawParams);
		const body = ReviewFeatureBodySchema.parse(rawBody);

		const normalizedReason =
			body.dismissalReason !== undefined && body.dismissalReason !== null
				? body.dismissalReason.trim()
				: null;

		if (body.reviewStatus === 'dismissed_noise') {
			if (!normalizedReason || normalizedReason.length < 15) {
				throw new DomainError(
					'ERR_VALIDATION_FAILED',
					'Ao descartar uma feição como falso positivo (dismissed_noise), dismissalReason deve ter ao menos 15 caracteres úteis.',
					{
						invalidParams: [{ field: 'dismissalReason', reason: 'MIN_LENGTH_15_REQUIRED' }],
					},
				);
			}
		}

		const updated = await withTransaction(async (tx) => {
			const lockedRun = await runRepository.lockRunForReview(runId, tx);
			if (!lockedRun) {
				throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
			}

			if (lockedRun.status === 'frozen') {
				throw new DomainError(
					'ERR_RUN_FROZEN',
					'A execução já foi congelada após emissão de pacote técnico e não aceita revisões.',
				);
			}

			if (lockedRun.status !== 'ready_for_review') {
				throw new DomainError(
					'ERR_RUN_NOT_REVIEWABLE',
					`Revisão indisponível no estado atual ('${lockedRun.status}').`,
				);
			}

			const existingFeature = await runRepository.findFeatureByIdInRun(runId, featureId, tx);
			if (!existingFeature) {
				throw new DomainError(
					'ERR_RESOURCE_NOT_FOUND',
					'Feição detectada não encontrada para a execução informada.',
				);
			}

			const finalReason =
				body.reviewStatus === 'dismissed_noise' ? normalizedReason : null;

			const res = await runRepository.updateFeatureReviewAndRecalculateAreas(
				{
					runId,
					featureId,
					reviewStatus: body.reviewStatus,
					dismissalReason: finalReason,
					reviewedBy: actor.id,
				},
				tx,
			);

			await auditRepository.insert(
				{
					actorUserId: actor.id,
					action: 'feature_reviewed',
					entityType: 'detected_feature',
					entityId: featureId,
					ipAddress: clientCtx.ipAddress,
					userAgent: clientCtx.userAgent,
					correlationId: clientCtx.correlationId,
					metadata: {
						runId,
						previousStatus: existingFeature.reviewStatus,
						newStatus: body.reviewStatus,
						dismissalReason: finalReason,
						updatedSummary: res.updatedSummary,
					},
				},
				tx,
			);

			return res;
		});

		return {
			feature: mapFeatureRowToItem(updated.featureRow),
			updatedSummary: updated.updatedSummary,
		};
	}

	async getRasterAssetStream(rawParams: unknown, ifNoneMatch?: string, rawQuery?: unknown) {
		const { runId, assetType } = RunRasterParamsSchema.parse(rawParams);
		const { upscale } = RunRasterQuerySchema.parse(rawQuery ?? {});

		const asset = await runRepository.findRasterAsset(runId, assetType);
		if (!asset) {
			throw new DomainError(
				'ERR_RESOURCE_NOT_FOUND',
				`Evidência raster '${assetType}' indisponível para a execução informada.`,
			);
		}

		const etag = upscale > 1 ? `"${asset.sha256}-u${upscale}"` : `"${asset.sha256}"`;
		if (ifNoneMatch) {
			const cleanMatch = ifNoneMatch.replace(/^W\//, '').trim();
			if (cleanMatch === etag || (upscale === 1 && cleanMatch === asset.sha256)) {
				return {
					notModified: true as const,
					etag,
					sha256: asset.sha256,
					mimeType: asset.mimeType,
				};
			}
		}

		const s3Object = await storageRepository.getPrivateObjectStream(
			asset.storageKey,
			asset.storageBucket,
		);

		if (upscale <= 1) {
			return {
				notModified: false as const,
				stream: s3Object.stream,
				etag,
				sha256: asset.sha256,
				mimeType: asset.mimeType,
				sizeBytes: asset.sizeBytes,
			};
		}

		const chunks: Buffer[] = [];
		for await (const chunk of s3Object.stream) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		const sourceBuffer = Buffer.concat(chunks);
		const upscaledBuffer = await upscaleEvidencePngProgressively(
			sourceBuffer,
			upscale,
			assetType === 'delta_ndvi_mask',
		);

		return {
			notModified: false as const,
			stream: Readable.from(upscaledBuffer),
			etag,
			sha256: asset.sha256,
			mimeType: asset.mimeType,
			sizeBytes: upscaledBuffer.byteLength,
		};
	}

	async getRunWaybackTimeline(rawParams: unknown) {
		const { runId } = RunIdParamsSchema.parse(rawParams);
		const bundle = await cartographyRepository.findCartographyRunBundle(runId);
		if (!bundle) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
		}

		if (!env.ENABLE_WAYBACK_HIRES) {
			return {
				runId: bundle.runId,
				aoiCenterLonLat: bundle.aoiCenterLonLat,
				maxZoom: 17,
				vintages: [],
				selectedT0: null,
				selectedT1: null,
			};
		}

		try {
			const discovery = await discoverLocalWaybackVintages({
				lon: bundle.aoiCenterLonLat[0],
				lat: bundle.aoiCenterLonLat[1],
			});
			const pair = selectBestWaybackPair(
				discovery.vintages,
				bundle.t0AcquiredAt,
				bundle.t1AcquiredAt,
			);

			return {
				runId: bundle.runId,
				aoiCenterLonLat: bundle.aoiCenterLonLat,
				maxZoom: discovery.maxZoom,
				vintages: discovery.vintages,
				selectedT0: pair.selectedT0,
				selectedT1: pair.selectedT1,
			};
		} catch (err) {
			logger.warn(
				{ runId: bundle.runId, err },
				'Indisponibilidade temporária ao consultar catálogo Wayback; retornando fallback vazio.',
			);
			return {
				runId: bundle.runId,
				aoiCenterLonLat: bundle.aoiCenterLonLat,
				maxZoom: 17,
				vintages: [],
				selectedT0: null,
				selectedT1: null,
			};
		}
	}

	// OpenAPI Seção 4.2: Snapshot obrigatório + Pub/Sub Redis `run:events:{runId}` + heartbeat 15s + zero race condition
	async openRunEventsStream(
		rawParams: unknown,
		rawQuery: unknown,
		actor: AuthenticatedUser,
	): Promise<{ stream: PassThrough; cleanup: () => Promise<void> }> {
		const { runId } = RunIdParamsSchema.parse(rawParams);
		RunEventsQuerySchema.parse(rawQuery ?? {});

		const initialSnap = await runRepository.findSnapshotById(runId);
		if (!initialSnap) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
		}

		const releaseSlot = runEventsRepository.acquireUserSseSlot(actor.id, 10);
		const stream = new PassThrough();

		if (isSseTerminalRunStatus(initialSnap.status)) {
			const stage = describeRunStageForSnapshot(initialSnap.status);
			const updatedAt = (
				initialSnap.finishedAt ??
				initialSnap.startedAt ??
				initialSnap.queuedAt
			).toISOString();

			stream.write(
				runEventsRepository.formatSseFrame(runEventsRepository.nextEventId(), 'snapshot', {
					runId,
					status: initialSnap.status,
					progressPct: stage.progressPct,
					step: stage.step,
					updatedAt,
				}),
			);
			stream.end();
			releaseSlot();
			return {
				stream,
				cleanup: async () => {
					releaseSlot();
				},
			};
		}

		let cleanedUp = false;
		let snapshotDelivered = false;
		const bufferedEnvelopes: PublishedSseEnvelope[] = [];
		let heartbeatTimer: NodeJS.Timeout | null = null;
		let subHandle: { close: () => Promise<void> } | null = null;

		const cleanup = async (): Promise<void> => {
			if (cleanedUp) return;
			cleanedUp = true;
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			if (subHandle) {
				await subHandle.close();
				subHandle = null;
			}
			releaseSlot();
			if (!stream.writableEnded) {
				stream.end();
			}
		};

		const emitEnvelope = (envelope: PublishedSseEnvelope): void => {
			if (cleanedUp || stream.writableEnded) {
				return;
			}
			stream.write(runEventsRepository.formatSseFrame(envelope.id, envelope.event, envelope.data));
			if (isTerminalSseEvent(envelope.event)) {
				void cleanup();
			}
		};

		try {
			// Assina antes da leitura final do snapshot para evitar perder eventos entre SELECT e SUBSCRIBE
			subHandle = await runEventsRepository.subscribeRunChannel(runId, (envelope) => {
				if (!snapshotDelivered) {
					bufferedEnvelopes.push(envelope);
					return;
				}
				emitEnvelope(envelope);
			});

			const freshSnap = (await runRepository.findSnapshotById(runId)) ?? initialSnap;
			const stage = describeRunStageForSnapshot(freshSnap.status);
			const updatedAt = (
				freshSnap.finishedAt ??
				freshSnap.startedAt ??
				freshSnap.queuedAt
			).toISOString();

			stream.write(
				runEventsRepository.formatSseFrame(runEventsRepository.nextEventId(), 'snapshot', {
					runId,
					status: freshSnap.status,
					progressPct: stage.progressPct,
					step: stage.step,
					updatedAt,
				}),
			);
			snapshotDelivered = true;

			if (isSseTerminalRunStatus(freshSnap.status)) {
				await cleanup();
				return { stream, cleanup };
			}

			for (const buffered of bufferedEnvelopes) {
				emitEnvelope(buffered);
			}
			bufferedEnvelopes.length = 0;

			if (!cleanedUp) {
				heartbeatTimer = setInterval(() => {
					if (!cleanedUp && !stream.writableEnded) {
						stream.write(': ping\n\n');
					}
				}, this.heartbeatMs);
				heartbeatTimer.unref?.();
			}

			return { stream, cleanup };
		} catch (err) {
			await cleanup();
			throw err;
		}
	}
}

export default new RunService();
