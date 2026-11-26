import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { type DbExecutor, getDb } from '../config/dbConfig.js';
import { rasterAssets } from '../config/db/schema/artifacts.js';
import { analysisCases } from '../config/db/schema/cases.js';
import type {
	FeatureClass,
	RasterType,
	ReviewStatus,
	RunStatus,
	StacProvider,
} from '../config/db/schema/enums.js';
import { detectedFeatures } from '../config/db/schema/features.js';
import { analysisRuns } from '../config/db/schema/runs.js';
import { users } from '../config/db/schema/users.js';
import type { AlgorithmParams } from '../config/presets.js';
import type { VectorizedFeaturePolygon } from '../utils/geo/core/vectorizer.js';
import type { StacItemRaw } from '../utils/geo/stacClient.js';
import { parseDatabaseError } from '../utils/helpers/dbErrors.js';
import type { AoiPolygonGeoJson } from '../utils/validation/caseValidation.js';
import type {
	DetectedFeaturePolygonGeoJson,
	RunAreaSummary,
} from '../utils/validation/runValidation.js';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
	'queued',
	'fetching_bands',
	'processing_ndvi',
	'vectorizing',
	'exporting',
];

export interface StoredRunStacItem {
	id: string;
	acquiredAt: string;
	mgrsTile: string;
	globalCloudPct: number;
	processingBaseline: string | null;
	boaOffsetApplied: boolean;
	projEpsg: number | null;
	raw: StacItemRaw;
}

export interface StoredRunStacMetadata {
	provider: StacProvider;
	collection: string;
	acquiredAt: string;
	aoiCloudPct: number;
	aoiCoveragePct: number;
	globalCloudPct: number;
	isMultiTile: boolean;
	processingBaseline: string | null;
	boaOffsetApplied: boolean;
	items: StoredRunStacItem[];
}

export interface CreateRunPersistInput {
	caseId: string;
	version: number;
	t0Provider: StacProvider;
	t0Collection: string;
	t0ItemIds: string[];
	t0AcquiredAt: Date;
	t0CloudPctAoi: string;
	t0StacMetadata: StoredRunStacMetadata;
	t1Provider: StacProvider;
	t1Collection: string;
	t1ItemIds: string[];
	t1AcquiredAt: Date;
	t1CloudPctAoi: string;
	t1StacMetadata: StoredRunStacMetadata;
	seasonalityWarning: boolean;
	presetName: string;
	isCustomParams: boolean;
	algorithmParams: AlgorithmParams;
	engineVersion: string;
	executedBy: string;
}

export interface PersistRasterAssetInput {
	assetType: RasterType;
	storageBucket: string;
	storageKey: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
	widthPx: number;
	heightPx: number;
	bounds4674: [number, number, number, number];
}

export interface WorkerRunExecutionContext {
	id: string;
	caseId: string;
	status: RunStatus;
	t0Provider: StacProvider;
	t1Provider: StacProvider;
	t0StacMetadata: StoredRunStacMetadata;
	t1StacMetadata: StoredRunStacMetadata;
	algorithmParams: AlgorithmParams;
	executedBy: string;
	utmSrid: number;
	aoiAreaHa: number;
	aoiGeoJson: AoiPolygonGeoJson;
}

export interface ListRunFeaturesDbFilter {
	runId: string;
	reviewStatus?: ReviewStatus;
	featureClass?: FeatureClass;
	page: number;
	limit: number;
	includePagination: boolean;
}

function clampNumeric(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < min) return min;
	if (value > max) return max;
	return Number(value.toFixed(4));
}

