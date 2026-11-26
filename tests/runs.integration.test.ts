import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { writeArrayBuffer } from 'geotiff';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { closeDb } from '../src/config/dbConfig.js';
import { runMigrations } from '../src/config/db/migrate.js';
import { env } from '../src/config/env.js';
import { ANALYSIS_PRESETS } from '../src/config/presets.js';
import { closeRedis, getGeoAnalysisQueue } from '../src/config/redisConfig.js';
import { closeS3, ensurePrivateBucket } from '../src/config/s3Config.js';
import type { GeoAnalysisJobPayload } from '../src/repository/runEventsRepository.js';
import { runSeed } from '../src/seeds/index.js';
import runService from '../src/service/runService.js';
import { projectCoords } from '../src/utils/geo/projRegistry.js';
import {
	normalizeStacItem,
	type NormalizedStacItem,
	type StacCatalogAdapter,
	type StacItemRaw,
} from '../src/utils/geo/stacClient.js';
import { DomainError } from '../src/utils/helpers/domainError.js';
import type { AoiPolygonGeoJson } from '../src/utils/validation/caseValidation.js';
import { startGeoAnalysisWorker } from '../src/workers/geoAnalysisWorker.js';

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

function buildUint16GeoTiff(params: {
	originX: number;
	originY: number;
	pixelSize: number;
	width: number;
	height: number;
	projectedEpsg: number;
	fillFn: (col: number, row: number) => number;
}): ArrayBuffer {
	const values = new Uint16Array(params.width * params.height);
	for (let r = 0; r < params.height; r++) {
		for (let c = 0; c < params.width; c++) {
			values[r * params.width + c] = params.fillFn(c, r);
		}
	}
	return writeArrayBuffer(values, {
		width: params.width,
		height: params.height,
		BitsPerSample: [16],
		SampleFormat: [1],
		SamplesPerPixel: 1,
		PhotometricInterpretation: 1,
		ModelPixelScale: [params.pixelSize, params.pixelSize, 0],
		ModelTiepoint: [0, 0, 0, params.originX, params.originY, 0],
		ProjectedCSTypeGeoKey: params.projectedEpsg,
		GTModelTypeGeoKey: 1,
		GTRasterTypeGeoKey: 1,
	});
}

function buildUint8SclGeoTiff(params: {
	originX: number;
	originY: number;
	pixelSize: number;
	width: number;
	height: number;
	projectedEpsg: number;
	fillFn: (col: number, row: number) => number;
}): ArrayBuffer {
	const values = new Uint8Array(params.width * params.height);
	for (let r = 0; r < params.height; r++) {
		for (let c = 0; c < params.width; c++) {
			values[r * params.width + c] = params.fillFn(c, r);
		}
	}
	return writeArrayBuffer(values, {
		width: params.width,
		height: params.height,
		BitsPerSample: [8],
		SampleFormat: [1],
		SamplesPerPixel: 1,
		PhotometricInterpretation: 1,
		ModelPixelScale: [params.pixelSize, params.pixelSize, 0],
		ModelTiepoint: [0, 0, 0, params.originX, params.originY, 0],
		ProjectedCSTypeGeoKey: params.projectedEpsg,
		GTModelTypeGeoKey: 1,
		GTRasterTypeGeoKey: 1,
	});
}

interface ParsedSseFrame {
	event: string;
	id?: string;
	data?: Record<string, unknown>;
	isComment?: boolean;
}

function parseSseFrames(rawText: string): ParsedSseFrame[] {
	const blocks = rawText.split('\n\n').filter((b) => b.trim().length > 0);
	const parsed: ParsedSseFrame[] = [];

	for (const block of blocks) {
		const lines = block.split('\n');
		if (lines.every((l) => l.startsWith(':'))) {
			parsed.push({ event: 'comment', isComment: true });
			continue;
		}
		let id: string | undefined;
		let event = 'message';
		let dataStr = '';
		for (const line of lines) {
			if (line.startsWith('id: ')) id = line.slice(4).trim();
			else if (line.startsWith('event: ')) event = line.slice(7).trim();
			else if (line.startsWith('data: ')) dataStr += line.slice(6).trim();
		}
		parsed.push({
			id,
			event,
			data: dataStr ? (JSON.parse(dataStr) as Record<string, unknown>) : undefined,
		});
	}

	return parsed;
}

