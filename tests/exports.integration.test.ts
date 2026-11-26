import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { writeArrayBuffer } from 'geotiff';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { closeDb } from '../src/config/dbConfig.js';
import { runMigrations } from '../src/config/db/migrate.js';
import { env } from '../src/config/env.js';
import { closeRedis } from '../src/config/redisConfig.js';
import { closeS3, ensurePrivateBucket } from '../src/config/s3Config.js';
import { runSeed } from '../src/seeds/index.js';
import exportService from '../src/service/exportService.js';
import runService from '../src/service/runService.js';
import {
	closeCartographyBrowser,
	extractZipEntriesFromBuffer,
} from '../src/utils/geo/cartography/index.js';
import { projectCoords } from '../src/utils/geo/projRegistry.js';
import {
	normalizeStacItem,
	type NormalizedStacItem,
	type StacCatalogAdapter,
	type StacItemRaw,
} from '../src/utils/geo/stacClient.js';
import { sha256Hex } from '../src/utils/helpers/crypto.js';
import type { AoiPolygonGeoJson } from '../src/utils/validation/caseValidation.js';
import { processCartographyExportJob } from '../src/workers/cartographyExportWorker.js';
import { processGeoAnalysisJob } from '../src/workers/geoAnalysisWorker.js';

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

function buildBinaryMultipartBody(
	fieldName: string,
	filename: string,
	contentType: string,
	binaryPayload: Buffer,
): { body: Buffer; contentTypeHeader: string } {
	const boundary = `----SicamBoundary${randomUUID().replaceAll('-', '')}`;
	const head = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
		'utf8',
	);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
	return {
		body: Buffer.concat([head, binaryPayload, tail]),
		contentTypeHeader: `multipart/form-data; boundary=${boundary}`,
	};
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

