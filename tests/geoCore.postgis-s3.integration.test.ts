import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '../src/config/dbConfig.js';
import { runMigrations } from '../src/config/db/migrate.js';
import { ANALYSIS_PRESETS } from '../src/config/presets.js';
import { closeS3, ensurePrivateBucket } from '../src/config/s3Config.js';
import { storageRepository } from '../src/repository/storageRepository.js';
import {
	buildCanonicalAoiMask,
	classifyMultitemporalNdvi,
	createCanonicalGrid,
	executePostClassificationPipeline,
	extractApprovedComponents8Conn,
	renderCanonicalEvidenceRasters,
	vectorizeComponentToPolygons,
} from '../src/utils/geo/core/index.js';
import { projectCoords } from '../src/utils/geo/projRegistry.js';
import { DomainError } from '../src/utils/helpers/domainError.js';
import type { AoiPolygonGeoJson } from '../src/utils/validation/caseValidation.js';

function makeUtmBoxAoiGeoJson(
	eMin: number,
	nMin: number,
	eMax: number,
	nMax: number,
	utmSrid = 31980,
): AoiPolygonGeoJson {
	const utmCrs = `EPSG:${utmSrid}`;
	const p1 = projectCoords(utmCrs, 'EPSG:4674', eMin, nMin);
	const p2 = projectCoords(utmCrs, 'EPSG:4674', eMax, nMin);
	const p3 = projectCoords(utmCrs, 'EPSG:4674', eMax, nMax);
	const p4 = projectCoords(utmCrs, 'EPSG:4674', eMin, nMax);
	return {
		type: 'Polygon',
		coordinates: [[p1, p2, p3, p4, p1]],
	};
}

