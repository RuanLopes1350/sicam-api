import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { type DbExecutor, getDb } from '../config/dbConfig.js';
import { rasterAssets } from '../config/db/schema/artifacts.js';
import { analysisCases } from '../config/db/schema/cases.js';
import type {
	FeatureClass,
	RasterType,
	StacProvider,
} from '../config/db/schema/enums.js';
import { detectedFeatures } from '../config/db/schema/features.js';
import { analysisRuns } from '../config/db/schema/runs.js';
import { ibgeMunicipalities, ibgeStates } from '../config/db/schema/territories.js';
import { users } from '../config/db/schema/users.js';
import type { AlgorithmParams } from '../config/presets.js';
import type { GeoJsonPolygonOrMulti } from '../utils/geo/cartography/insetMapSvg.js';
import { parseDatabaseError } from '../utils/helpers/dbErrors.js';
import type { AoiPolygonGeoJson } from '../utils/validation/caseValidation.js';
import type { DetectedFeaturePolygonGeoJson } from '../utils/validation/runValidation.js';
import type { StoredRunStacMetadata } from './runRepository.js';

export interface CartographyRunBundle {
	runId: string;
	caseId: string;
	version: number;
	status: string;
	protocolCode: string;
	externalRef: string | null;
	title: string;
	primaryMunicipalityIbge: string | null;
	primaryMunicipalityName: string | null;
	stateUf: string | null;
	intersectedMunicipalities: Array<{
		ibgeCode: string;
		name: string;
		ufCode: string;
		overlapHa: number;
		overlapPct: number;
	}>;
	utmSrid: number;
	aoiAreaHa: number;
	aoiGeoJson: AoiPolygonGeoJson;
	aoiBoundsUtm: [number, number, number, number];
	aoiCenterLonLat: [number, number];
	aoiCenterUtm: [number, number];
	t0Provider: StacProvider;
	t0Collection: string;
	t0ItemIds: string[];
	t0AcquiredAt: Date;
	t0CloudPctAoi: number;
	t0StacMetadata: StoredRunStacMetadata;
	t1Provider: StacProvider;
	t1Collection: string;
	t1ItemIds: string[];
	t1AcquiredAt: Date;
	t1CloudPctAoi: number;
	t1StacMetadata: StoredRunStacMetadata;
	seasonalityWarning: boolean;
	presetName: string;
	isCustomParams: boolean;
	algorithmParams: AlgorithmParams;
	engineVersion: string;
	validAnalyzedHa: number;
	cloudMaskedHa: number;
	deforestationHa: number;
	degradationHa: number;
	regrowthHa: number;
	stableHa: number;
	executor: {
		id: string;
		fullName: string;
		registrationCode: string;
	};
	activeFeatures: Array<{
		id: string;
		featureSequence: number;
		featureClass: FeatureClass;
		geomGeoJson: DetectedFeaturePolygonGeoJson;
		areaHa: number;
		centroidUtmE: number;
		centroidUtmN: number;
	}>;
	rastersByType: Partial<
		Record<
			RasterType,
			{
				storageBucket: string;
				storageKey: string;
				sha256: string;
				widthPx: number;
				heightPx: number;
			}
		>
	>;
	ibgeInset: {
		stateName: string | null;
		stateGeom: GeoJsonPolygonOrMulti | null;
		municipalities: Array<{
			ibgeCode: string;
			name: string;
			geom: GeoJsonPolygonOrMulti;
		}>;
	};
}

