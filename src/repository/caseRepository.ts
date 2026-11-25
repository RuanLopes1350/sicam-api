import { and, desc, eq, gte, ilike, lte, or, type SQL, sql } from 'drizzle-orm';
import { type DbExecutor, getDb, getPool } from '../config/dbConfig.js';
import { analysisCases, type IntersectedMunicipalityInfo } from '../config/db/schema/cases.js';
import type { RunStatus } from '../config/db/schema/enums.js';
import { analysisRuns } from '../config/db/schema/runs.js';
import { users } from '../config/db/schema/users.js';
import { parseDatabaseError } from '../utils/helpers/dbErrors.js';
import type { AoiPolygonGeoJson } from '../utils/validation/caseValidation.js';

export interface PostgisGeometryEvaluation {
	isValid: boolean;
	validReason: string;
	isSimple: boolean;
	isEmpty: boolean;
	nRings: number;
	geomType: string;
	utmSrid: number | null;
	areaHa: number | null;
	perimeterM: number | null;
	canonicalGeoJson: AoiPolygonGeoJson;
}

export interface TerritoryOverlapEvaluation {
	coveredStates: string[];
	intersectedMunicipalities: IntersectedMunicipalityInfo[];
}

export interface CreateCasePersistInput {
	title: string;
	externalRef: string | null;
	description: string | null;
	primaryMunicipalityIbge: string | null;
	primaryMunicipalityName: string | null;
	stateUf: string | null;
	intersectedMunicipalities: IntersectedMunicipalityInfo[];
	geoJsonString: string;
	aoiAreaHa: string;
	aoiPerimeterM: string;
	utmSrid: number;
	createdBy: string;
}

export interface ListCasesDbFilter {
	q?: string;
	stateUf?: string;
	municipalityIbge?: string;
	bbox?: [number, number, number, number];
	status?: RunStatus | 'no_runs';
	createdBy?: string;
	from?: Date;
	to?: Date;
	page: number;
	limit: number;
}

class CaseRepository {
	// Valida topologia e extrai métricas geodésicas oficiais exclusivamente no PostGIS (RN-01)
	async evaluateAoiGeometry(geoJsonString: string): Promise<PostgisGeometryEvaluation> {
		try {
			const pool = getPool();
			const res = await pool.query<{
				is_valid: boolean;
				valid_reason: string;
				is_simple: boolean;
				is_empty: boolean;
				n_rings: number;
				geom_type: string;
				utm_srid: number | null;
				area_ha: string | null;
				perimeter_m: string | null;
				canonical_geojson: AoiPolygonGeoJson;
			}>(
				`
        WITH input_geom AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4674) AS geom
        ),
        validity AS (
          SELECT
            geom,
            ST_IsValid(geom) AS is_valid,
            ST_IsValidReason(geom) AS valid_reason,
            ST_IsSimple(geom) AS is_simple,
            ST_IsEmpty(geom) AS is_empty,
            ST_NRings(geom) AS n_rings,
            ST_GeometryType(geom) AS geom_type
          FROM input_geom
        )
        SELECT
          is_valid,
          valid_reason,
          is_simple,
          is_empty,
          n_rings,
          geom_type,
          CASE
            WHEN is_valid AND is_simple AND NOT is_empty AND n_rings = 1 AND geom_type = 'ST_Polygon'
            THEN fn_get_sirgas_utm_srid(geom)
            ELSE NULL
          END AS utm_srid,
          CASE
            WHEN is_valid AND is_simple AND NOT is_empty AND n_rings = 1 AND geom_type = 'ST_Polygon'
            THEN fn_calc_area_ha_sirgas(geom)
            ELSE NULL
          END AS area_ha,
          CASE
            WHEN is_valid AND is_simple AND NOT is_empty AND n_rings = 1 AND geom_type = 'ST_Polygon'
            THEN ROUND(ST_Perimeter(ST_Transform(geom, fn_get_sirgas_utm_srid(geom)))::NUMERIC, 2)
            ELSE NULL
          END AS perimeter_m,
          (ST_AsGeoJSON(geom, 7)::jsonb - 'crs') AS canonical_geojson
        FROM validity;
        `,
				[geoJsonString],
			);

			const row = res.rows[0];
			if (!row) {
				throw new Error('Falha ao avaliar geometria no PostGIS.');
			}

			return {
				isValid: row.is_valid,
				validReason: row.valid_reason,
				isSimple: row.is_simple,
				isEmpty: row.is_empty,
				nRings: Number(row.n_rings),
				geomType: row.geom_type,
				utmSrid: row.utm_srid !== null ? Number(row.utm_srid) : null,
				areaHa: row.area_ha !== null ? Number(row.area_ha) : null,
				perimeterM: row.perimeter_m !== null ? Number(row.perimeter_m) : null,
				canonicalGeoJson: row.canonical_geojson,
			};
		} catch (error) {
			throw parseDatabaseError(error, 'CaseRepository.evaluateAoiGeometry');
		}
	}