describe('Task API-07 — Validação PostGIS (ST_IsValid/Buracos/Area) e Storage S3 Privado (Integração)', () => {
	beforeAll(async () => {
		await runMigrations();
		await ensurePrivateBucket();
	});

	afterAll(async () => {
		closeS3();
		await closeDb();
	});

	it('deve persistir/validar polígonos com buracos, vértices de sela e DP 5m no PostGIS SIRGAS 2000', async () => {
		const aoi = makeUtmBoxAoiGeoJson(804000, 8594000, 804500, 8594500, 31980);
		const grid = createCanonicalGrid(aoi, 31980);
		const n = grid.pixelCount;
		const ndviT0 = new Float32Array(n).fill(0.8);
		const ndviT1 = new Float32Array(n).fill(0.2);
		const deltaNdvi = new Float32Array(n).fill(-0.6);

		// Donut 12x12 - 4x4 = 128 px (1.28 ha)
		const donutMask = new Uint8Array(n);
		for (let r = 30; r < 42; r++) {
			for (let c = 30; c < 42; c++) {
				const inHole = r >= 34 && r < 38 && c >= 34 && c < 38;
				if (!inHole) donutMask[r * grid.width + c] = 1;
			}
		}

		// Losango diagonal ("escadinha" para testar Douglas-Peucker no PostGIS)
		for (let r = 55; r <= 75; r++) {
			for (let c = 55; c <= 75; c++) {
				if (Math.abs(r - 65) + Math.abs(c - 65) <= 8) {
					donutMask[r * grid.width + c] = 1;
				}
			}
		}

		// Par unido por vértice de sela
		for (let r = 30; r < 35; r++) {
			for (let c = 60; c < 65; c++) {
				donutMask[r * grid.width + c] = 1;
			}
		}
		for (let r = 35; r < 40; r++) {
			for (let c = 65; c < 70; c++) {
				donutMask[r * grid.width + c] = 1;
			}
		}

		const ccl = extractApprovedComponents8Conn({
			binaryMask: donutMask,
			width: grid.width,
			height: grid.height,
			featureClass: 'deforestation',
			minMappingUnitHa: 0.25,
			ndviT0,
			ndviT1,
			deltaNdvi,
		});

		const polys = ccl.components.flatMap((comp) => vectorizeComponentToPolygons(comp, grid, 5.0));
		expect(polys.length).toBe(4); // 1 donut + 1 losango + 2 do vértice de sela

		const pool = getPool();
		for (const poly of polys) {
			const res = await pool.query<{
				is_valid: boolean;
				geom_type: string;
				n_interior_rings: number;
				area_ha: string;
				pos_within: boolean;
			}>(
				`
        WITH g AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4674) AS geom
        )
        SELECT
          ST_IsValid(geom) AS is_valid,
          GeometryType(geom) AS geom_type,
          ST_NumInteriorRings(geom) AS n_interior_rings,
          fn_calc_area_ha_sirgas(geom, $2)::text AS area_ha,
          ST_Within(ST_PointOnSurface(geom), geom) AS pos_within
        FROM g;
        `,
				[JSON.stringify(poly.geomGeoJson), grid.utmSrid],
			);

			const row = res.rows[0]!;
			expect(row.is_valid).toBe(true);
			expect(row.geom_type).toBe('POLYGON');
			expect(row.pos_within).toBe(true);

			const pgAreaHa = Number(row.area_ha);
			expect(pgAreaHa).toBeGreaterThan(0.2);
			expect(Math.abs(pgAreaHa - poly.approxAreaHa)).toBeLessThan(0.02);

			if (poly.geomGeoJson.coordinates.length === 2) {
				expect(row.n_interior_rings).toBe(1);
				expect(pgAreaHa).toBeCloseTo(1.28, 1);
			}
		}
	});

	it('deve gravar e ler os 5 PNGs lossless no SeaweedFS S3 mantendo integridade SHA-256', async () => {
		const aoi = makeUtmBoxAoiGeoJson(804000, 8594000, 804150, 8594150, 31980);
		const grid = createCanonicalGrid(aoi, 31980);
		const aoiMask = buildCanonicalAoiMask(grid);
		const n = grid.pixelCount;

		const makeUniform = (redVal: number, nirVal: number) => ({
			blue: new Float32Array(n).fill(0.03),
			green: new Float32Array(n).fill(0.05),
			red: new Float32Array(n).fill(redVal),
			nir: new Float32Array(n).fill(nirVal),
			scl: new Uint8Array(n).fill(4),
		});

		const t0 = makeUniform(0.03, 0.36);
		const t1 = makeUniform(0.03, 0.36);

		// Bloco de desmatamento 6x6 no centro da grade
		const center = Math.floor(grid.height / 2);
		for (let r = center - 3; r < center + 3; r++) {
			for (let c = center - 3; c < center + 3; c++) {
				const idx = r * grid.width + c;
				t1.red[idx] = 0.24;
				t1.nir[idx] = 0.26;
			}
		}

		const rawCls = classifyMultitemporalNdvi({
			t0,
			t1,
			aoiMask,
			algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
		});

		const post = await executePostClassificationPipeline({
			grid,
			aoiMask,
			t0,
			t1,
			rawClassification: rawCls,
			algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
		});

		const rendered = await renderCanonicalEvidenceRasters({
			grid,
			t0,
			t1,
			filteredClassMap: post.filteredClassMap,
		});

		const caseId = randomUUID();
		const runId = randomUUID();

		for (const assetType of [
			't0_rgb',
			't1_rgb',
			't0_false_color',
			't1_false_color',
			'delta_ndvi_mask',
		] as const) {
			const asset = rendered.rasters[assetType];
			const key = storageRepository.buildRasterStorageKey(caseId, runId, assetType);
			const putRes = await storageRepository.putPrivateObject({
				key,
				body: asset.buffer,
				contentType: asset.mimeType,
				sha256Hex: asset.sha256,
			});

			expect(putRes.sha256).toBe(asset.sha256);
			expect(putRes.sizeBytes).toBe(asset.sizeBytes);

			const downloaded = await storageRepository.getPrivateObjectBytes(key);
			expect(downloaded.contentType).toBe('image/png');
			const downloadedHash = createHash('sha256').update(downloaded.buffer).digest('hex');
			expect(downloadedHash).toBe(asset.sha256);

			const streamed = await storageRepository.getPrivateObjectStream(key);
			const chunks: Buffer[] = [];
			for await (const chunk of streamed.stream) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const streamedHash = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
			expect(streamedHash).toBe(asset.sha256);
		}

		// Chave inexistente deve retornar ERR_RESOURCE_NOT_FOUND
		await expect(
			storageRepository.getPrivateObjectBytes(`cases/${caseId}/missing/file.png`),
		).rejects.toMatchObject({
			errorCode: 'ERR_RESOURCE_NOT_FOUND',
			statusCode: 404,
		} satisfies Partial<DomainError>);
	});
});
