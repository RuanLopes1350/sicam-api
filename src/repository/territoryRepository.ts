import { randomUUID } from 'node:crypto';
import { and, asc, eq, ilike, type SQL, sql } from 'drizzle-orm';
import pg from 'pg';
import { type DbExecutor, getDb } from '../config/dbConfig.js';
import { ibgeMunicipalities, ibgeStates } from '../config/db/schema/territories.js';
import { env } from '../config/env.js';
import { parseDatabaseError } from '../utils/helpers/dbErrors.js';

const { Client } = pg;

export interface UpsertIbgeStatePayload {
	uf: string;
	ibgeStateId: number;
	stateName: string;
	stateGeometryJson: string;
	datasetVersion: string;
	municipalities: Array<{
		ibgeCode: string;
		name: string;
		geometryJson: string;
	}>;
}

class TerritoryRepository {
	async findAllStates(db: DbExecutor = getDb()) {
		try {
			return await db.select().from(ibgeStates).orderBy(asc(ibgeStates.ufCode));
		} catch (error) {
			throw parseDatabaseError(error, 'TerritoryRepository.findAllStates');
		}
	}

	async findLoadedUfSummaries(db: DbExecutor = getDb()) {
		try {
			return await db
				.select({
					ufCode: ibgeStates.ufCode,
					name: ibgeStates.name,
					datasetVersion: ibgeStates.datasetVersion,
				})
				.from(ibgeStates)
				.orderBy(asc(ibgeStates.ufCode));
		} catch (error) {
			throw parseDatabaseError(error, 'TerritoryRepository.findLoadedUfSummaries');
		}
	}

	async searchMunicipalities(
		params: { uf?: string; q?: string; limit: number },
		db: DbExecutor = getDb(),
	) {
		try {
			const conditions: SQL[] = [];
			if (params.uf) {
				conditions.push(eq(ibgeMunicipalities.ufCode, params.uf));
			}
			if (params.q) {
				conditions.push(ilike(ibgeMunicipalities.name, `%${params.q}%`));
			}

			return await db
				.select({
					ibgeCode: ibgeMunicipalities.ibgeCode,
					name: ibgeMunicipalities.name,
					ufCode: ibgeMunicipalities.ufCode,
					centroidLon: sql<number>`ST_X(ST_PointOnSurface(${ibgeMunicipalities.geom4674}))::float8`,
					centroidLat: sql<number>`ST_Y(ST_PointOnSurface(${ibgeMunicipalities.geom4674}))::float8`,
					minLon: sql<number>`ST_XMin(${ibgeMunicipalities.geom4674})::float8`,
					minLat: sql<number>`ST_YMin(${ibgeMunicipalities.geom4674})::float8`,
					maxLon: sql<number>`ST_XMax(${ibgeMunicipalities.geom4674})::float8`,
					maxLat: sql<number>`ST_YMax(${ibgeMunicipalities.geom4674})::float8`,
				})
				.from(ibgeMunicipalities)
				.where(conditions.length > 0 ? and(...conditions) : undefined)
				.orderBy(asc(ibgeMunicipalities.name))
				.limit(params.limit);
		} catch (error) {
			throw parseDatabaseError(error, 'TerritoryRepository.searchMunicipalities');
		}
	}

	// ADR-11 & Modelagem Física Seção 8.4: Carga transacional idempotente da malha oficial IBGE no PostGIS
	async upsertStateAndMunicipalities(payload: UpsertIbgeStatePayload): Promise<number> {
		const client = new Client({ connectionString: env.DATABASE_URL });
		await client.connect();

		try {
			await client.query('BEGIN');

			await client.query(
				`
        INSERT INTO ibge_states (
          uf_code, ibge_state_id, name, geom_4674, geom_simplified_4674, dataset_version
        )
        VALUES (
          $1,
          $2,
          $3,
          ST_Multi(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($4), 4674), 4674))),
          ST_Multi(ST_MakeValid(ST_SimplifyPreserveTopology(
            ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($4), 4674), 4674),
            0.005
          ))),
          $5
        )
        ON CONFLICT (uf_code) DO UPDATE SET
          name                 = EXCLUDED.name,
          geom_4674            = EXCLUDED.geom_4674,
          geom_simplified_4674 = EXCLUDED.geom_simplified_4674,
          dataset_version      = EXCLUDED.dataset_version,
          imported_at          = NOW();
        `,
				[
					payload.uf,
					payload.ibgeStateId,
					payload.stateName,
					payload.stateGeometryJson,
					payload.datasetVersion,
				],
			);

			let importedCount = 0;
			for (const mun of payload.municipalities) {
				await client.query(
					`
          INSERT INTO ibge_municipalities (
            ibge_code, uf_code, name, geom_4674, geom_simplified_4674, dataset_version
          )
          VALUES (
            $1,
            $2,
            $3,
            ST_Multi(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($4), 4674), 4674))),
            ST_Multi(ST_MakeValid(ST_SimplifyPreserveTopology(
              ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($4), 4674), 4674),
              0.003
            ))),
            $5
          )
          ON CONFLICT (ibge_code) DO UPDATE SET
            uf_code              = EXCLUDED.uf_code,
            name                 = EXCLUDED.name,
            geom_4674            = EXCLUDED.geom_4674,
            geom_simplified_4674 = EXCLUDED.geom_simplified_4674,
            dataset_version      = EXCLUDED.dataset_version,
            imported_at          = NOW();
          `,
					[mun.ibgeCode, payload.uf, mun.name, mun.geometryJson, payload.datasetVersion],
				);
				importedCount++;
			}

			await client.query(
				`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, correlation_id, metadata)
        VALUES (NULL, 'ibge_state_imported', 'ibge_state', NULL, $1, $2::jsonb)
        `,
				[
					randomUUID(),
					JSON.stringify({
						ufCode: payload.uf,
						ibgeStateId: payload.ibgeStateId,
						municipalitiesImported: importedCount,
						datasetVersion: payload.datasetVersion,
					}),
				],
			);

			await client.query('COMMIT');
			return importedCount;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw parseDatabaseError(error, 'TerritoryRepository.upsertStateAndMunicipalities');
		} finally {
			await client.end();
		}
	}
}

export default new TerritoryRepository();