	// Modelagem Física Seção 8.1: Interseção espacial com estados e municípios da malha oficial IBGE
	async findTerritoryOverlaps(
		geoJsonString: string,
		utmSrid: number,
	): Promise<TerritoryOverlapEvaluation> {
		try {
			const pool = getPool();
			const [statesRes, munRes] = await Promise.all([
				pool.query<{ uf_code: string }>(
					`
          WITH aoi AS (
            SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4674) AS geom
          )
          SELECT s.uf_code
          FROM aoi a
          JOIN ibge_states s ON ST_Intersects(a.geom, s.geom_4674)
          ORDER BY ST_Area(ST_Transform(ST_Intersection(a.geom, s.geom_4674), $2::integer)) DESC;
          `,
					[geoJsonString, utmSrid],
				),
				pool.query<{
					ibge_code: string;
					name: string;
					uf_code: string;
					overlap_ha: string;
					overlap_pct: string;
				}>(
					`
          WITH aoi AS (
            SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4674) AS geom
          ),
          mun_overlaps AS (
            SELECT
              m.ibge_code,
              m.name,
              m.uf_code,
              ST_Area(ST_Transform(ST_Intersection(a.geom, m.geom_4674), $2::integer)) / 10000.0 AS overlap_ha,
              ST_Area(ST_Transform(a.geom, $2::integer)) / 10000.0 AS total_aoi_ha
            FROM aoi a
            JOIN ibge_municipalities m ON ST_Intersects(a.geom, m.geom_4674)
          )
          SELECT
            ibge_code,
            name,
            uf_code,
            ROUND(overlap_ha::NUMERIC, 4) AS overlap_ha,
            ROUND(((overlap_ha / NULLIF(total_aoi_ha, 0)) * 100.0)::NUMERIC, 2) AS overlap_pct
          FROM mun_overlaps
          WHERE overlap_ha > 0.0001
          ORDER BY overlap_ha DESC;
          `,
					[geoJsonString, utmSrid],
				),
			]);

			return {
				coveredStates: statesRes.rows.map((r) => r.uf_code.trim()),
				intersectedMunicipalities: munRes.rows.map((r) => ({
					ibgeCode: r.ibge_code.trim(),
					name: r.name,
					ufCode: r.uf_code.trim(),
					overlapHa: Number(r.overlap_ha),
					overlapPct: Number(r.overlap_pct),
				})),
			};
		} catch (error) {
			throw parseDatabaseError(error, 'CaseRepository.findTerritoryOverlaps');
		}
	}

	async create(input: CreateCasePersistInput, db: DbExecutor = getDb()) {
		try {
			const [inserted] = await db
				.insert(analysisCases)
				.values({
					title: input.title,
					externalRef: input.externalRef,
					description: input.description,
					primaryMunicipalityIbge: input.primaryMunicipalityIbge,
					primaryMunicipalityName: input.primaryMunicipalityName,
					stateUf: input.stateUf,
					intersectedMunicipalities: input.intersectedMunicipalities,
					aoiGeom: sql`ST_SetSRID(ST_GeomFromGeoJSON(${input.geoJsonString}), 4674)`,
					aoiAreaHa: input.aoiAreaHa,
					aoiPerimeterM: input.aoiPerimeterM,
					utmSrid: input.utmSrid,
					createdBy: input.createdBy,
				})
				.returning({
					id: analysisCases.id,
					protocolCode: analysisCases.protocolCode,
					externalRef: analysisCases.externalRef,
					title: analysisCases.title,
					description: analysisCases.description,
					primaryMunicipalityIbge: analysisCases.primaryMunicipalityIbge,
					primaryMunicipalityName: analysisCases.primaryMunicipalityName,
					stateUf: analysisCases.stateUf,
					intersectedMunicipalities: analysisCases.intersectedMunicipalities,
					aoiAreaHa: analysisCases.aoiAreaHa,
					aoiPerimeterM: analysisCases.aoiPerimeterM,
					utmSrid: analysisCases.utmSrid,
					aoiGeoJson: sql<AoiPolygonGeoJson>`(ST_AsGeoJSON(${analysisCases.aoiGeom}, 7)::jsonb - 'crs')`,
					createdBy: analysisCases.createdBy,
					createdAt: analysisCases.createdAt,
					updatedAt: analysisCases.updatedAt,
				});

			if (!inserted) {
				throw new Error('Falha ao persistir caso de análise.');
			}
			return inserted;
		} catch (error) {
			throw parseDatabaseError(error, 'CaseRepository.create');
		}
	}