describe('Task API-08 — Execuções Assíncronas (Runs), Worker BullMQ geo-analysis, Curadoria, Rasters S3 e SSE', () => {
	let app: FastifyInstance;
	let adminToken: string;
	let auditorToken: string;
	let analystToken: string;
	let caseId: string;
	let worker: Worker<GeoAnalysisJobPayload> | null = null;

	const aoiOriginE = 804000;
	const aoiOriginN = 8594000;
	const aoiUtm = { eMin: aoiOriginE, nMin: aoiOriginN, eMax: aoiOriginE + 500, nMax: aoiOriginN + 500 };
	const aoiGeoJson = makeUtmBoxAoiGeoJson(
		aoiUtm.eMin,
		aoiUtm.nMin,
		aoiUtm.eMax,
		aoiUtm.nMax,
		31980,
	);

	// COGs sintéticos cobrindo a CanonicalGrid (margem mínima 250 m -> 100 x 100 px = 1000 x 1000 m)
	const cogOriginX = aoiUtm.eMin - 260;
	const cogOriginY = aoiUtm.nMax + 260;
	const cogSize = 104;

	const t0Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/api08/t0';
	const t0RainyPrefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/api08/t0_rainy';
	const t1Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/api08/t1';

	const T0_ITEM_ID = 'S2B_20LMP_20240814_0_L2A';
	const T0_RAINY_ITEM_ID = 'S2B_20LMP_20240210_0_L2A';
	const T1_ITEM_ID = 'S2A_20LMP_20260819_0_L2A';
	const OUTSIDE_ITEM_ID = 'S2A_18ABC_20260819_0_L2A';

	const filesByUrl: Record<string, ArrayBuffer> = {};
	const stacItemsById: Record<string, NormalizedStacItem> = {};
	let heartbeatDelayInjected = false;

	beforeAll(async () => {
		await runMigrations();
		await ensurePrivateBucket();
		await runSeed();
		await getGeoAnalysisQueue().drain(true);

		// Garante cobertura IBGE em Rondônia (Vilhena)
		const client = new pg.Client({ connectionString: env.DATABASE_URL });
		await client.connect();
		try {
			const roPoly = JSON.stringify({
				type: 'MultiPolygon',
				coordinates: [
					[
						[
							[-66.8, -13.7],
							[-59.7, -13.7],
							[-59.7, -7.9],
							[-66.8, -7.9],
							[-66.8, -13.7],
						],
					],
				],
			});
			const vilhenaPoly = JSON.stringify({
				type: 'MultiPolygon',
				coordinates: [
					[
						[
							[-60.45, -12.95],
							[-59.95, -12.95],
							[-59.95, -12.45],
							[-60.45, -12.45],
							[-60.45, -12.95],
						],
					],
				],
			});

			await client.query(
				`
        INSERT INTO ibge_states (uf_code, ibge_state_id, name, geom_4674, geom_simplified_4674, dataset_version)
        VALUES ('RO', 11, 'Rondônia', ST_SetSRID(ST_GeomFromGeoJSON($1), 4674), ST_SetSRID(ST_GeomFromGeoJSON($1), 4674), 'IBGE_BR_UF_2024')
        ON CONFLICT (uf_code) DO NOTHING;
        `,
				[roPoly],
			);
			await client.query(
				`
        INSERT INTO ibge_municipalities (ibge_code, uf_code, name, geom_4674, geom_simplified_4674, dataset_version)
        VALUES ('1100304', 'RO', 'Vilhena', ST_SetSRID(ST_GeomFromGeoJSON($1), 4674), ST_SetSRID(ST_GeomFromGeoJSON($1), 4674), 'IBGE_BR_MUN_2024')
        ON CONFLICT (ibge_code) DO NOTHING;
        `,
				[vilhenaPoly],
			);
		} finally {
			await client.end();
		}

		// Constrói COGs sintéticos (AOI dentro dos pixels [26..75] x [26..75] da grade do TIFF)
		const inBox = (c: number, r: number, c0: number, r0: number, c1: number, r1: number) =>
			c >= c0 && c < c1 && r >= r0 && r < r1;

		// P1: Desmatamento donut 12x12 - 4x4 (124 px após abertura em cruz -> ~1.24 ha)
		const inDefDonut = (c: number, r: number) =>
			inBox(c, r, 28, 28, 40, 40) && !inBox(c, r, 32, 32, 36, 36);
		// P2: Degradação 8x6 (44 px após abertura -> ~0.44 ha)
		const inDegradation = (c: number, r: number) => inBox(c, r, 46, 28, 54, 34);
		// P3: Regeneração 7x5 (31 px após abertura -> ~0.31 ha)
		const inRegrowth = (c: number, r: number) => inBox(c, r, 29, 48, 36, 53);
		// Filete 1px ruidoso eliminado pela abertura 3x3
		const inThinNoise = (c: number, r: number) => r === 43 && c >= 28 && c < 45;
		// Nuvem SCL=9 em T1 (4x4 = 16 px -> 0.16 ha)
		const inCloudT1 = (c: number, r: number) => inBox(c, r, 60, 60, 64, 64);

		const populatePrefixT0 = (prefix: string) => {
			filesByUrl[`${prefix}/scl.tif`] = buildUint8SclGeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: () => 4,
			});
			filesByUrl[`${prefix}/b02.tif`] = buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: () => 1250,
			});
			filesByUrl[`${prefix}/b03.tif`] = buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: () => 1400,
			});
			filesByUrl[`${prefix}/b04.tif`] = buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: (c, r) => (inRegrowth(c, r) ? 3400 : 1300),
			});
			filesByUrl[`${prefix}/b08.tif`] = buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: (c, r) => (inRegrowth(c, r) ? 3800 : 4600),
			});
		};

		populatePrefixT0(t0Prefix);
		populatePrefixT0(t0RainyPrefix);

		filesByUrl[`${t1Prefix}/scl.tif`] = buildUint8SclGeoTiff({
			originX: cogOriginX,
			originY: cogOriginY,
			pixelSize: 10,
			width: cogSize,
			height: cogSize,
			projectedEpsg: 32720,
			fillFn: (c, r) => (inCloudT1(c, r) ? 9 : 4),
		});
		filesByUrl[`${t1Prefix}/b02.tif`] = buildUint16GeoTiff({
			originX: cogOriginX,
			originY: cogOriginY,
			pixelSize: 10,
			width: cogSize,
			height: cogSize,
			projectedEpsg: 32720,
			fillFn: () => 1350,
		});
		filesByUrl[`${t1Prefix}/b03.tif`] = buildUint16GeoTiff({
			originX: cogOriginX,
			originY: cogOriginY,
			pixelSize: 10,
			width: cogSize,
			height: cogSize,
			projectedEpsg: 32720,
			fillFn: () => 1500,
		});
		filesByUrl[`${t1Prefix}/b04.tif`] = buildUint16GeoTiff({
			originX: cogOriginX,
			originY: cogOriginY,
			pixelSize: 10,
			width: cogSize,
			height: cogSize,
			projectedEpsg: 32720,
			fillFn: (c, r) => {
				if (inDefDonut(c, r) || inThinNoise(c, r)) return 3400;
				if (inDegradation(c, r)) return 1800;
				return 1300;
			},
		});
		filesByUrl[`${t1Prefix}/b08.tif`] = buildUint16GeoTiff({
			originX: cogOriginX,
			originY: cogOriginY,
			pixelSize: 10,
			width: cogSize,
			height: cogSize,
			projectedEpsg: 32720,
			fillFn: (c, r) => {
				if (inDefDonut(c, r) || inThinNoise(c, r)) return 3800;
				if (inDegradation(c, r)) return 3000;
				return 4600;
			},
		});

		const makeStacRaw = (
			id: string,
			acquiredAt: string,
			prefix: string,
			bbox = [-60.35, -12.85, -60.05, -12.55],
		): StacItemRaw => ({
			id,
			collection: 'sentinel-2-l2a',
			bbox,
			properties: {
				datetime: acquiredAt,
				'eo:cloud_cover': 4.2,
				's2:processing_baseline': '05.11',
				's2:mgrs_tile': '20LMP',
				'proj:epsg': 32720,
			},
			assets: {
				blue: {
					href: `${prefix}/b02.tif`,
					'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
				},
				green: {
					href: `${prefix}/b03.tif`,
					'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
				},
				red: {
					href: `${prefix}/b04.tif`,
					'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
				},
				nir: {
					href: `${prefix}/b08.tif`,
					'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
				},
				scl: { href: `${prefix}/scl.tif` },
			},
		});

		stacItemsById[T0_ITEM_ID] = normalizeStacItem(
			makeStacRaw(T0_ITEM_ID, '2024-08-14T14:27:19Z', t0Prefix),
			'aws_earth_search',
		)!;
		stacItemsById[T0_RAINY_ITEM_ID] = normalizeStacItem(
			makeStacRaw(T0_RAINY_ITEM_ID, '2024-02-10T14:27:19Z', t0RainyPrefix),
			'aws_earth_search',
		)!;
		stacItemsById[T1_ITEM_ID] = normalizeStacItem(
			makeStacRaw(T1_ITEM_ID, '2026-08-19T14:27:25Z', t1Prefix),
			'aws_earth_search',
		)!;
		stacItemsById[OUTSIDE_ITEM_ID] = normalizeStacItem(
			makeStacRaw(OUTSIDE_ITEM_ID, '2026-08-19T14:27:25Z', t1Prefix, [-74.0, -5.0, -73.0, -4.0]),
			'aws_earth_search',
		)!;

		const mockCatalog: StacCatalogAdapter = {
			searchItems: async () => [],
			getItem: async ({ itemId, provider }) => {
				const item = stacItemsById[itemId];
				if (!item) {
					throw new DomainError(
						'ERR_STAC_ITEM_INVALID',
						`Item STAC '${itemId}' não encontrado no provedor '${provider}'.`,
					);
				}
				return item;
			},
			fetchAssetBytes: async () => ({ contentType: 'image/png', buffer: Buffer.alloc(0) }),
		};

		runService.setAdaptersForTesting({
			catalogAdapter: mockCatalog,
			sclEvaluator: async ({ sclTiles }) => {
				const isT1 = sclTiles.some((t) => t.href.startsWith(t1Prefix));
				return {
					aoiCloudPct: isT1 ? 0.64 : 0,
					aoiCoveragePct: 100,
				};
			},
			heartbeatMs: 120,
			resetBreaker: true,
		});

		app = await buildApp({ silentLogs: true, useMemoryRateLimit: true });
		await app.ready();

		const [admRes, audRes] = await Promise.all([
			app.inject({
				method: 'POST',
				url: '/api/v1/auth/login',
				remoteAddress: '10.80.1.1',
				payload: { email: 'admin@sicam.gov.br', password: 'Sicam@Admin2026!' },
			}),
			app.inject({
				method: 'POST',
				url: '/api/v1/auth/login',
				remoteAddress: '10.80.1.2',
				payload: { email: 'auditor@sicam.gov.br', password: 'Sicam@Auditor2026!' },
			}),
		]);

		adminToken = admRes.json().accessToken;
		auditorToken = audRes.json().accessToken;

		// Cria um analista dedicado por execução da suíte para garantir contagem limpa de runs ativas
		const uniqueTag = randomUUID().slice(0, 8);
		const testAnalystEmail = `runs.analyst.${uniqueTag}@sicam.gov.br`;
		const testAnalystPass = 'Sicam@Runs2026!';
		const createUserRes = await app.inject({
			method: 'POST',
			url: '/api/v1/users',
			headers: { authorization: `Bearer ${adminToken}` },
			payload: {
				fullName: 'Analista Geo Runs Teste',
				registrationCode: `RUN-${uniqueTag.toUpperCase()}`,
				email: testAnalystEmail,
				password: testAnalystPass,
				role: 'analyst',
			},
		});
		expect(createUserRes.statusCode).toBe(201);

		const anaLoginRes = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.80.1.3',
			payload: { email: testAnalystEmail, password: testAnalystPass },
		});
		expect(anaLoginRes.statusCode).toBe(200);
		analystToken = anaLoginRes.json().accessToken;

		const caseRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Monitoramento API-08 — Gleba Donut Vilhena',
				externalRef: `PROC-API08-${uniqueTag}`,
				description: 'Caso de validação ponta a ponta da esteira geo-analysis e SSE.',
				aoiGeoJson,
			},
		});
		expect(caseRes.statusCode).toBe(201);
		caseId = caseRes.json().id;
	});

	afterAll(async () => {
		if (worker) {
			await worker.close();
			worker = null;
		}
		if (app) {
			await app.close();
		}
		closeS3();
		await closeRedis();
		await closeDb();
	});

	it('deve impor RBAC, Idempotency-Key, travas Zero Trust STAC/temporais/presets e limite simultâneo (RN-06)', async () => {
		// 1. Auditor e Admin bloqueados (403 ERR_FORBIDDEN_ROLE)
		const audCreate = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: {
				authorization: `Bearer ${auditorToken}`,
				'idempotency-key': randomUUID(),
			},
			payload: {
				t0: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T0_ITEM_ID] },
				t1: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T1_ITEM_ID] },
				presetName: 'TECHNICAL_STANDARD',
				customParams: null,
			},
		});
		expect(audCreate.statusCode).toBe(403);
		expect(audCreate.json().code).toBe('ERR_FORBIDDEN_ROLE');

		// 2. Sem Idempotency-Key -> 400 ERR_VALIDATION_FAILED
		const noIdemp = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				t0: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T0_ITEM_ID] },
				t1: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T1_ITEM_ID] },
				presetName: 'TECHNICAL_STANDARD',
				customParams: null,
			},
		});
		expect(noIdemp.statusCode).toBe(400);
		expect(noIdemp.json().code).toBe('ERR_VALIDATION_FAILED');

		// 3. Ordem temporal inválida (T1 <= T0) -> 422 ERR_TEMPORAL_ORDER_INVALID
		const badTime = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: {
				authorization: `Bearer ${analystToken}`,
				'idempotency-key': randomUUID(),
			},
			payload: {
				t0: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T1_ITEM_ID] },
				t1: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T0_ITEM_ID] },
				presetName: 'TECHNICAL_STANDARD',
				customParams: null,
			},
		});
		expect(badTime.statusCode).toBe(422);
		expect(badTime.json().code).toBe('ERR_TEMPORAL_ORDER_INVALID');

		// 4. Item STAC fora da AOI -> 422 ERR_STAC_ITEM_INVALID
		const outsideItem = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: {
				authorization: `Bearer ${analystToken}`,
				'idempotency-key': randomUUID(),
			},
			payload: {
				t0: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T0_ITEM_ID] },
				t1: {
					provider: 'aws_earth_search',
					collection: 'sentinel-2-l2a',
					itemIds: [OUTSIDE_ITEM_ID],
				},
				presetName: 'TECHNICAL_STANDARD',
				customParams: null,
			},
		});
		expect(outsideItem.statusCode).toBe(422);
		expect(outsideItem.json().code).toBe('ERR_STAC_ITEM_INVALID');

		// 5. Hard bounds violado em presetName = CUSTOM -> 422 ERR_PARAMS_OUT_OF_BOUNDS
		const badParams = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: {
				authorization: `Bearer ${analystToken}`,
				'idempotency-key': randomUUID(),
			},
			payload: {
				t0: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T0_ITEM_ID] },
				t1: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T1_ITEM_ID] },
				presetName: 'CUSTOM',
				customParams: {
					...ANALYSIS_PRESETS.TECHNICAL_STANDARD,
					minMappingUnitHa: 0.02,
				},
			},
		});
		expect(badParams.statusCode).toBe(422);
		expect(badParams.json().code).toBe('ERR_PARAMS_OUT_OF_BOUNDS');
	});

	it('deve executar fila BullMQ -> Worker geo-analysis -> SSE real-time -> PostGIS/S3 -> Curadoria com recálculo SQL', async () => {
		// Dispara v1 (mesma época -> seasonalityWarning=false) com Idempotency-Key para testar replay + conflito
		const idempKeyV1 = randomUUID();
		const payloadV1 = {
			t0: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T0_ITEM_ID] },
			t1: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T1_ITEM_ID] },
			presetName: 'TECHNICAL_STANDARD',
			customParams: null,
		};

		const createV1 = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': idempKeyV1 },
			payload: payloadV1,
		});
		expect(createV1.statusCode).toBe(202);
		const v1Body = createV1.json();
		expect(v1Body.version).toBe(1);
		expect(v1Body.status).toBe('queued');
		expect(v1Body.seasonalityWarning).toBe(false);

		const runIdV1 = v1Body.runId as string;

		// Replay com mesma Idempotency-Key + payload idêntico devolve resposta cacheada sem criar v2
		const replayV1 = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': idempKeyV1 },
			payload: payloadV1,
		});
		expect(replayV1.statusCode).toBe(202);
		expect(replayV1.json()).toEqual(v1Body);

		// Mesma Idempotency-Key com payload diferente devolve 409 ERR_IDEMPOTENCY_CONFLICT
		const conflictV1 = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': idempKeyV1 },
			payload: { ...payloadV1, presetName: 'CONSERVATIVE' },
		});
		expect(conflictV1.statusCode).toBe(409);
		expect(conflictV1.json().code).toBe('ERR_IDEMPOTENCY_CONFLICT');

		// Dispara v2 (épocas distintas > 60 dias -> seasonalityWarning=true) atingindo teto de 2 jobs ativos
		const createV2 = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': randomUUID() },
			payload: {
				t0: {
					provider: 'aws_earth_search',
					collection: 'sentinel-2-l2a',
					itemIds: [T0_RAINY_ITEM_ID],
				},
				t1: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T1_ITEM_ID] },
				presetName: 'CONSERVATIVE',
				customParams: null,
			},
		});
		expect(createV2.statusCode).toBe(202);
		expect(createV2.json().version).toBe(2);
		expect(createV2.json().seasonalityWarning).toBe(true);
		const runIdV2 = createV2.json().runId as string;

		// Tentativa de v3 simultânea bloqueada por MAX_ACTIVE_RUNS_PER_USER=2 -> 409 ERR_CONCURRENT_JOBS_LIMIT
		const blockedV3 = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': randomUUID() },
			payload: payloadV1,
		});
		expect(blockedV3.statusCode).toBe(409);
		expect(blockedV3.json().code).toBe('ERR_CONCURRENT_JOBS_LIMIT');

		// Proíbe ?token=... na URL do stream SSE (Zero Trust OpenAPI Seção 4.1)
		const badSseQuery = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runIdV1}/events?token=vazamento`,
			headers: { authorization: `Bearer ${analystToken}` },
		});
		expect(badSseQuery.statusCode).toBe(400);
		expect(badSseQuery.json().code).toBe('ERR_VALIDATION_FAILED');

		// Abre servidor HTTP real efêmero para consumir o stream SSE com headers Authorization Bearer
		const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

		const mockCogFetch: typeof globalThis.fetch = async (input, init) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (!heartbeatDelayInjected && url === `${t0Prefix}/b02.tif`) {
				heartbeatDelayInjected = true;
				await new Promise((resolve) => setTimeout(resolve, 260));
			}

			const buf = filesByUrl[url];
			if (!buf) {
				return new Response('Not Found', { status: 404 });
			}
			const headers = new Headers(init?.headers);
			const rangeHeader = headers.get('range') ?? headers.get('Range');
			if (rangeHeader && rangeHeader.startsWith('bytes=')) {
				const [startStr, endStr] = rangeHeader.slice('bytes='.length).split('-');
				const start = Number(startStr);
				const end = endStr ? Math.min(buf.byteLength - 1, Number(endStr)) : buf.byteLength - 1;
				const slice = buf.slice(start, end + 1);
				return new Response(slice, {
					status: 206,
					headers: {
						'Content-Type': 'image/tiff',
						'Accept-Ranges': 'bytes',
						'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
						'Content-Length': String(slice.byteLength),
					},
				});
			}
			return new Response(buf, {
				status: 200,
				headers: {
					'Content-Type': 'image/tiff',
					'Accept-Ranges': 'bytes',
					'Content-Length': String(buf.byteLength),
				},
			});
		};

		const sseRes = await fetch(`${baseUrl}/api/v1/runs/${runIdV1}/events`, {
			headers: { authorization: `Bearer ${analystToken}` },
		});
		expect(sseRes.status).toBe(200);
		expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
		expect(sseRes.headers.get('cache-control')).toBe('no-cache, no-transform');
		expect(sseRes.headers.get('x-accel-buffering')).toBe('no');

		// Inicia Worker BullMQ geo-analysis processando os jobs reais na fila
		worker = startGeoAnalysisWorker({
			concurrency: 1,
			safeFetchOptions: {
				lookupFn: async () => [{ address: '52.218.10.20', family: 4 }],
				fetchFn: mockCogFetch,
				maxAttempts: 1,
			},
		});

		const sseFullText = await sseRes.text();
		const sseFrames = parseSseFrames(sseFullText);

		expect(sseFrames[0]?.event).toBe('snapshot');
		expect(sseFrames[0]?.data?.runId).toBe(runIdV1);
		expect(sseFrames.some((f) => f.isComment)).toBe(true); // Heartbeat `: ping`

		const progressStatuses = sseFrames
			.filter((f) => f.event === 'progress')
			.map((f) => f.data?.status);
		expect(progressStatuses).toEqual(['fetching_bands', 'processing_ndvi', 'vectorizing']);

		const terminalFrame = sseFrames[sseFrames.length - 1];
		expect(terminalFrame?.event).toBe('run.ready_for_review');
		expect(terminalFrame?.data?.status).toBe('ready_for_review');
		expect((terminalFrame?.data?.summary as { featureCount: number }).featureCount).toBe(3);

		// Aguarda v2 concluir também para deixar fila limpa
		for (let attempt = 0; attempt < 40; attempt++) {
			const v2Check = await app.inject({
				method: 'GET',
				url: `/api/v1/runs/${runIdV2}`,
				headers: { authorization: `Bearer ${auditorToken}` },
			});
			if (v2Check.json().status === 'ready_for_review') {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		// Nova conexão SSE após conclusão entrega snapshot imediato e encerra sem travar (OpenAPI Seção 4.2)
		const postFinishSseRes = await fetch(`${baseUrl}/api/v1/runs/${runIdV1}/events`, {
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		const postFinishFrames = parseSseFrames(await postFinishSseRes.text());
		expect(postFinishFrames).toHaveLength(1);
		expect(postFinishFrames[0]?.event).toBe('snapshot');
		expect(postFinishFrames[0]?.data?.status).toBe('ready_for_review');
		expect(postFinishFrames[0]?.data?.progressPct).toBe(100);

		// Consulta GET /runs/:runId como Auditor -> 200 OK com 5 rasters e sumário oficial
		const runDetailRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runIdV1}`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(runDetailRes.statusCode).toBe(200);
		const detail = runDetailRes.json();
		expect(detail.status).toBe('ready_for_review');
		expect(detail.rasterAssets).toHaveLength(5);
		expect(detail.summary.activeFeatureCount).toBe(3);
		expect(detail.summary.dismissedFeatureCount).toBe(0);
		expect(detail.summary.deforestationHa).toBeCloseTo(1.24, 1);
		expect(detail.summary.degradationHa).toBeCloseTo(0.44, 1);
		expect(detail.summary.regrowthHa).toBeCloseTo(0.31, 1);
		expect(detail.summary.cloudMaskedHa).toBeCloseTo(0.16, 1);

		// Proxy autenticado de raster PNG S3 + ETag 304 Not Modified
		const t0RgbRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runIdV1}/rasters/t0_rgb`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(t0RgbRes.statusCode).toBe(200);
		expect(t0RgbRes.headers['content-type']).toBe('image/png');
		const etag = t0RgbRes.headers.etag as string;
		expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
		expect(t0RgbRes.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		const cachedRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runIdV1}/rasters/t0_rgb`,
			headers: { authorization: `Bearer ${auditorToken}`, 'if-none-match': etag },
		});
		expect(cachedRes.statusCode).toBe(304);

		// Listagem GeoJSON e JSON paginado ordenado por área decrescente
		const geojsonRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runIdV1}/features?format=geojson`,
			headers: { authorization: `Bearer ${analystToken}` },
		});
		expect(geojsonRes.statusCode).toBe(200);
		const fc = geojsonRes.json();
		expect(fc.type).toBe('FeatureCollection');
		expect(fc.features).toHaveLength(3);
		const p1 = fc.features[0];
		expect(p1.properties.featureSequence).toBe(1);
		expect(p1.properties.label).toBe('P1');
		expect(p1.properties.featureClass).toBe('deforestation');
		expect(p1.geometry.coordinates).toHaveLength(2); // Exterior + buraco interno preservado no PostGIS!

		// Auditor não pode revisar feição -> 403
		const audReviewRes = await app.inject({
			method: 'PATCH',
			url: `/api/v1/runs/${runIdV1}/features/${p1.id}/review`,
			headers: { authorization: `Bearer ${auditorToken}` },
			payload: { reviewStatus: 'confirmed' },
		});
		expect(audReviewRes.statusCode).toBe(403);

		// Justificativa curta (< 15 chars) rejeitada -> 400
		const shortReasonRes = await app.inject({
			method: 'PATCH',
			url: `/api/v1/runs/${runIdV1}/features/${p1.id}/review`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: { reviewStatus: 'dismissed_noise', dismissalReason: 'Muito curto' },
		});
		expect(shortReasonRes.statusCode).toBe(400);

		// Descarte auditável válido recalcula deforestationHa -> 0 e incrementa stableHa no PostGIS
		const prevStable = detail.summary.stableHa as number;
		const p1Area = p1.properties.areaHa as number;
		const dismissRes = await app.inject({
			method: 'PATCH',
			url: `/api/v1/runs/${runIdV1}/features/${p1.id}/review`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				reviewStatus: 'dismissed_noise',
				dismissalReason: 'Banco de areia exposto por vazante sazonal no igarapé local.',
			},
		});
		expect(dismissRes.statusCode).toBe(200);
		const dismissedBody = dismissRes.json();
		expect(dismissedBody.feature.reviewStatus).toBe('dismissed_noise');
		expect(dismissedBody.feature.reviewedBy?.registrationCode).toContain('RUN-');
		expect(dismissedBody.updatedSummary.deforestationHa).toBe(0);
		expect(dismissedBody.updatedSummary.stableHa).toBeCloseTo(prevStable + p1Area, 3);
		expect(dismissedBody.updatedSummary.activeFeatureCount).toBe(2);
		expect(dismissedBody.updatedSummary.dismissedFeatureCount).toBe(1);

		// Registro descartado permanece visível para auditoria via ?format=json&reviewStatus=dismissed_noise
		const dismissedListRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runIdV1}/features?format=json&reviewStatus=dismissed_noise`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(dismissedListRes.statusCode).toBe(200);
		expect(dismissedListRes.json().items).toHaveLength(1);
		expect(dismissedListRes.json().items[0].id).toBe(p1.id);

		// Trilha de auditoria contém run_created, run_completed e feature_reviewed para runIdV1/P1
		const auditRes = await app.inject({
			method: 'GET',
			url: `/api/v1/audit-logs?entityId=${runIdV1}`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(auditRes.statusCode).toBe(200);
		const actions = auditRes.json().items.map((item: { action: string }) => item.action);
		expect(actions).toContain('run_created');
		expect(actions).toContain('run_completed');
	});
});