function buildAreaSummaryFromMetrics(params: {
	validAnalyzedHa: number | null;
	cloudMaskedHa: number | null;
	deforestationHa: number | null;
	degradationHa: number | null;
	regrowthHa: number | null;
	stableHa: number | null;
	activeFeatureCount: number;
	dismissedFeatureCount: number;
}): RunAreaSummary {
	let cloudObstructionPct: number | null = null;
	if (params.validAnalyzedHa !== null && params.cloudMaskedHa !== null) {
		const total = params.validAnalyzedHa + params.cloudMaskedHa;
		cloudObstructionPct =
			total > 0 ? Number(((params.cloudMaskedHa / total) * 100).toFixed(2)) : 0;
	}

	return {
		validAnalyzedHa: params.validAnalyzedHa,
		cloudMaskedHa: params.cloudMaskedHa,
		deforestationHa: params.deforestationHa,
		degradationHa: params.degradationHa,
		regrowthHa: params.regrowthHa,
		stableHa: params.stableHa,
		cloudObstructionPct,
		visibilityCompromisedWarning: cloudObstructionPct !== null && cloudObstructionPct > 50,
		activeFeatureCount: params.activeFeatureCount,
		dismissedFeatureCount: params.dismissedFeatureCount,
	};
}

// Camada Repository ("Estoquista"): acesso exclusivo PostgreSQL/PostGIS para runs, rasters e feições
export class RunRepository {
	async countActiveRunsByUser(userId: string, db: DbExecutor = getDb()): Promise<number> {
		try {
			const [row] = await db
				.select({ count: sql<number>`COUNT(*)::int` })
				.from(analysisRuns)
				.where(
					and(
						eq(analysisRuns.executedBy, userId),
						inArray(analysisRuns.status, [...ACTIVE_RUN_STATUSES]),
					),
				);
			return Number(row?.count ?? 0);
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.countActiveRunsByUser');
		}
	}

