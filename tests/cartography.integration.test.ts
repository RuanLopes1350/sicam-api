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
import runService from '../src/service/runService.js';
import {
	closeCartographyBrowser,
	NORMALIZED_CARTOGRAPHIC_SCALES,
	renderHtmlToCartographicPdf,
	renderRunCartographicPlatePdf,
} from '../src/utils/geo/cartography/index.js';
import { projectCoords } from '../src/utils/geo/projRegistry.js';
import {
	normalizeStacItem,
	type NormalizedStacItem,
	type StacCatalogAdapter,
	type StacItemRaw,
} from '../src/utils/geo/stacClient.js';
import { DomainError } from '../src/utils/helpers/domainError.js';
import type { AoiPolygonGeoJson } from '../src/utils/validation/caseValidation.js';
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

function parseMediaBoxDimensionsPt(pdfBuffer: Buffer): [number, number] | null {
	const text = pdfBuffer.toString('latin1');
	const match = /\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/.exec(text);
	if (!match?.[1] || !match?.[2]) {
		return null;
	}
	return [Number(match[1]), Number(match[2])];
}

describe('Task API-09 — Motor Cartográfico A4/A3 (300 DPI) no Playwright Offline (Integração)', () => {
	let app: FastifyInstance;
	let runId: string;

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

	const cogOriginX = aoiUtm.eMin - 260;
	const cogOriginY = aoiUtm.nMax + 260;
	const cogSize = 104;

	const t0Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/api09/t0';
	const t1Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/api09/t1';
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
				fillFn: () => 1300,
			}),
			[`${t0Prefix}/b08.tif`]: buildUint16GeoTiff({
				originX: cogOriginX,
				originY: cogOriginY,
				pixelSize: 10,
				width: cogSize,
				height: cogSize,
				projectedEpsg: 32720,
				fillFn: () => 4600,
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
				fillFn: (c, r) => (inDefDonut(c, r) ? 3800 : inDegradation(c, r) ? 3000 : 4600),
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
			enqueueJobFn: async (payload) => `direct-${payload.runId}`,
			resetBreaker: true,
		});

		app = await buildApp({ silentLogs: true, useMemoryRateLimit: true });
		await app.ready();

		const admRes = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.90.1.1',
			payload: { email: 'admin@sicam.gov.br', password: 'Sicam@Admin2026!' },
		});
		const adminToken = admRes.json().accessToken;

		const tag = randomUUID().slice(0, 8);
		const email = `carto.ana.${tag}@sicam.gov.br`;
		const pass = 'Sicam@Carto2026!';
		await app.inject({
			method: 'POST',
			url: '/api/v1/users',
			headers: { authorization: `Bearer ${adminToken}` },
			payload: {
				fullName: 'Analista Cartográfico RO',
				registrationCode: `CRT-${tag.toUpperCase()}`,
				email,
				password: pass,
				role: 'analyst',
			},
		});

		const anaLogin = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.90.1.2',
			payload: { email, password: pass },
		});
		const analystToken = anaLogin.json().accessToken;

		const caseRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Carta-Imagem Teste API-09 — Vilhena/RO',
				externalRef: `PROC-CRT-${tag}`,
				description: 'Caso de validação cartográfica A4/A3 em 300 DPI.',
				aoiGeoJson,
			},
		});
		const caseId = caseRes.json().id;

		const runRes = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/runs`,
			headers: { authorization: `Bearer ${analystToken}`, 'idempotency-key': randomUUID() },
			payload: {
				t0: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T0_ID] },
				t1: { provider: 'aws_earth_search', collection: 'sentinel-2-l2a', itemIds: [T1_ID] },
				presetName: 'TECHNICAL_STANDARD',
				customParams: null,
			},
		});
		runId = runRes.json().runId;

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

			return new Response(buf, {
				status: 200,
				headers: {
					'Content-Type': 'image/tiff',
					'Accept-Ranges': 'bytes',
					'Content-Length': String(buf.byteLength),
				},
			});
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

		const detail = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runId}`,
			headers: { authorization: `Bearer ${analystToken}` },
		});
		expect(detail.json().status).toBe('ready_for_review');

		// Marca a segunda feição (degradation P2) como ruído descartado para confirmar que não entra na carta
		const featsRes = await app.inject({
			method: 'GET',
			url: `/api/v1/runs/${runId}/features?format=json`,
			headers: { authorization: `Bearer ${analystToken}` },
		});
		const items = featsRes.json().items as Array<{ id: string; featureClass: string }>;
		const p2 = items.find((f) => f.featureClass === 'degradation');
		if (p2) {
			await app.inject({
				method: 'PATCH',
				url: `/api/v1/runs/${runId}/features/${p2.id}/review`,
				headers: { authorization: `Bearer ${analystToken}` },
				payload: {
					reviewStatus: 'dismissed_noise',
					dismissalReason: 'Sombra topográfica descartada antes da emissão da carta-imagem.',
				},
			});
		}
	}, 30000);

	afterAll(async () => {
		await closeCartographyBrowser();
		if (app) {
			await app.close();
		}
		closeS3();
		await closeRedis();
		await closeDb();
	});

	it('deve bloquear 100% das requisições de rede externas no Chromium Headless (RNF-05 Anti-SSRF)', async () => {
		const maliciousHtml = `<!DOCTYPE html>
      <html>
        <head><link rel="stylesheet" href="https://evil.cdn.example/style.css" /></head>
        <body>
          <h1>Carta Isolada Offline</h1>
          <img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/" />
        </body>
      </html>`;

		const res = await renderHtmlToCartographicPdf(maliciousHtml, 'A4');
		expect(res.pdfBuffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		expect(res.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(res.blockedRequests).toContain('https://evil.cdn.example/style.css');
		expect(res.blockedRequests).toContain(
			'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
		);
	});

	it('deve gerar prancha PDF em A3 e A4 a 300 DPI em medidas físicas exatas com dados reais do PostGIS/S3', async () => {
		const fingerprint = 'f'.repeat(64);
		const fixedTime = new Date('2026-11-26T18:30:00Z');

		const a3Result = await renderRunCartographicPlatePdf({
			runId,
			paperFormat: 'A3',
			issuer: { fullName: 'Analista Emissor Oficial', registrationCode: 'CRT-001' },
			observations: 'Prancha emitida em período seco (<b>Teste XSS</b>).',
			datasetFingerprintSha256: fingerprint,
			emittedAt: fixedTime,
		});

		expect(a3Result.pdfBuffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		expect(a3Result.pdfSizeBytes).toBeGreaterThan(25_000);
		expect(a3Result.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(a3Result.blockedRequests).toEqual([]);
		expect(NORMALIZED_CARTOGRAPHIC_SCALES).toContain(a3Result.cartographicScale);
		// Somente P1 ativo entra na carta (P2 descartado como dismissed_noise foi excluído)
		expect(a3Result.bundle.activeFeatures).toHaveLength(1);

		const a3BoxPt = parseMediaBoxDimensionsPt(a3Result.pdfBuffer);
		expect(a3BoxPt).not.toBeNull();
		// 420 mm = 1190.55 pt; 297 mm = 841.89 pt (tolerância de arredondamento Blink/Skia < 2 pt)
		expect(Math.abs(a3BoxPt![0] - (420 * 72) / 25.4)).toBeLessThan(2.0);
		expect(Math.abs(a3BoxPt![1] - (297 * 72) / 25.4)).toBeLessThan(2.0);

		const a4Result = await renderRunCartographicPlatePdf({
			runId,
			paperFormat: 'A4',
			issuer: { fullName: 'Analista Emissor Oficial', registrationCode: 'CRT-001' },
			observations: null,
			datasetFingerprintSha256: fingerprint,
			emittedAt: fixedTime,
		});

		expect(a4Result.pdfBuffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		expect(a4Result.blockedRequests).toEqual([]);
		const a4BoxPt = parseMediaBoxDimensionsPt(a4Result.pdfBuffer);
		expect(a4BoxPt).not.toBeNull();
		// 297 mm = 841.89 pt; 210 mm = 595.28 pt
		expect(Math.abs(a4BoxPt![0] - (297 * 72) / 25.4)).toBeLessThan(2.0);
		expect(Math.abs(a4BoxPt![1] - (210 * 72) / 25.4)).toBeLessThan(2.0);

		// Execução inexistente lança ERR_RESOURCE_NOT_FOUND
		await expect(
			renderRunCartographicPlatePdf({
				runId: randomUUID(),
				paperFormat: 'A3',
				issuer: { fullName: 'Teste', registrationCode: 'T-1' },
				datasetFingerprintSha256: fingerprint,
			}),
		).rejects.toMatchObject({
			errorCode: 'ERR_RESOURCE_NOT_FOUND',
		} satisfies Partial<DomainError>);
	});
});