	async findByIdWithRuns(caseId: string, db: DbExecutor = getDb()) {
		try {
			const [caseRow] = await db
				.select({
					id: analysisCases.id,
					protocolCode: analysisCases.protocolCode,
					externalRef: analysisCases.externalRef,
					title: analysisCases.title,
					description: analysisCases.description,
					primaryMunicipalityIbge: analysisCases.primaryMunicipalityIbge,
					primaryMunicipalityName: analysisCases.primaryMunicipalityName,
					stateUf: analysisCases.stateUf,
					intersectedMunicipalities: analysisCases.intersectedMunicipalities,
					aoiAreaHa: analysisCases.aoiAreaHa,
					aoiPerimeterM: analysisCases.aoiPerimeterM,
					utmSrid: analysisCases.utmSrid,
					aoiGeoJson: sql<AoiPolygonGeoJson>`(ST_AsGeoJSON(${analysisCases.aoiGeom}, 7)::jsonb - 'crs')`,
					creatorId: users.id,
					creatorFullName: users.fullName,
					creatorRegistrationCode: users.registrationCode,
					createdAt: analysisCases.createdAt,
					updatedAt: analysisCases.updatedAt,
				})
				.from(analysisCases)
				.innerJoin(users, eq(analysisCases.createdBy, users.id))
				.where(eq(analysisCases.id, caseId))
				.limit(1);

			if (!caseRow) {
				return null;
			}

			const runRows = await db
				.select({
					id: analysisRuns.id,
					version: analysisRuns.version,
					status: analysisRuns.status,
					presetName: analysisRuns.presetName,
					isCustomParams: analysisRuns.isCustomParams,
					seasonalityWarning: analysisRuns.seasonalityWarning,
					t0AcquiredAt: analysisRuns.t0AcquiredAt,
					t1AcquiredAt: analysisRuns.t1AcquiredAt,
					deforestationHa: analysisRuns.deforestationHa,
					degradationHa: analysisRuns.degradationHa,
					regrowthHa: analysisRuns.regrowthHa,
					cloudMaskedHa: analysisRuns.cloudMaskedHa,
					queuedAt: analysisRuns.queuedAt,
					finishedAt: analysisRuns.finishedAt,
				})
				.from(analysisRuns)
				.where(eq(analysisRuns.caseId, caseId))
				.orderBy(desc(analysisRuns.version));

			return { caseRow, runRows };
		} catch (error) {
			throw parseDatabaseError(error, 'CaseRepository.findByIdWithRuns');
		}
	}