	async lockUserAndCaseForRun(
		userId: string,
		caseId: string,
		tx: DbExecutor,
	): Promise<void> {
		try {
			await tx.execute(sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`);
			await tx.execute(sql`SELECT id FROM analysis_cases WHERE id = ${caseId}::uuid FOR UPDATE`);
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.lockUserAndCaseForRun');
		}
	}

	async getNextVersionForCase(caseId: string, tx: DbExecutor): Promise<number> {
		try {
			const result = await tx.execute(
				sql`SELECT (COALESCE(MAX(version), 0) + 1)::int AS next_ver FROM analysis_runs WHERE case_id = ${caseId}::uuid`,
			);
			const row = result.rows[0] as { next_ver?: number } | undefined;
			return Number(row?.next_ver ?? 1);
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.getNextVersionForCase');
		}
	}

	async createRun(input: CreateRunPersistInput, db: DbExecutor = getDb()) {
		try {
			const [inserted] = await db
				.insert(analysisRuns)
				.values({
					caseId: input.caseId,
					version: input.version,
					status: 'queued',
					t0Provider: input.t0Provider,
					t0Collection: input.t0Collection,
					t0ItemIds: input.t0ItemIds,
					t0AcquiredAt: input.t0AcquiredAt,
					t0CloudPctAoi: input.t0CloudPctAoi,
					t0StacMetadata: input.t0StacMetadata as unknown as Record<string, unknown>,
					t1Provider: input.t1Provider,
					t1Collection: input.t1Collection,
					t1ItemIds: input.t1ItemIds,
					t1AcquiredAt: input.t1AcquiredAt,
					t1CloudPctAoi: input.t1CloudPctAoi,
					t1StacMetadata: input.t1StacMetadata as unknown as Record<string, unknown>,
					seasonalityWarning: input.seasonalityWarning,
					presetName: input.presetName,
					isCustomParams: input.isCustomParams,
					algorithmParams: input.algorithmParams,
					engineVersion: input.engineVersion,
					executedBy: input.executedBy,
				})
				.returning({
					id: analysisRuns.id,
					caseId: analysisRuns.caseId,
					version: analysisRuns.version,
					status: analysisRuns.status,
					seasonalityWarning: analysisRuns.seasonalityWarning,
					queuedAt: analysisRuns.queuedAt,
				});

			return inserted!;
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.createRun');
		}
	}

	async attachBullmqJobId(
		runId: string,
		bullmqJobId: string,
		db: DbExecutor = getDb(),
	): Promise<void> {
		try {
			await db
				.update(analysisRuns)
				.set({ bullmqJobId })
				.where(eq(analysisRuns.id, runId));
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.attachBullmqJobId');
		}
	}

	async findWorkerExecutionContext(
		runId: string,
		db: DbExecutor = getDb(),
	): Promise<WorkerRunExecutionContext | null> {
		try {
			const [row] = await db
				.select({
					id: analysisRuns.id,
					caseId: analysisRuns.caseId,
					status: analysisRuns.status,
					t0Provider: analysisRuns.t0Provider,
					t1Provider: analysisRuns.t1Provider,
					t0StacMetadata: analysisRuns.t0StacMetadata,
					t1StacMetadata: analysisRuns.t1StacMetadata,
					algorithmParams: analysisRuns.algorithmParams,
					executedBy: analysisRuns.executedBy,
					utmSrid: analysisCases.utmSrid,
					aoiAreaHa: analysisCases.aoiAreaHa,
					aoiGeoJson: sql<AoiPolygonGeoJson>`(ST_AsGeoJSON(${analysisCases.aoiGeom}, 7)::jsonb - 'crs')`,
				})
				.from(analysisRuns)
				.innerJoin(analysisCases, eq(analysisRuns.caseId, analysisCases.id))
				.where(eq(analysisRuns.id, runId))
				.limit(1);

			if (!row) {
				return null;
			}

			return {
				id: row.id,
				caseId: row.caseId,
				status: row.status,
				t0Provider: row.t0Provider,
				t1Provider: row.t1Provider,
				t0StacMetadata: row.t0StacMetadata as unknown as StoredRunStacMetadata,
				t1StacMetadata: row.t1StacMetadata as unknown as StoredRunStacMetadata,
				algorithmParams: row.algorithmParams,
				executedBy: row.executedBy,
				utmSrid: row.utmSrid,
				aoiAreaHa: Number(row.aoiAreaHa),
				aoiGeoJson: row.aoiGeoJson,
			};
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.findWorkerExecutionContext');
		}
	}

	async updateRunProcessingStage(
		runId: string,
		status: 'fetching_bands' | 'processing_ndvi' | 'vectorizing',
		db: DbExecutor = getDb(),
	): Promise<void> {
		try {
			await db
				.update(analysisRuns)
				.set({
					status,
					startedAt: sql`COALESCE(${analysisRuns.startedAt}, NOW())`,
				})
				.where(
					and(
						eq(analysisRuns.id, runId),
						inArray(analysisRuns.status, [
							'queued',
							'fetching_bands',
							'processing_ndvi',
							'vectorizing',
						]),
					),
				);
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.updateRunProcessingStage');
		}
	}

	// RN-01 & Spec Seção 5.3: Insere rasters e feições vetorizadas com recálculo geodésico oficial em SIRGAS 2000 UTM
	async completeRunInTransaction(
		params: {
			runId: string;
			utmSrid: number;
			aoiAreaHa: number;
			aoiTotalPixels: number;
			cloudMaskedPixels: number;
			rasters: PersistRasterAssetInput[];
			features: VectorizedFeaturePolygon[];
		},
		tx: DbExecutor,
	) {
		try {
			// Garante status = vectorizing antes de inserir em detected_features (exigido por trg_detected_features_guard)
			await tx
				.update(analysisRuns)
				.set({
					status: 'vectorizing',
					startedAt: sql`COALESCE(${analysisRuns.startedAt}, NOW())`,
				})
				.where(
					and(
						eq(analysisRuns.id, params.runId),
						inArray(analysisRuns.status, [
							'queued',
							'fetching_bands',
							'processing_ndvi',
							'vectorizing',
						]),
					),
				);

			if (params.rasters.length > 0) {
				await tx
					.insert(rasterAssets)
					.values(
						params.rasters.map((r) => ({
							runId: params.runId,
							assetType: r.assetType,
							storageBucket: r.storageBucket,
							storageKey: r.storageKey,
							mimeType: r.mimeType,
							sizeBytes: r.sizeBytes,
							sha256: r.sha256,
							widthPx: r.widthPx,
							heightPx: r.heightPx,
							bounds4674: r.bounds4674,
						})),
					)
					.onConflictDoNothing({
						target: [rasterAssets.runId, rasterAssets.assetType],
					});
			}

			if (params.features.length > 0) {
				const serializedFeatures = JSON.stringify(
					params.features.map((f) => ({
						featureClass: f.featureClass,
						geomGeoJson: f.geomGeoJson,
						pixelCount: Math.max(1, Math.trunc(f.pixelCount)),
						meanNdviT0: clampNumeric(f.meanNdviT0, -1, 1),
						meanNdviT1: clampNumeric(f.meanNdviT1, -1, 1),
						meanDeltaNdvi: clampNumeric(f.meanDeltaNdvi, -2, 2),
					})),
				);

				await tx.execute(sql`
          WITH raw_items AS (
            SELECT
              ordinality::int AS ord,
              (elem->>'featureClass')::feature_class AS feature_class,
              (elem->>'pixelCount')::int AS pixel_count,
              (elem->>'meanNdviT0')::numeric(6, 4) AS mean_ndvi_t0,
              (elem->>'meanNdviT1')::numeric(6, 4) AS mean_ndvi_t1,
              (elem->>'meanDeltaNdvi')::numeric(6, 4) AS mean_delta_ndvi,
              (elem->'geomGeoJson')::text AS geom_json
            FROM jsonb_array_elements(${serializedFeatures}::jsonb) WITH ORDINALITY AS t(elem, ordinality)
          ),
          dumped AS (
            SELECT
              ord,
              feature_class,
              pixel_count,
              mean_ndvi_t0,
              mean_ndvi_t1,
              mean_delta_ndvi,
              (ST_Dump(
                ST_CollectionExtract(
                  ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geom_json), 4674)),
                  3
                )
              )).geom AS poly_geom
            FROM raw_items
          ),
          measured AS (
            SELECT
              ord,
              feature_class,
              poly_geom,
              fn_calc_area_ha_sirgas(poly_geom, ${params.utmSrid}::integer) AS area_ha,
              pixel_count,
              mean_ndvi_t0,
              mean_ndvi_t1,
              mean_delta_ndvi,
              ST_PointOnSurface(poly_geom) AS pt_4674,
              ST_Transform(ST_PointOnSurface(poly_geom), ${params.utmSrid}::integer) AS pt_utm
            FROM dumped
            WHERE ST_GeometryType(poly_geom) = 'ST_Polygon'
              AND NOT ST_IsEmpty(poly_geom)
              AND ST_IsValid(poly_geom)
          )
          INSERT INTO detected_features (
            run_id,
            feature_sequence,
            feature_class,
            geom,
            area_ha,
            pixel_count,
            mean_ndvi_t0,
            mean_ndvi_t1,
            mean_delta_ndvi,
            centroid_lat,
            centroid_lon,
            centroid_utm_e,
            centroid_utm_n
          )
          SELECT
            ${params.runId}::uuid,
            ROW_NUMBER() OVER (ORDER BY area_ha DESC, ord ASC)::int,
            feature_class,
            poly_geom,
            area_ha,
            pixel_count,
            mean_ndvi_t0,
            mean_ndvi_t1,
            mean_delta_ndvi,
            ROUND(ST_Y(pt_4674)::numeric, 7),
            ROUND(ST_X(pt_4674)::numeric, 7),
            ROUND(ST_X(pt_utm)::numeric, 2),
            ROUND(ST_Y(pt_utm)::numeric, 2)
          FROM measured
          WHERE area_ha > 0
        `);
			}

			const aggRes = await tx.execute(sql`
        SELECT
          COALESCE(SUM(area_ha) FILTER (WHERE feature_class = 'deforestation' AND review_status <> 'dismissed_noise'), 0)::text AS def_ha,
          COALESCE(SUM(area_ha) FILTER (WHERE feature_class = 'degradation'   AND review_status <> 'dismissed_noise'), 0)::text AS deg_ha,
          COALESCE(SUM(area_ha) FILTER (WHERE feature_class = 'regrowth'      AND review_status <> 'dismissed_noise'), 0)::text AS reg_ha,
          COUNT(*) FILTER (WHERE review_status <> 'dismissed_noise')::int AS feature_count
        FROM detected_features
        WHERE run_id = ${params.runId}::uuid
      `);

			const aggRow = aggRes.rows[0] as
				| { def_ha?: string; deg_ha?: string; reg_ha?: string; feature_count?: number }
				| undefined;

			const deforestationHa = Number(aggRow?.def_ha ?? 0);
			const degradationHa = Number(aggRow?.deg_ha ?? 0);
			const regrowthHa = Number(aggRow?.reg_ha ?? 0);
			const featureCount = Number(aggRow?.feature_count ?? 0);

			const cloudMaskedHa =
				params.aoiTotalPixels > 0
					? Math.min(
							params.aoiAreaHa,
							Number(
								((params.aoiAreaHa * params.cloudMaskedPixels) / params.aoiTotalPixels).toFixed(4),
							),
						)
					: 0;
			const validAnalyzedHa = Number(Math.max(0, params.aoiAreaHa - cloudMaskedHa).toFixed(4));
			const stableHa = Number(
				Math.max(0, validAnalyzedHa - deforestationHa - degradationHa - regrowthHa).toFixed(4),
			);

			await tx
				.update(analysisRuns)
				.set({
					status: 'ready_for_review',
					finishedAt: new Date(),
					validAnalyzedHa: validAnalyzedHa.toFixed(4),
					cloudMaskedHa: cloudMaskedHa.toFixed(4),
					deforestationHa: deforestationHa.toFixed(4),
					degradationHa: degradationHa.toFixed(4),
					regrowthHa: regrowthHa.toFixed(4),
					stableHa: stableHa.toFixed(4),
					errorCode: null,
					errorDetail: null,
				})
				.where(eq(analysisRuns.id, params.runId));

			return {
				deforestationHa,
				degradationHa,
				regrowthHa,
				cloudMaskedHa,
				validAnalyzedHa,
				stableHa,
				featureCount,
			};
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.completeRunInTransaction');
		}
	}

	async markRunFailed(
		runId: string,
		errorCode: string,
		errorDetail: string,
		db: DbExecutor = getDb(),
	): Promise<void> {
		try {
			await db
				.update(analysisRuns)
				.set({
					status: 'failed',
					errorCode,
					errorDetail: errorDetail.slice(0, 500),
					finishedAt: new Date(),
				})
				.where(
					and(
						eq(analysisRuns.id, runId),
						inArray(analysisRuns.status, [
							'queued',
							'fetching_bands',
							'processing_ndvi',
							'vectorizing',
						]),
					),
				);
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.markRunFailed');
		}
	}

	async findSnapshotById(runId: string, db: DbExecutor = getDb()) {
		try {
			const [row] = await db
				.select({
					id: analysisRuns.id,
					status: analysisRuns.status,
					queuedAt: analysisRuns.queuedAt,
					startedAt: analysisRuns.startedAt,
					finishedAt: analysisRuns.finishedAt,
				})
				.from(analysisRuns)
				.where(eq(analysisRuns.id, runId))
				.limit(1);

			return row ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.findSnapshotById');
		}
	}

	async findDetailById(runId: string, db: DbExecutor = getDb()) {
		try {
			const [runRow] = await db
				.select({
					id: analysisRuns.id,
					caseId: analysisRuns.caseId,
					version: analysisRuns.version,
					status: analysisRuns.status,
					t0Provider: analysisRuns.t0Provider,
					t0Collection: analysisRuns.t0Collection,
					t0ItemIds: analysisRuns.t0ItemIds,
					t0AcquiredAt: analysisRuns.t0AcquiredAt,
					t0CloudPctAoi: analysisRuns.t0CloudPctAoi,
					t0StacMetadata: analysisRuns.t0StacMetadata,
					t1Provider: analysisRuns.t1Provider,
					t1Collection: analysisRuns.t1Collection,
					t1ItemIds: analysisRuns.t1ItemIds,
					t1AcquiredAt: analysisRuns.t1AcquiredAt,
					t1CloudPctAoi: analysisRuns.t1CloudPctAoi,
					t1StacMetadata: analysisRuns.t1StacMetadata,
					seasonalityWarning: analysisRuns.seasonalityWarning,
					presetName: analysisRuns.presetName,
					isCustomParams: analysisRuns.isCustomParams,
					algorithmParams: analysisRuns.algorithmParams,
					engineVersion: analysisRuns.engineVersion,
					validAnalyzedHa: analysisRuns.validAnalyzedHa,
					cloudMaskedHa: analysisRuns.cloudMaskedHa,
					deforestationHa: analysisRuns.deforestationHa,
					degradationHa: analysisRuns.degradationHa,
					regrowthHa: analysisRuns.regrowthHa,
					stableHa: analysisRuns.stableHa,
					errorCode: analysisRuns.errorCode,
					errorDetail: analysisRuns.errorDetail,
					queuedAt: analysisRuns.queuedAt,
					startedAt: analysisRuns.startedAt,
					finishedAt: analysisRuns.finishedAt,
					executorId: users.id,
					executorFullName: users.fullName,
					executorRegistrationCode: users.registrationCode,
				})
				.from(analysisRuns)
				.innerJoin(users, eq(analysisRuns.executedBy, users.id))
				.where(eq(analysisRuns.id, runId))
				.limit(1);

			if (!runRow) {
				return null;
			}

			const [rasters, countsRes] = await Promise.all([
				db
					.select()
					.from(rasterAssets)
					.where(eq(rasterAssets.runId, runId))
					.orderBy(asc(rasterAssets.assetType)),
				db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE review_status <> 'dismissed_noise')::int AS active_cnt,
            COUNT(*) FILTER (WHERE review_status = 'dismissed_noise')::int AS dismissed_cnt
          FROM detected_features
          WHERE run_id = ${runId}::uuid
        `),
			]);

			const counts = countsRes.rows[0] as { active_cnt?: number; dismissed_cnt?: number } | undefined;

			return {
				runRow,
				rasters,
				summary: buildAreaSummaryFromMetrics({
					validAnalyzedHa: runRow.validAnalyzedHa !== null ? Number(runRow.validAnalyzedHa) : null,
					cloudMaskedHa: runRow.cloudMaskedHa !== null ? Number(runRow.cloudMaskedHa) : null,
					deforestationHa:
						runRow.deforestationHa !== null ? Number(runRow.deforestationHa) : null,
					degradationHa: runRow.degradationHa !== null ? Number(runRow.degradationHa) : null,
					regrowthHa: runRow.regrowthHa !== null ? Number(runRow.regrowthHa) : null,
					stableHa: runRow.stableHa !== null ? Number(runRow.stableHa) : null,
					activeFeatureCount: Number(counts?.active_cnt ?? 0),
					dismissedFeatureCount: Number(counts?.dismissed_cnt ?? 0),
				}),
			};
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.findDetailById');
		}
	}

	async findRasterAsset(
		runId: string,
		assetType: RasterType,
		db: DbExecutor = getDb(),
	) {
		try {
			const [row] = await db
				.select()
				.from(rasterAssets)
				.where(and(eq(rasterAssets.runId, runId), eq(rasterAssets.assetType, assetType)))
				.limit(1);
			return row ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.findRasterAsset');
		}
	}

	async findFeaturesByRun(filter: ListRunFeaturesDbFilter, db: DbExecutor = getDb()) {
		try {
			const conditions: SQL[] = [eq(detectedFeatures.runId, filter.runId)];
			if (filter.reviewStatus) {
				conditions.push(eq(detectedFeatures.reviewStatus, filter.reviewStatus));
			}
			if (filter.featureClass) {
				conditions.push(eq(detectedFeatures.featureClass, filter.featureClass));
			}

			const whereClause = and(...conditions);

			const baseQuery = db
				.select({
					id: detectedFeatures.id,
					runId: detectedFeatures.runId,
					featureSequence: detectedFeatures.featureSequence,
					featureClass: detectedFeatures.featureClass,
					geomGeoJson: sql<DetectedFeaturePolygonGeoJson>`(ST_AsGeoJSON(${detectedFeatures.geom}, 7)::jsonb - 'crs')`,
					areaHa: detectedFeatures.areaHa,
					pixelCount: detectedFeatures.pixelCount,
					meanNdviT0: detectedFeatures.meanNdviT0,
					meanNdviT1: detectedFeatures.meanNdviT1,
					meanDeltaNdvi: detectedFeatures.meanDeltaNdvi,
					centroidLat: detectedFeatures.centroidLat,
					centroidLon: detectedFeatures.centroidLon,
					centroidUtmE: detectedFeatures.centroidUtmE,
					centroidUtmN: detectedFeatures.centroidUtmN,
					reviewStatus: detectedFeatures.reviewStatus,
					dismissalReason: detectedFeatures.dismissalReason,
					reviewedAt: detectedFeatures.reviewedAt,
					createdAt: detectedFeatures.createdAt,
					reviewerId: users.id,
					reviewerFullName: users.fullName,
					reviewerRegistrationCode: users.registrationCode,
				})
				.from(detectedFeatures)
				.leftJoin(users, eq(detectedFeatures.reviewedBy, users.id))
				.where(whereClause)
				.orderBy(desc(detectedFeatures.areaHa), asc(detectedFeatures.featureSequence));

			if (!filter.includePagination) {
				const rows = await baseQuery;
				return { total: rows.length, rows };
			}

			const offset = (filter.page - 1) * filter.limit;
			const [countRes, rows] = await Promise.all([
				db
					.select({ total: sql<number>`COUNT(*)::int` })
					.from(detectedFeatures)
					.where(whereClause),
				baseQuery.limit(filter.limit).offset(offset),
			]);

			return {
				total: Number(countRes[0]?.total ?? 0),
				rows,
			};
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.findFeaturesByRun');
		}
	}

	async lockRunForReview(runId: string, tx: DbExecutor) {
		try {
			const res = await tx.execute(
				sql`SELECT id, status FROM analysis_runs WHERE id = ${runId}::uuid FOR UPDATE`,
			);
			const row = res.rows[0] as { id?: string; status?: RunStatus } | undefined;
			if (!row?.id || !row.status) {
				return null;
			}
			return { id: row.id, status: row.status };
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.lockRunForReview');
		}
	}

	async findFeatureByIdInRun(
		runId: string,
		featureId: string,
		tx: DbExecutor,
	) {
		try {
			const [row] = await tx
				.select({
					id: detectedFeatures.id,
					reviewStatus: detectedFeatures.reviewStatus,
				})
				.from(detectedFeatures)
				.where(and(eq(detectedFeatures.id, featureId), eq(detectedFeatures.runId, runId)))
				.limit(1);
			return row ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.findFeatureByIdInRun');
		}
	}

	// Modelagem Física Seção 8.2: Atualiza revisão e recalcula totais consolidados diretamente no PostgreSQL
	async updateFeatureReviewAndRecalculateAreas(
		params: {
			runId: string;
			featureId: string;
			reviewStatus: ReviewStatus;
			dismissalReason: string | null;
			reviewedBy: string;
		},
		tx: DbExecutor,
	) {
		try {
			await tx
				.update(detectedFeatures)
				.set({
					reviewStatus: params.reviewStatus,
					dismissalReason: params.dismissalReason,
					reviewedBy: params.reviewedBy,
					reviewedAt: new Date(),
				})
				.where(
					and(
						eq(detectedFeatures.id, params.featureId),
						eq(detectedFeatures.runId, params.runId),
					),
				);

			const updateRes = await tx.execute(sql`
        WITH agg AS (
          SELECT
            COALESCE(SUM(area_ha) FILTER (WHERE feature_class = 'deforestation' AND review_status <> 'dismissed_noise'), 0)::NUMERIC(14, 4) AS def_ha,
            COALESCE(SUM(area_ha) FILTER (WHERE feature_class = 'degradation'   AND review_status <> 'dismissed_noise'), 0)::NUMERIC(14, 4) AS deg_ha,
            COALESCE(SUM(area_ha) FILTER (WHERE feature_class = 'regrowth'      AND review_status <> 'dismissed_noise'), 0)::NUMERIC(14, 4) AS reg_ha,
            COUNT(*) FILTER (WHERE review_status <> 'dismissed_noise')::int AS active_cnt,
            COUNT(*) FILTER (WHERE review_status = 'dismissed_noise')::int AS dismissed_cnt
          FROM detected_features
          WHERE run_id = ${params.runId}::uuid
        )
        UPDATE analysis_runs r
        SET
          deforestation_ha = agg.def_ha,
          degradation_ha   = agg.deg_ha,
          regrowth_ha      = agg.reg_ha,
          stable_ha        = GREATEST(0, COALESCE(r.valid_analyzed_ha, 0) - agg.def_ha - agg.deg_ha - agg.reg_ha)::NUMERIC(14, 4)
        FROM agg
        WHERE r.id = ${params.runId}::uuid
          AND r.status = 'ready_for_review'
        RETURNING
          r.valid_analyzed_ha::text,
          r.cloud_masked_ha::text,
          r.deforestation_ha::text,
          r.degradation_ha::text,
          r.regrowth_ha::text,
          r.stable_ha::text,
          agg.active_cnt,
          agg.dismissed_cnt
      `);

			const updatedRow = updateRes.rows[0] as
				| {
						valid_analyzed_ha: string | null;
						cloud_masked_ha: string | null;
						deforestation_ha: string | null;
						degradation_ha: string | null;
						regrowth_ha: string | null;
						stable_ha: string | null;
						active_cnt: number;
						dismissed_cnt: number;
				  }
				| undefined;

			const [featureRow] = await tx
				.select({
					id: detectedFeatures.id,
					runId: detectedFeatures.runId,
					featureSequence: detectedFeatures.featureSequence,
					featureClass: detectedFeatures.featureClass,
					areaHa: detectedFeatures.areaHa,
					pixelCount: detectedFeatures.pixelCount,
					meanNdviT0: detectedFeatures.meanNdviT0,
					meanNdviT1: detectedFeatures.meanNdviT1,
					meanDeltaNdvi: detectedFeatures.meanDeltaNdvi,
					centroidLat: detectedFeatures.centroidLat,
					centroidLon: detectedFeatures.centroidLon,
					centroidUtmE: detectedFeatures.centroidUtmE,
					centroidUtmN: detectedFeatures.centroidUtmN,
					reviewStatus: detectedFeatures.reviewStatus,
					dismissalReason: detectedFeatures.dismissalReason,
					reviewedAt: detectedFeatures.reviewedAt,
					createdAt: detectedFeatures.createdAt,
					reviewerId: users.id,
					reviewerFullName: users.fullName,
					reviewerRegistrationCode: users.registrationCode,
				})
				.from(detectedFeatures)
				.leftJoin(users, eq(detectedFeatures.reviewedBy, users.id))
				.where(
					and(
						eq(detectedFeatures.id, params.featureId),
						eq(detectedFeatures.runId, params.runId),
					),
				)
				.limit(1);

			const updatedSummary = buildAreaSummaryFromMetrics({
				validAnalyzedHa:
					updatedRow?.valid_analyzed_ha !== null && updatedRow?.valid_analyzed_ha !== undefined
						? Number(updatedRow.valid_analyzed_ha)
						: null,
				cloudMaskedHa:
					updatedRow?.cloud_masked_ha !== null && updatedRow?.cloud_masked_ha !== undefined
						? Number(updatedRow.cloud_masked_ha)
						: null,
				deforestationHa:
					updatedRow?.deforestation_ha !== null && updatedRow?.deforestation_ha !== undefined
						? Number(updatedRow.deforestation_ha)
						: null,
				degradationHa:
					updatedRow?.degradation_ha !== null && updatedRow?.degradation_ha !== undefined
						? Number(updatedRow.degradation_ha)
						: null,
				regrowthHa:
					updatedRow?.regrowth_ha !== null && updatedRow?.regrowth_ha !== undefined
						? Number(updatedRow.regrowth_ha)
						: null,
				stableHa:
					updatedRow?.stable_ha !== null && updatedRow?.stable_ha !== undefined
						? Number(updatedRow.stable_ha)
						: null,
				activeFeatureCount: Number(updatedRow?.active_cnt ?? 0),
				dismissedFeatureCount: Number(updatedRow?.dismissed_cnt ?? 0),
			});

			return { featureRow: featureRow!, updatedSummary };
		} catch (error) {
			throw parseDatabaseError(error, 'RunRepository.updateFeatureReviewAndRecalculateAreas');
		}
	}
}

export default new RunRepository();