// Camada Repository ("Estoquista"): consultas PostGIS consolidadas para montagem da Carta-Imagem A4/A3
export class CartographyRepository {
	async findCartographyRunBundle(
		runId: string,
		db: DbExecutor = getDb(),
	): Promise<CartographyRunBundle | null> {
		try {
			const [runHeader] = await db
				.select({
					runId: analysisRuns.id,
					caseId: analysisRuns.caseId,
					version: analysisRuns.version,
					status: analysisRuns.status,
					protocolCode: analysisCases.protocolCode,
					externalRef: analysisCases.externalRef,
					title: analysisCases.title,
					primaryMunicipalityIbge: analysisCases.primaryMunicipalityIbge,
					primaryMunicipalityName: analysisCases.primaryMunicipalityName,
					stateUf: analysisCases.stateUf,
					intersectedMunicipalities: analysisCases.intersectedMunicipalities,
					utmSrid: analysisCases.utmSrid,
					aoiAreaHa: analysisCases.aoiAreaHa,
					aoiGeoJson: sql<AoiPolygonGeoJson>`(ST_AsGeoJSON(${analysisCases.aoiGeom}, 7)::jsonb - 'crs')`,
					aoiMinUtmE: sql<number>`ST_XMin(ST_Transform(${analysisCases.aoiGeom}, ${analysisCases.utmSrid}))::float8`,
					aoiMinUtmN: sql<number>`ST_YMin(ST_Transform(${analysisCases.aoiGeom}, ${analysisCases.utmSrid}))::float8`,
					aoiMaxUtmE: sql<number>`ST_XMax(ST_Transform(${analysisCases.aoiGeom}, ${analysisCases.utmSrid}))::float8`,
					aoiMaxUtmN: sql<number>`ST_YMax(ST_Transform(${analysisCases.aoiGeom}, ${analysisCases.utmSrid}))::float8`,
					aoiCenterLon: sql<number>`ST_X(ST_PointOnSurface(${analysisCases.aoiGeom}))::float8`,
					aoiCenterLat: sql<number>`ST_Y(ST_PointOnSurface(${analysisCases.aoiGeom}))::float8`,
					aoiCenterUtmE: sql<number>`ST_X(ST_Transform(ST_PointOnSurface(${analysisCases.aoiGeom}), ${analysisCases.utmSrid}))::float8`,
					aoiCenterUtmN: sql<number>`ST_Y(ST_Transform(ST_PointOnSurface(${analysisCases.aoiGeom}), ${analysisCases.utmSrid}))::float8`,
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
					executorId: users.id,
					executorFullName: users.fullName,
					executorRegistrationCode: users.registrationCode,
				})
				.from(analysisRuns)
				.innerJoin(analysisCases, eq(analysisRuns.caseId, analysisCases.id))
				.innerJoin(users, eq(analysisRuns.executedBy, users.id))
				.where(eq(analysisRuns.id, runId))
				.limit(1);

			if (!runHeader) {
				return null;
			}

			const ufClean = runHeader.stateUf?.trim() ?? null;

			const [featureRows, rasterRows, stateRows, municipalityRows] = await Promise.all([
				db
					.select({
						id: detectedFeatures.id,
						featureSequence: detectedFeatures.featureSequence,
						featureClass: detectedFeatures.featureClass,
						geomGeoJson: sql<DetectedFeaturePolygonGeoJson>`(ST_AsGeoJSON(${detectedFeatures.geom}, 7)::jsonb - 'crs')`,
						areaHa: detectedFeatures.areaHa,
						centroidUtmE: detectedFeatures.centroidUtmE,
						centroidUtmN: detectedFeatures.centroidUtmN,
					})
					.from(detectedFeatures)
					.where(
						and(
							eq(detectedFeatures.runId, runId),
							ne(detectedFeatures.reviewStatus, 'dismissed_noise'),
						),
					)
					.orderBy(desc(detectedFeatures.areaHa), asc(detectedFeatures.featureSequence)),
				db.select().from(rasterAssets).where(eq(rasterAssets.runId, runId)),
				ufClean
					? db
							.select({
								name: ibgeStates.name,
								geom: sql<GeoJsonPolygonOrMulti>`(ST_AsGeoJSON(${ibgeStates.geomSimplified4674}, 6)::jsonb - 'crs')`,
							})
							.from(ibgeStates)
							.where(eq(ibgeStates.ufCode, ufClean))
							.limit(1)
					: Promise.resolve([]),
				ufClean
					? db
							.select({
								ibgeCode: ibgeMunicipalities.ibgeCode,
								name: ibgeMunicipalities.name,
								geom: sql<GeoJsonPolygonOrMulti>`(ST_AsGeoJSON(${ibgeMunicipalities.geomSimplified4674}, 6)::jsonb - 'crs')`,
							})
							.from(ibgeMunicipalities)
							.where(eq(ibgeMunicipalities.ufCode, ufClean))
							.orderBy(asc(ibgeMunicipalities.name))
					: Promise.resolve([]),
			]);

			const rastersByType: CartographyRunBundle['rastersByType'] = {};
			for (const r of rasterRows) {
				rastersByType[r.assetType] = {
					storageBucket: r.storageBucket,
					storageKey: r.storageKey,
					sha256: r.sha256,
					widthPx: r.widthPx,
					heightPx: r.heightPx,
				};
			}

			return {
				runId: runHeader.runId,
				caseId: runHeader.caseId,
				version: runHeader.version,
				status: runHeader.status,
				protocolCode: runHeader.protocolCode,
				externalRef: runHeader.externalRef,
				title: runHeader.title,
				primaryMunicipalityIbge: runHeader.primaryMunicipalityIbge?.trim() ?? null,
				primaryMunicipalityName: runHeader.primaryMunicipalityName,
				stateUf: ufClean,
				intersectedMunicipalities: runHeader.intersectedMunicipalities,
				utmSrid: runHeader.utmSrid,
				aoiAreaHa: Number(runHeader.aoiAreaHa),
				aoiGeoJson: runHeader.aoiGeoJson,
				aoiBoundsUtm: [
					runHeader.aoiMinUtmE,
					runHeader.aoiMinUtmN,
					runHeader.aoiMaxUtmE,
					runHeader.aoiMaxUtmN,
				],
				aoiCenterLonLat: [runHeader.aoiCenterLon, runHeader.aoiCenterLat],
				aoiCenterUtm: [runHeader.aoiCenterUtmE, runHeader.aoiCenterUtmN],
				t0Provider: runHeader.t0Provider,
				t0Collection: runHeader.t0Collection,
				t0ItemIds: runHeader.t0ItemIds,
				t0AcquiredAt: runHeader.t0AcquiredAt,
				t0CloudPctAoi: Number(runHeader.t0CloudPctAoi),
				t0StacMetadata: runHeader.t0StacMetadata as unknown as StoredRunStacMetadata,
				t1Provider: runHeader.t1Provider,
				t1Collection: runHeader.t1Collection,
				t1ItemIds: runHeader.t1ItemIds,
				t1AcquiredAt: runHeader.t1AcquiredAt,
				t1CloudPctAoi: Number(runHeader.t1CloudPctAoi),
				t1StacMetadata: runHeader.t1StacMetadata as unknown as StoredRunStacMetadata,
				seasonalityWarning: runHeader.seasonalityWarning,
				presetName: runHeader.presetName,
				isCustomParams: runHeader.isCustomParams,
				algorithmParams: runHeader.algorithmParams,
				engineVersion: runHeader.engineVersion,
				validAnalyzedHa: Number(runHeader.validAnalyzedHa ?? runHeader.aoiAreaHa),
				cloudMaskedHa: Number(runHeader.cloudMaskedHa ?? 0),
				deforestationHa: Number(runHeader.deforestationHa ?? 0),
				degradationHa: Number(runHeader.degradationHa ?? 0),
				regrowthHa: Number(runHeader.regrowthHa ?? 0),
				stableHa: Number(runHeader.stableHa ?? runHeader.aoiAreaHa),
				executor: {
					id: runHeader.executorId,
					fullName: runHeader.executorFullName,
					registrationCode: runHeader.executorRegistrationCode,
				},
				activeFeatures: featureRows.map((f) => ({
					id: f.id,
					featureSequence: f.featureSequence,
					featureClass: f.featureClass,
					geomGeoJson: f.geomGeoJson,
					areaHa: Number(f.areaHa),
					centroidUtmE: Number(f.centroidUtmE),
					centroidUtmN: Number(f.centroidUtmN),
				})),
				rastersByType,
				ibgeInset: {
					stateName: stateRows[0]?.name ?? null,
					stateGeom: stateRows[0]?.geom ?? null,
					municipalities: municipalityRows.map((m) => ({
						ibgeCode: m.ibgeCode.trim(),
						name: m.name,
						geom: m.geom,
					})),
				},
			};
		} catch (error) {
			throw parseDatabaseError(error, 'CartographyRepository.findCartographyRunBundle');
		}
	}
}

export default new CartographyRepository();