	async findManyPaginated(filter: ListCasesDbFilter, db: DbExecutor = getDb()) {
		try {
			const conditions: SQL[] = [];

			if (filter.q) {
				const pattern = `%${filter.q}%`;
				const searchOr = or(
					ilike(analysisCases.protocolCode, pattern),
					ilike(analysisCases.title, pattern),
					ilike(analysisCases.externalRef, pattern),
				);
				if (searchOr) {
					conditions.push(searchOr);
				}
			}

			if (filter.stateUf) {
				conditions.push(eq(analysisCases.stateUf, filter.stateUf));
			}

			if (filter.municipalityIbge) {
				const munJsonFilter = JSON.stringify([{ ibgeCode: filter.municipalityIbge }]);
				const munOr = or(
					eq(analysisCases.primaryMunicipalityIbge, filter.municipalityIbge),
					sql`${analysisCases.intersectedMunicipalities} @> ${munJsonFilter}::jsonb`,
				);
				if (munOr) {
					conditions.push(munOr);
				}
			}

			if (filter.bbox) {
				const [minLon, minLat, maxLon, maxLat] = filter.bbox;
				conditions.push(
					sql`ST_Intersects(${analysisCases.aoiGeom}, ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4674))`,
				);
			}

			if (filter.createdBy) {
				conditions.push(eq(analysisCases.createdBy, filter.createdBy));
			}

			if (filter.from) {
				conditions.push(gte(analysisCases.createdAt, filter.from));
			}

			if (filter.to) {
				conditions.push(lte(analysisCases.createdAt, filter.to));
			}

			if (filter.status === 'no_runs') {
				conditions.push(
					sql`NOT EXISTS (SELECT 1 FROM analysis_runs ar WHERE ar.case_id = ${analysisCases.id})`,
				);
			} else if (filter.status) {
				conditions.push(
					sql`(
            SELECT ar.status
            FROM analysis_runs ar
            WHERE ar.case_id = ${analysisCases.id}
            ORDER BY ar.version DESC
            LIMIT 1
          ) = ${filter.status}::run_status`,
				);
			}

			const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
			const offset = (filter.page - 1) * filter.limit;

			const [countRes, rows] = await Promise.all([
				db
					.select({ total: sql<number>`COUNT(*)::int` })
					.from(analysisCases)
					.where(whereClause),
				db
					.select({
						id: analysisCases.id,
						protocolCode: analysisCases.protocolCode,
						externalRef: analysisCases.externalRef,
						title: analysisCases.title,
						description: analysisCases.description,
						primaryMunicipalityIbge: analysisCases.primaryMunicipalityIbge,
						primaryMunicipalityName: analysisCases.primaryMunicipalityName,
						stateUf: analysisCases.stateUf,
						intersectedMunicipalities: analysisCases.intersectedMunicipalities,
						aoiAreaHa: analysisCases.aoiAreaHa,
						aoiPerimeterM: analysisCases.aoiPerimeterM,
						utmSrid: analysisCases.utmSrid,
						aoiGeoJson: sql<AoiPolygonGeoJson>`(ST_AsGeoJSON(${analysisCases.aoiGeom}, 7)::jsonb - 'crs')`,
						creatorId: users.id,
						creatorFullName: users.fullName,
						creatorRegistrationCode: users.registrationCode,
						createdAt: analysisCases.createdAt,
						updatedAt: analysisCases.updatedAt,
						runsCount: sql<number>`(
              SELECT COUNT(*)::int
              FROM analysis_runs ar
              WHERE ar.case_id = ${analysisCases.id}
            )`,
						latestRunStatus: sql<RunStatus | null>`(
              SELECT ar.status
              FROM analysis_runs ar
              WHERE ar.case_id = ${analysisCases.id}
              ORDER BY ar.version DESC
              LIMIT 1
            )`,
					})
					.from(analysisCases)
					.innerJoin(users, eq(analysisCases.createdBy, users.id))
					.where(whereClause)
					.orderBy(desc(analysisCases.createdAt))
					.limit(filter.limit)
					.offset(offset),
			]);

			return {
				total: countRes[0]?.total ?? 0,
				rows,
			};
		} catch (error) {
			throw parseDatabaseError(error, 'CaseRepository.findManyPaginated');
		}
	}

	async updateMetadataById(
		caseId: string,
		patch: Partial<{ title: string; externalRef: string | null; description: string | null }>,
		db: DbExecutor = getDb(),
	) {
		try {
			const [updated] = await db
				.update(analysisCases)
				.set(patch)
				.where(eq(analysisCases.id, caseId))
				.returning({ id: analysisCases.id });

			if (!updated) {
				return null;
			}

			return await this.findByIdWithRuns(caseId, db);
		} catch (error) {
			throw parseDatabaseError(error, 'CaseRepository.updateMetadataById');
		}
	}

	async findSpatialEnvelopeById(caseId: string, db: DbExecutor = getDb()) {
		try {
			const [row] = await db
				.select({
					id: analysisCases.id,
					utmSrid: analysisCases.utmSrid,
					aoiGeoJson: sql<AoiPolygonGeoJson>`(ST_AsGeoJSON(${analysisCases.aoiGeom}, 7)::jsonb - 'crs')`,
					minLon: sql<number>`ST_XMin(${analysisCases.aoiGeom})::float8`,
					minLat: sql<number>`ST_YMin(${analysisCases.aoiGeom})::float8`,
					maxLon: sql<number>`ST_XMax(${analysisCases.aoiGeom})::float8`,
					maxLat: sql<number>`ST_YMax(${analysisCases.aoiGeom})::float8`,
				})
				.from(analysisCases)
				.where(eq(analysisCases.id, caseId))
				.limit(1);

			if (!row) {
				return null;
			}

			return {
				id: row.id,
				utmSrid: row.utmSrid,
				aoiGeoJson: row.aoiGeoJson,
				bbox: [row.minLon, row.minLat, row.maxLon, row.maxLat] as [
					number,
					number,
					number,
					number,
				],
			};
		} catch (error) {
			throw parseDatabaseError(error, 'CaseRepository.findSpatialEnvelopeById');
		}
	}
}

export default new CaseRepository();
