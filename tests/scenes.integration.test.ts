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
import sceneService from '../src/service/sceneService.js';
import { projectCoords } from '../src/utils/geo/projRegistry.js';
import { computeAoiSclMetrics } from '../src/utils/geo/sclAnalyzer.js';
import {
	normalizeStacItem,
	type NormalizedStacItem,
	type StacCatalogAdapter,
	type StacItemRaw,
} from '../src/utils/geo/stacClient.js';
import {
	assertSafeWhitelistedUrl,
	isPrivateOrReservedIp,
	safeExternalFetch,
	StacCircuitBreaker,
} from '../src/utils/helpers/antiSsrfHttp.js';
import { DomainError } from '../src/utils/helpers/domainError.js';
import type { AoiPolygonGeoJson } from '../src/utils/validation/caseValidation.js';

// Gera um buffer GeoTIFF georreferenciado real (banda SCL Uint8) em WGS84 UTM 20S (EPSG:32720)
function buildSyntheticSclGeoTiff(params: {
	originE: number;
	originN: number;
	pixelSizeM: number;
	width: number;
	height: number;
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
		ModelPixelScale: [params.pixelSizeM, params.pixelSizeM, 0],
		ModelTiepoint: [0, 0, 0, params.originE, params.originN, 0],
		ProjectedCSTypeGeoKey: 32720,
		GTModelTypeGeoKey: 1,
		GTRasterTypeGeoKey: 1,
	});
}

// Simula servidor COG com suporte a HTTP Range (206 Partial Content) em memória
function createRangeMockFetch(filesByUrl: Record<string, ArrayBuffer>): typeof globalThis.fetch {
	return async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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
}