describe('Task API-10 — Pacote Técnico .zip, Cadeia SHA-256, Congelamento e Integridade (Integração)', () => {
	let app: FastifyInstance;
	let baseUrl: string;
	let adminToken: string;
	let auditorToken: string;
	let analystToken: string;
	let analystId: string;
	let caseId: string;
	let protocolCode: string;
	let runId: string;
	let runIdUnfinished: string;

	const aoiOriginE = 804000;
	const aoiOriginN = 8594000;
	const aoiUtm = {
		eMin: aoiOriginE,
		nMin: aoiOriginN,
		eMax: aoiOriginE + 500,
		nMax: aoiOriginN + 500,
	};
	const aoiGeoJson = makeUtmBoxAoiGeoJson(
		aoiUtm.eMin,
		aoiUtm.nMin,
		aoiUtm.eMax,
		aoiUtm.nMax,
		31980,
	);

	const cogOriginX = aoiUtm.eMin - 260;
	const cogOriginY = aoiUtm.nMax + 260;
	const cogSize = 104;

	const t0Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/api10/t0';
	const t1Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/api10/t1';
	const T0_ID = 'S2B_20LMP_20240814_0_L2A';
	const T1_ID = 'S2A_20LMP_20260819_0_L2A';

	beforeAll(async () => {
		await runMigrations();
		await ensurePrivateBucket();
		await runSeed();

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

		const inBox = (c: number, r: number, c0: number, r0: number, c1: number, r1: number) =>
			c >= c0 && c < c1 && r >= r0 && r < r1;

		const inDefDonut = (c: number, r: number) =>
			inBox(c, r, 28, 28, 40, 40) && !inBox(c, r, 32, 32, 36, 36);
		const inDegradation = (c: number, r: number) => inBox(c, r, 46, 28, 54, 34);
		const inRegrowth = (c: number, r: number) => inBox(c, r, 29, 48, 36, 53);
		const inCloudT1 = (c: number, r: number) => inBox(c, r, 60, 60, 64, 64);

		const files: Record<string, ArrayBuffer> = {
			[`${t0Prefix}/scl.tif`]: buildUint8SclGeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: () => 4,
			}),
			[`${t0Prefix}/b02.tif`]: buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: () => 1250,
			}),
			[`${t0Prefix}/b03.tif`]: buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: () => 1400,
			}),
			[`${t0Prefix}/b04.tif`]: buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: (c, r) => (inRegrowth(c, r) ? 2600 : 1300),
			}),
			[`${t0Prefix}/b08.tif`]: buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: (c, r) => (inRegrowth(c, r) ? 2800 : 4600),
			}),
			[`${t1Prefix}/scl.tif`]: buildUint8SclGeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: (c, r) => (inCloudT1(c, r) ? 9 : 4),
			}),
			[`${t1Prefix}/b02.tif`]: buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: () => 1350,
			}),
			[`${t1Prefix}/b03.tif`]: buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: () => 1500,
			}),
			[`${t1Prefix}/b04.tif`]: buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: (c, r) => (inDefDonut(c, r) ? 3400 : inDegradation(c, r) ? 1800 : 1300),
			}),
			[`${t1Prefix}/b08.tif`]: buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: (c, r) =>
					inDefDonut(c, r) ? 3800 : inDegradation(c, r) ? 3000 : inRegrowth(c, r) ? 4900 : 4600,
			}),
		};

		const makeStacRaw = (id: string, dt: string, prefix: string): StacItemRaw => ({
			id,
			collection: 'sentinel-2-l2a',
			bbox: [-60.35, -12.85, -60.05, -12.55],
			properties: {
				datetime: dt,
				'eo:cloud_cover': 3.5,
				's2:processing_baseline': '05.11',
				's2:mgrs_tile': '20LMP',
				'proj:epsg': 32720,
			},
			assets: {
				blue: { href: `${prefix}/b02.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }] },
				green: { href: `${prefix}/b03.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }] },
				red: { href: `${prefix}/b04.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }] },
				nir: { href: `${prefix}/b08.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }] },
				scl: { href: `${prefix}/scl.tif` },
			},
		});

		const itemsById: Record<string, NormalizedStacItem> = {
			[T0_ID]: normalizeStacItem(
				makeStacRaw(T0_ID, '2024-08-14T14:27:19Z', t0Prefix),
				'aws_earth_search',
			)!,
			[T1_ID]: normalizeStacItem(
				makeStacRaw(T1_ID, '2026-08-19T14:27:25Z', t1Prefix),
				'aws_earth_search',
			)!,
		};

		const mockCatalog: StacCatalogAdapter = {
			searchItems: async () => [],
			getItem: async ({ itemId }) => itemsById[itemId]!,
			fetchAssetBytes: async () => ({ contentType: 'image/png', buffer: Buffer.alloc(0) }),
		};

		runService.setAdaptersForTesting({
			catalogAdapter: mockCatalog,
			sclEvaluator: async () => ({ aoiCloudPct: 0.64, aoiCoveragePct: 100 }),
			enqueueJobFn: async (payload) => `direct-geo-${payload.runId}`,
			resetBreaker: true,
		});

		exportService.setAdaptersForTesting({
			enqueueExportJobFn: async (payload) => `direct-export-${payload.runId}`,
		});

		app = await buildApp({ silentLogs: true, useMemoryRateLimit: true });
		baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

		const admRes = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.91.1.1',
			payload: { email: 'admin@sicam.gov.br', password: 'Sicam@Admin2026!' },
		});
		adminToken = admRes.json().accessToken;

		const tag = randomUUID().slice(0, 8);
		const anaEmail = `export.ana.${tag}@sicam.gov.br`;
		const audEmail = `export.aud.${tag}@sicam.gov.br`;
		const pass = 'Sicam@Export2026!';

		const createdAna = await app.inject({
			method: 'POST',
			url: '/api/v1/users',
			headers: { authorization: `Bearer ${adminToken}` },
			payload: {
				fullName: 'Analista Emissor RO',
				registrationCode: `EXP-${tag.toUpperCase()}`,
				email: anaEmail,
				password: pass,
				role: 'analyst',
			},
		});
		analystId = createdAna.json().id;

		await app.inject({
			method: 'POST',
			url: '/api/v1/users',
			headers: { authorization: `Bearer ${adminToken}` },
			payload: {
				fullName: 'Auditor Verificador RO',
				registrationCode: `AUD-${tag.toUpperCase()}`,
				email: audEmail,
				password: pass,
				role: 'auditor',
			},
		});

		const anaLogin = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.91.1.2',
			payload: { email: anaEmail, password: pass },
		});
		analystToken = anaLogin.json().accessToken;

		const audLogin = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.91.1.3',
			payload: { email: audEmail, password: pass },
		});
		auditorToken = audLogin.json().accessToken;

		const caseRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Caso Exportação API-10 — Gleba Sul',
				externalRef: `PROC-EXP-${tag}`,
				description: 'Validação ponta a ponta do pacote .zip, SHA-256 e congelamento.',
				aoiGeoJson,
			},
		});
		caseId = caseRes.json().id;
		protocolCode = caseRes.json().protocolCode;

		const runPayload = {
			t0: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T0_ID] },
			t1: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T1_ID] },
			presetName: 'TECHNICAL_STANDARD',
			customParams: null,
		};

		const runV1Res = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': randomUUID() },
			payload: runPayload,
		});
		runId = runV1Res.json().runId;

		const runV2Res = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': randomUUID() },
			payload: runPayload,
		});
		runIdUnfinished = runV2Res.json().runId;

		const mockFetch: typeof globalThis.fetch = async (input, init) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			const buf = files[url];
			if (!buf) return new Response('Not Found', { status: 404 });

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
			return new Response(buf, { status: 200 });
		};

		await processGeoAnalysisJob(
			{
				id: runId,
				data: { runId, caseId, correlationId: randomUUID() },
				attemptsMade: 0,
				opts: { attempts: 1 },
			} as never,
			{
				safeFetchOptions: {
					lookupFn: async () => [{ address: '52.218.10.20', family: 4 }],
					fetchFn: mockFetch,
					maxAttempts: 1,
				},
			},
		);

		// Curadoria humana em v1: confirma P1 e descarta P2 como falso positivo (P3 permanece auto_detected)
		const featsRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runId}/features?format=json`,
			headers: { authorization: `Bearer ${analystToken}` },
		});
		const items = featsRes.json().items as Array<{
			id: string;
			featureSequence: number;
			featureClass: string;
		}>;
		expect(items.length).toBeGreaterThanOrEqual(3);

		const defFeat = items.find((f) => f.featureClass === 'deforestation')!;
		const degFeat = items.find((f) => f.featureClass === 'degradation')!;

		await app.inject({
			method: 'PATCH',
			url: `/api/v1/runs/${runId}/features/${defFeat.id}/review`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: { reviewStatus: 'confirmed' },
		});
		await app.inject({
			method: 'PATCH',
			url: `/api/v1/runs/${runId}/features/${degFeat.id}/review`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				reviewStatus: 'dismissed_noise',
				dismissalReason: 'Variação de dossel por sombra topográfica sazonal.',
			},
		});
	}, 45_000);

	afterAll(async () => {
		await closeCartographyBrowser();
		if (app) {
			await app.close();
		}
		closeS3();
		await closeRedis();
		await closeDb();
	});

	it('deve impor RBAC, Idempotency-Key e travas de estado, além de recuperar de falha transitória sem congelar', async () => {
		// Auditor e Admin não podem disparar exportação -> 403
		for (const token of [auditorToken, adminToken]) {
			const forbidRes = await app.inject({
				method: 'POST',
				url: `/api/v1/runs/${runId}/export`,
				headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
				payload: { paperFormat: 'A3' },
			});
			expect(forbidRes.statusCode).toBe(403);
		}

		// Falta de Idempotency-Key -> 400
		const noIdempRes = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/export`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: { paperFormat: 'A3' },
		});
		expect(noIdempRes.statusCode).toBe(400);

		// Observações acima de 600 chars -> 400
		const longObsRes = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/export`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': randomUUID() },
			payload: { paperFormat: 'A4', observations: 'x'.repeat(605) },
		});
		expect(longObsRes.statusCode).toBe(400);

		// Execução fora de ready_for_review (v2 está queued) -> 409 ERR_RUN_NOT_REVIEWABLE
		const notReadyRes = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${runIdUnfinished}/export`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': randomUUID() },
			payload: { paperFormat: 'A3' },
		});
		expect(notReadyRes.statusCode).toBe(409);
		expect(notReadyRes.json().code).toBe('ERR_RUN_NOT_REVIEWABLE');

		// GET /export antes da emissão -> 404
		const missingExportRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runId}/export`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(missingExportRes.statusCode).toBe(404);

		// Simula falha de exportação em v2 (sem rasters persistidos): deve reverter exporting -> ready_for_review e emitir export.failed
		const client = new pg.Client({ connectionString: env.DATABASE_URL });
		await client.connect();
		try {
			await client.query(`UPDATE analysis_runs SET status = 'ready_for_review' WHERE id = $1`, [
				runIdUnfinished,
			]);
		} finally {
			await client.end();
		}

		const reqFailRes = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${runIdUnfinished}/export`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': randomUUID() },
			payload: { paperFormat: 'A4' },
		});
		expect(reqFailRes.statusCode).toBe(202);

		const failSseRes = await fetch(`${baseUrl}/api/v1/runs/${runIdUnfinished}/events`, {
			headers: { authorization: `Bearer ${analystToken}` },
		});

		await expect(
			processCartographyExportJob({
				id: `export-fail-${runIdUnfinished}`,
				data: {
					runId: runIdUnfinished,
					caseId,
					paperFormat: 'A4',
					observations: null,
					requestedByUserId: analystId,
					correlationId: randomUUID(),
				},
				attemptsMade: 0,
				opts: { attempts: 1 },
			} as never),
		).rejects.toThrow();

		const failFrames = parseSseFrames(await failSseRes.text());
		const failTerminal = failFrames[failFrames.length - 1];
		expect(failTerminal?.event).toBe('export.failed');
		expect(failTerminal?.data?.status).toBe('ready_for_review');

		const v2AfterFail = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runIdUnfinished}`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(v2AfterFail.json().status).toBe('ready_for_review');
	});

	it('deve executar exportação completa -> PDF + ZIP imutável -> frozen -> download auditado -> verify JSON e multipart', async () => {
		const idempKey = randomUUID();
		const correlationId = randomUUID();
		const exportBody = {
			paperFormat: 'A3',
			observations: 'Emissão oficial de monitoramento (<script>alert(1)</script>).',
		};

		// 1. Disparo POST /runs/:runId/export -> 202 Accepted
		const exportRes = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/export`,
			headers: {
				authorization: `Bearer ${analystToken}`,
				'idempotency-key': idempKey,
				'x-request-id': correlationId,
			},
			payload: exportBody,
		});
		expect(exportRes.statusCode).toBe(202);
		expect(exportRes.json()).toEqual({
			runId,
			status: 'exporting',
			eventsUrl: `/api/v1/runs/${runId}/events`,
		});

		// Replay idempotente -> 202 igual
		const replayRes = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/export`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': idempKey },
			payload: exportBody,
		});
		expect(replayRes.statusCode).toBe(202);
		expect(replayRes.json()).toEqual(exportRes.json());

		// Conflito de idempotência -> 409 ERR_IDEMPOTENCY_CONFLICT
		const conflictIdempRes = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/export`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': idempKey },
			payload: { paperFormat: 'A4' },
		});
		expect(conflictIdempRes.statusCode).toBe(409);
		expect(conflictIdempRes.json().code).toBe('ERR_IDEMPOTENCY_CONFLICT');

		// Conecta ao SSE enquanto status === 'exporting' e executa worker cartography-export
		const sseRes = await fetch(`${baseUrl}/api/v1/runs/${runId}/events`, {
			headers: { authorization: `Bearer ${analystToken}` },
		});
		expect(sseRes.status).toBe(200);

		await processCartographyExportJob({
			id: `export-job-${runId}`,
			data: {
				runId,
				caseId,
				paperFormat: 'A3',
				observations: exportBody.observations,
				requestedByUserId: analystId,
				correlationId,
			},
			attemptsMade: 0,
			opts: { attempts: 1 },
		} as never);

		const sseFrames = parseSseFrames(await sseRes.text());
		expect(sseFrames[0]?.event).toBe('snapshot');
		expect(sseFrames[0]?.data?.status).toBe('exporting');
		const terminal = sseFrames[sseFrames.length - 1];
		expect(terminal?.event).toBe('export.frozen');
		expect(terminal?.data?.status).toBe('frozen');

		const sseExportId = terminal?.data?.exportId as string;
		const ssePdfSha = terminal?.data?.pdfSha256 as string;
		const sseZipSha = terminal?.data?.zipSha256 as string;
		expect(sseExportId).toMatch(/^[a-f0-9-]{36}$/);
		expect(ssePdfSha).toMatch(/^[a-f0-9]{64}$/);
		expect(sseZipSha).toMatch(/^[a-f0-9]{64}$/);

		// 2. Run agora está FROZEN e imutável (RN-05)
		const frozenDetail = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runId}`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(frozenDetail.statusCode).toBe(200);
		expect(frozenDetail.json().status).toBe('frozen');

		const featsRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runId}/features?format=json`,
			headers: { authorization: `Bearer ${analystToken}` },
		});
		const p1Id = featsRes.json().items[0].id as string;

		const reviewAfterFreeze = await app.inject({
			method: 'PATCH',
			url: `/api/v1/runs/${runId}/features/${p1Id}/review`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: { reviewStatus: 'confirmed' },
		});
		expect(reviewAfterFreeze.statusCode).toBe(409);
		expect(reviewAfterFreeze.json().code).toBe('ERR_RUN_FROZEN');

		const reExportAfterFreeze = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/export`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': randomUUID() },
			payload: { paperFormat: 'A3' },
		});
		expect(reExportAfterFreeze.statusCode).toBe(409);
		expect(reExportAfterFreeze.json().code).toBe('ERR_RUN_FROZEN');

		// Triggers PostgreSQL bloqueiam mutação direta em analysis_runs e export_packages
		const pgClient = new pg.Client({ connectionString: env.DATABASE_URL });
		await pgClient.connect();
		try {
			await expect(
				pgClient.query(`UPDATE export_packages SET observations = 'adulterado' WHERE id = $1`, [
					sseExportId,
				]),
			).rejects.toMatchObject({ code: '42501' });
			await expect(
				pgClient.query(`UPDATE analysis_runs SET status = 'ready_for_review' WHERE id = $1`, [
					runId,
				]),
			).rejects.toMatchObject({ code: '42501' });
		} finally {
			await pgClient.end();
		}

		// 3. GET /runs/:runId/export retorna metadados e manifesto completos
		const metaRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runId}/export`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(metaRes.statusCode).toBe(200);
		const meta = metaRes.json();
		expect(meta.exportId).toBe(sseExportId);
		expect(meta.protocolCode).toBe(protocolCode);
		expect(meta.paperFormat).toBe('A3');
		expect(meta.pdfSha256).toBe(ssePdfSha);
		expect(meta.zipSha256).toBe(sseZipSha);
		expect(meta.issuer.registrationCode).toContain('EXP-');
		expect(meta.downloads.pdfUrl).toBe(`/api/v1/exports/${sseExportId}/download?artifact=pdf`);
		expect(meta.downloads.zipUrl).toBe(`/api/v1/exports/${sseExportId}/download?artifact=zip`);

		// 4. Download autenticado e auditado do PDF e do ZIP via rawPayload
		const dlPdfRes = await app.inject({
			method: 'GET',
			url: `/api/v1/exports/${sseExportId}/download?artifact=pdf`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(dlPdfRes.statusCode).toBe(200);
		expect(dlPdfRes.headers['content-type']).toBe('application/pdf');
		expect(dlPdfRes.headers['cache-control']).toBe('private, no-store');
		expect(dlPdfRes.headers['content-disposition']).toContain(`CARTA_IMAGEM_${protocolCode}_v1.pdf`);
		expect(dlPdfRes.headers['x-artifact-sha256']).toBe(ssePdfSha);
		expect(dlPdfRes.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		expect(sha256Hex(dlPdfRes.rawPayload)).toBe(ssePdfSha);

		const dlZipRes = await app.inject({
			method: 'GET',
			url: `/api/v1/exports/${sseExportId}/download?artifact=zip`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(dlZipRes.statusCode).toBe(200);
		expect(dlZipRes.headers['content-type']).toBe('application/zip');
		expect(dlZipRes.headers['content-disposition']).toContain(`PACOTE_${protocolCode}_v1.zip`);
		expect(dlZipRes.headers['x-artifact-sha256']).toBe(sseZipSha);
		expect(sha256Hex(dlZipRes.rawPayload)).toBe(sseZipSha);

		// Descompacta o .zip em memória e confere os 16 arquivos e integridade de 100% dos hashes do manifesto
		const unpacked = extractZipEntriesFromBuffer(dlZipRes.rawPayload);
		expect(unpacked.size).toBe(16);

		const manifestEntry = unpacked.get('05_manifesto_auditoria.json');
		expect(manifestEntry).toBeDefined();
		const manifestJson = JSON.parse(manifestEntry!.buffer.toString('utf8'));
		expect(manifestJson.cryptographicCustody.pdfSha256).toBe(ssePdfSha);
		expect(manifestJson.cryptographicCustody.files).toHaveLength(15);

		for (const fileMeta of manifestJson.cryptographicCustody.files as Array<{
			path: string;
			sizeBytes: number;
			sha256: string;
		}>) {
			const insideZip = unpacked.get(fileMeta.path);
			expect(insideZip, `Arquivo ausente no ZIP: ${fileMeta.path}`).toBeDefined();
			expect(insideZip!.sha256).toBe(fileMeta.sha256);
			expect(insideZip!.sizeBytes).toBe(fileMeta.sizeBytes);
		}

		// CSV mantém feição descartada (P2), enquanto camadas vetoriais excluem dismissed_noise
		const csvText = unpacked.get('02_relatorio_poligonos.csv')!.buffer.toString('utf8');
		expect(csvText).toContain('dismissed_noise');
		const degGeo = JSON.parse(
			unpacked.get('03_vetores/degradacao.geojson')!.buffer.toString('utf8'),
		);
		expect(degGeo.features).toHaveLength(0);
		const regGeo = JSON.parse(
			unpacked.get('03_vetores/regeneracao.geojson')!.buffer.toString('utf8'),
		);
		expect(regGeo.features.length).toBeGreaterThanOrEqual(1);

		// 5. POST /integrity/verify — JSON hash (autêntico e inválido) e Multipart streaming (ZIP autêntico e PDF adulterado)
		const verifyJsonOk = await app.inject({
			method: 'POST',
			url: '/api/v1/integrity/verify',
			headers: { authorization: `Bearer ${auditorToken}` },
			payload: { sha256: ssePdfSha.toUpperCase() },
		});
		expect(verifyJsonOk.statusCode).toBe(200);
		const vj = verifyJsonOk.json();
		expect(vj.verified).toBe(true);
		expect(vj.matchedArtifact).toBe('PDF_CARTA_IMAGEM');
		expect(vj.sha256).toBe(ssePdfSha);
		expect(vj.record.protocolCode).toBe(protocolCode);
		expect(vj.record.municipality).toContain('Vilhena');
		expect(vj.record.issuer.registrationCode).toContain('EXP-');

		const verifyJsonMiss = await app.inject({
			method: 'POST',
			url: '/api/v1/integrity/verify',
			headers: { authorization: `Bearer ${auditorToken}` },
			payload: { sha256: '0'.repeat(64) },
		});
		expect(verifyJsonMiss.statusCode).toBe(200);
		expect(verifyJsonMiss.json()).toEqual({
			verified: false,
			matchedArtifact: null,
			sha256: '0'.repeat(64),
			record: null,
		});

		const verifyJsonBad = await app.inject({
			method: 'POST',
			url: '/api/v1/integrity/verify',
			headers: { authorization: `Bearer ${auditorToken}` },
			payload: { sha256: 'hash-invalido' },
		});
		expect(verifyJsonBad.statusCode).toBe(400);

		const zipMultipart = buildBinaryMultipartBody(
			'file',
			`PACOTE_${protocolCode}_v1.zip`,
			'application/zip',
			dlZipRes.rawPayload,
		);
		const verifyZipOk = await app.inject({
			method: 'POST',
			url: '/api/v1/integrity/verify',
			headers: {
				authorization: `Bearer ${auditorToken}`,
				'content-type': zipMultipart.contentTypeHeader,
			},
			payload: zipMultipart.body,
		});
		expect(verifyZipOk.statusCode).toBe(200);
		expect(verifyZipOk.json().verified).toBe(true);
		expect(verifyZipOk.json().matchedArtifact).toBe('ZIP_PACOTE_TECNICO');
		expect(verifyZipOk.json().sha256).toBe(sseZipSha);

		// Adulteração de 1 byte no PDF invalida verificação
		const tamperedPdfMultipart = buildBinaryMultipartBody(
			'file',
			'adulterado.pdf',
			'application/pdf',
			Buffer.concat([dlPdfRes.rawPayload, Buffer.from('\n%adulteracao', 'utf8')]),
		);
		const verifyTamperedRes = await app.inject({
			method: 'POST',
			url: '/api/v1/integrity/verify',
			headers: {
				authorization: `Bearer ${auditorToken}`,
				'content-type': tamperedPdfMultipart.contentTypeHeader,
			},
			payload: tamperedPdfMultipart.body,
		});
		expect(verifyTamperedRes.statusCode).toBe(200);
		expect(verifyTamperedRes.json().verified).toBe(false);
		expect(verifyTamperedRes.json().record).toBeNull();

		// Upload vazio (0 bytes) -> 400
		const emptyMultipart = buildBinaryMultipartBody(
			'file',
			'vazio.pdf',
			'application/pdf',
			Buffer.alloc(0),
		);
		const verifyEmptyRes = await app.inject({
			method: 'POST',
			url: '/api/v1/integrity/verify',
			headers: {
				authorization: `Bearer ${auditorToken}`,
				'content-type': emptyMultipart.contentTypeHeader,
			},
			payload: emptyMultipart.body,
		});
		expect(verifyEmptyRes.statusCode).toBe(400);

		// 6. Trilha de Auditoria registra toda a cadeia (export_requested, export_generated, export_downloaded, integrity_verified)
		const runAuditRes = await app.inject({
			method: 'GET',
			url: `/api/v1/audit-logs?entityId=${runId}`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(runAuditRes.statusCode).toBe(200);
		expect(runAuditRes.json().items.map((i: { action: string }) => i.action)).toContain(
			'export_requested',
		);

		const pkgAuditRes = await app.inject({
			method: 'GET',
			url: `/api/v1/audit-logs?entityId=${sseExportId}`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(pkgAuditRes.statusCode).toBe(200);
		const pkgActions = pkgAuditRes.json().items.map((i: { action: string }) => i.action);
		expect(pkgActions).toContain('export_generated');
		expect(pkgActions).toContain('export_downloaded');
		expect(pkgActions).toContain('integrity_verified');
	}, 45_000);
});