describe('Task API-05 — Anti-SSRF, Leitura COG SCL e Busca STAC Multitemporal', () => {
	let app: FastifyInstance;
	let analystToken: string;
	let auditorToken: string;
	let caseId: string;

	const aoiVilhena: AoiPolygonGeoJson = {
		type: 'Polygon',
		coordinates: [
			[
				[-60.2, -12.7],
				[-60.16, -12.7],
				[-60.16, -12.66],
				[-60.2, -12.66],
				[-60.2, -12.7],
			],
		],
	};

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

		app = await buildApp({ silentLogs: true, useMemoryRateLimit: true });
		await app.ready();

		const [anaRes, audRes] = await Promise.all([
			app.inject({
				method: 'POST',
				url: '/api/v1/auth/login',
				remoteAddress: '10.30.1.1',
				payload: { email: 'analista@sicam.gov.br', password: 'Sicam@Analista2026!' },
			}),
			app.inject({
				method: 'POST',
				url: '/api/v1/auth/login',
				remoteAddress: '10.30.1.2',
				payload: { email: 'auditor@sicam.gov.br', password: 'Sicam@Auditor2026!' },
			}),
		]);

		analystToken = anaRes.json().accessToken as string;
		auditorToken = audRes.json().accessToken as string;

		const createCaseRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Caso Teste STAC Multitemporal',
				aoiGeoJson: aoiVilhena,
			},
		});
		expect(createCaseRes.statusCode).toBe(201);
		caseId = createCaseRes.json().id as string;
	});

	afterAll(async () => {
		if (app) await app.close();
		await closeDb();
		await closeRedis();
		closeS3();
	});

	it('deve bloquear estritamente vetores SSRF: HTTP plano, domínios fora da whitelist, IPs privados e Redirect 302 malicioso (RN-02)', async () => {
		// IPs privados/reservados
		expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
		expect(isPrivateOrReservedIp('10.24.0.8')).toBe(true);
		expect(isPrivateOrReservedIp('172.16.5.1')).toBe(true);
		expect(isPrivateOrReservedIp('172.31.255.255')).toBe(true);
		expect(isPrivateOrReservedIp('192.168.1.10')).toBe(true);
		expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
		expect(isPrivateOrReservedIp('::1')).toBe(true);
		expect(isPrivateOrReservedIp('::ffff:169.254.169.254')).toBe(true);
		expect(isPrivateOrReservedIp('52.218.200.10')).toBe(false);

		// Protocolo http, porta customizada e host fora da whitelist
		expect(() =>
			assertSafeWhitelistedUrl('http://earth-search.aws.element84.com/v1/search'),
		).toThrow(DomainError);
		expect(() =>
			assertSafeWhitelistedUrl('https://earth-search.aws.element84.com:8443/v1/search'),
		).toThrow(DomainError);
		expect(() => assertSafeWhitelistedUrl('https://169.254.169.254/latest/meta-data')).toThrow(
			DomainError,
		);
		expect(() => assertSafeWhitelistedUrl('https://evil-attacker.example.com/cog.tif')).toThrow(
			DomainError,
		);

		// DNS Rebinding (domínio na whitelist resolvendo para 127.0.0.1)
		await expect(
			safeExternalFetch(
				'https://earth-search.aws.element84.com/v1/search',
				{},
				{
					maxAttempts: 1,
					lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
					fetchFn: async () => new Response('{}', { status: 200 }),
				},
			),
		).rejects.toMatchObject({ errorCode: 'ERR_STAC_ITEM_INVALID' });

		// Redirect HTTP 302 de domínio oficial para IP de metadados da nuvem (169.254.169.254)
		await expect(
			safeExternalFetch(
				'https://earth-search.aws.element84.com/v1/items/test',
				{},
				{
					maxAttempts: 1,
					lookupFn: async () => [{ address: '52.218.100.10', family: 4 }],
					fetchFn: async () =>
						new Response(null, {
							status: 302,
							headers: { Location: 'http://169.254.169.254/latest/meta-data/iam' },
						}),
				},
			),
		).rejects.toMatchObject({ errorCode: 'ERR_STAC_ITEM_INVALID' });

		// Circuit breaker abre após falhas consecutivas
		const breaker = new StacCircuitBreaker({ failureThreshold: 2, openDurationMs: 10_000 });
		breaker.recordFailure('aws_earth_search');
		expect(breaker.isOpen('aws_earth_search')).toBe(false);
		breaker.recordFailure('aws_earth_search');
		expect(breaker.isOpen('aws_earth_search')).toBe(true);
	});

	it('deve ler GeoTIFF SCL real via HTTP Range e medir cobertura e % exata de nuvens na AOI, incluindo mosaico multi-tile (RF-12, RF-13)', async () => {
		const [eMin, nMin] = projectCoords('EPSG:4674', 'EPSG:31980', -60.2, -12.7);
		const [eMax, nMax] = projectCoords('EPSG:4674', 'EPSG:31980', -60.16, -12.66);
		const eMid = (eMin + eMax) / 2;

		const originE = Math.floor(eMin / 20) * 20 - 400;
		const originN = Math.ceil(nMax / 20) * 20 + 400;
		const width = Math.ceil((eMax - originE + 400) / 20);
		const height = Math.ceil((originN - nMin + 400) / 20);

		// Tile oeste: metade oeste da AOI limpa (SCL=4 Vegetação), metade leste NoData (SCL=0)
		const westUrl = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/20LMP/SCL_west.tif';
		const westTiff = buildSyntheticSclGeoTiff({
			originE,
			originN,
			pixelSizeM: 20,
			width,
			height,
			fillFn: (col) => {
				const pixelE = originE + (col + 0.5) * 20;
				return pixelE <= eMid ? 4 : 0;
			},
		});

		// Tile leste: metade oeste NoData (SCL=0), metade leste com nuvem alta (SCL=9)
		const eastUrl = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/20LMQ/SCL_east.tif';
		const eastTiff = buildSyntheticSclGeoTiff({
			originE,
			originN,
			pixelSizeM: 20,
			width,
			height,
			fillFn: (col) => {
				const pixelE = originE + (col + 0.5) * 20;
				return pixelE > eMid ? 9 : 0;
			},
		});

		const mockFetch = createRangeMockFetch({
			[westUrl]: westTiff,
			[eastUrl]: eastTiff,
		});
		const publicLookup = async () => [{ address: '52.218.200.55', family: 4 }];

		// Mosaico dos 2 tiles: 100% da AOI coberta, ~50% limpa (oeste) e ~50% nuvem (leste)
		const mosaicMetrics = await computeAoiSclMetrics({
			aoiGeoJson: aoiVilhena,
			utmSrid: 31980,
			sclTiles: [
				{ href: westUrl, projEpsg: 32720 },
				{ href: eastUrl, projEpsg: 32720 },
			],
			safeFetchOptions: {
				lookupFn: publicLookup,
				fetchFn: mockFetch,
				maxAttempts: 1,
			},
		});

		expect(mosaicMetrics.aoiCoveragePct).toBe(100);
		expect(mosaicMetrics.aoiCloudPct).toBeGreaterThan(48);
		expect(mosaicMetrics.aoiCloudPct).toBeLessThan(52);
	});

	it('deve buscar cenas, deduplicar/agrupar multi-tile MGRS, ordenar da mais limpa para mais nublada, fazer fallback e servir preview assinado', async () => {
		const rawPngBytes = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
			'base64',
		);

		const makeMockItem = (opts: {
			id: string;
			provider: 'aws_earth_search' | 'inpe_bdc';
			datetime: string;
			mgrs: string;
			globalCloud: number;
			baseline: string;
		}): NormalizedStacItem => {
			const raw: StacItemRaw = {
				id: opts.id,
				collection: opts.provider === 'aws_earth_search' ? 'sentinel-2-l2a' : 'S2_L2A-1',
				properties: {
					datetime: opts.datetime,
					'eo:cloud_cover': opts.globalCloud,
					's2:mgrs_tile': opts.mgrs,
					's2:processing_baseline': opts.baseline,
					'proj:epsg': 32720,
				},
				assets: {
					scl: { href: `https://sentinel-cogs.s3.us-west-2.amazonaws.com/${opts.id}/SCL.tif` },
					SCL: { href: `https://data.inpe.br/bdc/stac/v1/${opts.id}/SCL.tif` },
					thumbnail: {
						href: `https://sentinel-cogs.s3.us-west-2.amazonaws.com/${opts.id}/thumb.png`,
					},
				},
			};
			return normalizeStacItem(raw, opts.provider)!;
		};

		const cloudByHref: Record<string, number> = {
			// Passagem nublada em 2024-08-05 (32.5% nuvem na AOI)
			'https://sentinel-cogs.s3.us-west-2.amazonaws.com/S2A_20LMP_20240805_0_L2A/SCL.tif': 32.5,
			// Passagem limpa multi-tile em 2024-08-15 (20LMP + 20LMQ + reprocessamento _1_L2A deduplicado -> 1.2% nuvem!)
			'https://sentinel-cogs.s3.us-west-2.amazonaws.com/S2B_20LMP_20240815_1_L2A/SCL.tif': 1.2,
			'https://sentinel-cogs.s3.us-west-2.amazonaws.com/S2B_20LMQ_20240815_0_L2A/SCL.tif': 1.2,
			// T1 cena limpa
			'https://sentinel-cogs.s3.us-west-2.amazonaws.com/S2A_20LMP_20260820_0_L2A/SCL.tif': 0.4,
		};

		let simulateInpeFailure = true;

		const fakeCatalog: StacCatalogAdapter = {
			async searchItems({ provider, fromDate }) {
				if (provider === 'inpe_bdc' && simulateInpeFailure) {
					throw new DomainError('ERR_UPSTREAM_STAC_UNAVAILABLE', 'Timeout simulado no INPE BDC');
				}
				if (provider === 'inpe_bdc') {
					return [];
				}
				if (fromDate.startsWith('2024')) {
					return [
						makeMockItem({
							id: 'S2A_20LMP_20240805_0_L2A',
							provider: 'aws_earth_search',
							datetime: '2024-08-05T14:27:19Z',
							mgrs: '20LMP',
							globalCloud: 8.0,
							baseline: '05.10',
						}),
						// Versão antiga do mesmo tile 20LMP em 2024-08-15 (deve ser deduplicada em favor da _1_L2A 05.11)
						makeMockItem({
							id: 'S2B_20LMP_20240815_0_L2A',
							provider: 'aws_earth_search',
							datetime: '2024-08-15T14:27:19Z',
							mgrs: '20LMP',
							globalCloud: 15.0,
							baseline: '05.00',
						}),
						makeMockItem({
							id: 'S2B_20LMP_20240815_1_L2A',
							provider: 'aws_earth_search',
							datetime: '2024-08-15T14:27:19Z',
							mgrs: '20LMP',
							globalCloud: 14.0,
							baseline: '05.11',
						}),
						// Tile vizinho 20LMQ na mesma data -> forma mosaico isMultiTile = true!
						makeMockItem({
							id: 'S2B_20LMQ_20240815_0_L2A',
							provider: 'aws_earth_search',
							datetime: '2024-08-15T14:27:25Z',
							mgrs: '20LMQ',
							globalCloud: 10.0,
							baseline: '05.11',
						}),
					];
				}
				return [
					makeMockItem({
						id: 'S2A_20LMP_20260820_0_L2A',
						provider: 'aws_earth_search',
						datetime: '2026-08-20T14:27:21Z',
						mgrs: '20LMP',
						globalCloud: 5.2,
						baseline: '05.11',
					}),
				];
			},
			async getItem({ provider, itemId }) {
				return makeMockItem({
					id: itemId,
					provider,
					datetime: '2026-08-20T14:27:21Z',
					mgrs: '20LMP',
					globalCloud: 5.2,
					baseline: '05.11',
				});
			},
			async fetchAssetBytes() {
				return { contentType: 'image/png', buffer: rawPngBytes };
			},
		};

		sceneService.setAdaptersForTesting({
			catalogAdapter: fakeCatalog,
			sclEvaluator: async ({ sclTiles }) => ({
				aoiCloudPct: cloudByHref[sclTiles[0]!.href] ?? 10,
				aoiCoveragePct: 100,
			}),
			resetBreaker: true,
		});

		// 1. RBAC: Auditor bloqueado em POST /scenes/search (403)
		const forbiddenRes = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/scenes/search`,
			headers: { authorization: `Bearer ${auditorToken}` },
			payload: {
				t0Window: { from: '2024-07-01', to: '2024-09-30' },
				t1Window: { from: '2026-07-01', to: '2026-09-30' },
			},
		});
		expect(forbiddenRes.statusCode).toBe(403);

		// 2. Janela > 180 dias -> 400 ERR_VALIDATION_FAILED
		const wideWindowRes = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/scenes/search`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				t0Window: { from: '2024-01-01', to: '2024-12-31' },
				t1Window: { from: '2026-07-01', to: '2026-09-30' },
			},
		});
		expect(wideWindowRes.statusCode).toBe(400);
		expect(wideWindowRes.json().code).toBe('ERR_VALIDATION_FAILED');

		// 3. Ordem temporal invertida (T1 <= T0) -> 422 ERR_TEMPORAL_ORDER_INVALID
		const invertedRes = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/scenes/search`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				t0Window: { from: '2026-07-01', to: '2026-09-30' },
				t1Window: { from: '2024-07-01', to: '2024-09-30' },
			},
		});
		expect(invertedRes.statusCode).toBe(422);
		expect(invertedRes.json().code).toBe('ERR_TEMPORAL_ORDER_INVALID');

		// 4. Busca válida: AWS sucede + INPE registra providerWarning, mosaico MGRS agrupado e ordenado por aoiCloudPct ASC
		const searchRes = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/scenes/search`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				t0Window: { from: '2024-07-01', to: '2024-09-30' },
				t1Window: { from: '2026-07-01', to: '2026-09-30' },
				providers: ['aws_earth_search', 'inpe_bdc'],
				maxGlobalCloudPct: 40,
				limitPerWindow: 15,
			},
		});
		expect(searchRes.statusCode).toBe(200);
		const body = searchRes.json();
		expect(body.caseId).toBe(caseId);
		expect(body.providerWarnings).toEqual([
			expect.objectContaining({ provider: 'inpe_bdc', code: 'PROVIDER_UNAVAILABLE' }),
		]);

		// Candidato 0 de T0 deve ser a passagem 2024-08-15 (1.2% nuvem na AOI, mesmo tendo globalCloudPct maior!)
		expect(body.t0Candidates.length).toBe(2);
		expect(body.t0Candidates[0]).toMatchObject({
			candidateKey: 'aws_earth_search:sentinel-2-l2a:2024-08-15',
			isMultiTile: true,
			itemIds: ['S2B_20LMP_20240815_1_L2A', 'S2B_20LMQ_20240815_0_L2A'],
			aoiCloudPct: 1.2,
			boaOffsetApplied: true,
		});
		expect(body.t0Candidates[1]).toMatchObject({
			candidateKey: 'aws_earth_search:sentinel-2-l2a:2024-08-05',
			isMultiTile: false,
			aoiCloudPct: 32.5,
		});

		// 5. Endpoint de preview assinado funciona autenticado e rejeita token adulterado
		const previewUrl = body.t1Candidates[0].previewUrl as string;
		const previewOk = await app.inject({
			method: 'GET',
			url: previewUrl,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(previewOk.statusCode).toBe(200);
		expect(previewOk.headers['content-type']).toBe('image/png');
		expect(previewOk.rawPayload.length).toBe(rawPngBytes.length);

		const previewTampered = await app.inject({
			method: 'GET',
			url: `/api/v1/cases/${caseId}/scenes/preview?token=${'x'.repeat(64)}`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(previewTampered.statusCode).toBe(422);
		expect(previewTampered.json().code).toBe('ERR_STAC_ITEM_INVALID');

		// 6. Se todos os provedores falharem -> 502 ERR_UPSTREAM_STAC_UNAVAILABLE
		simulateInpeFailure = true;
		const failingRes = await app.inject({
			method: 'POST',
			url: `/api/v1/cases/${caseId}/scenes/search`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				t0Window: { from: '2024-07-01', to: '2024-09-30' },
				t1Window: { from: '2026-07-01', to: '2026-09-30' },
				providers: ['inpe_bdc'],
			},
		});
		expect(failingRes.statusCode).toBe(502);
		expect(failingRes.json().code).toBe('ERR_UPSTREAM_STAC_UNAVAILABLE');
	});
});
