import { writeArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_PRESETS } from '../src/config/presets.js';
import {
	buildCanonicalAoiMask,
	classifyMultitemporalNdvi,
	colToCenterE,
	createCanonicalGrid,
	dnToBoaReflectance,
	PIXEL_CLASS,
	readCanonicalSceneBands,
	resolveAndValidateAlgorithmParams,
	resolveBandAsset,
	resolveOpticalRadiometry,
	rowToCenterN,
	utmToCol,
	utmToRow,
} from '../src/utils/geo/core/index.js';
import { INPE_BDC_ALBERS_CODE, projectCoords } from '../src/utils/geo/projRegistry.js';
import type { StacItemRaw } from '../src/utils/geo/stacClient.js';
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

function createMockRangeFetch(
	filesByUrl: Record<string, ArrayBuffer>,
	requestedUrls: string[] = [],
): typeof globalThis.fetch {
	return async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		requestedUrls.push(url);
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

describe('Task API-06 — Motor Científico geo-core Parte 1', () => {
	describe('1. CanonicalGrid (10 m snap, margem 15%/250m e trava Anti-OOM)', () => {
		it('deve aplicar margem mínima de 250 m em quadrante de 1 ha, alinhar a múltiplos de 10 m e converter coordenadas', () => {
			// 100 m x 100 m = 1 ha em UTM 20S (EPSG:31980)
			const aoi1Ha = makeUtmBoxAoiGeoJson(804000, 8594000, 804100, 8594100, 31980);
			const grid = createCanonicalGrid(aoi1Ha, 31980);

			expect(grid.pixelSizeM).toBe(10);
			expect(grid.e0 % 10).toBe(0);
			expect(grid.e1 % 10).toBe(0);
			expect(grid.n0 % 10).toBe(0);
			expect(grid.n1 % 10).toBe(0);

			// Margem mínima de 250 m em cada lado -> largura e altura >= 600 m (>= 60 px)
			expect(grid.e1 - grid.e0).toBeGreaterThanOrEqual(600);
			expect(grid.n1 - grid.n0).toBeGreaterThanOrEqual(600);
			expect(grid.width).toBe((grid.e1 - grid.e0) / 10);
			expect(grid.height).toBe((grid.n1 - grid.n0) / 10);
			expect(grid.pixelCount).toBe(grid.width * grid.height);

			// Conversões coordenada <-> pixel (Spec 1.2)
			const col = utmToCol(grid, 804055);
			const row = utmToRow(grid, 8594055);
			expect(colToCenterE(grid, col)).toBe(grid.e0 + (col + 0.5) * 10);
			expect(rowToCenterN(grid, row)).toBe(grid.n1 - (row + 0.5) * 10);

			// Máscara Scanline da AOI separa margem visual (0) de pixels dentro da AOI (1)
			const mask = buildCanonicalAoiMask(grid);
			let insideCount = 0;
			for (let i = 0; i < mask.length; i++) {
				if (mask[i] === 1) insideCount++;
			}
			// 1 ha = 100 pixels exatos de 10m x 10m (100 m²)
			expect(insideCount).toBe(100);
			// Canto extremo da margem visual deve estar fora da AOI
			expect(mask[0]).toBe(0);
			expect(mask[mask.length - 1]).toBe(0);
		});

		it('deve aplicar margem proporcional de 15% em áreas maiores e acionar trava Anti-OOM (ERR_GRID_PIXEL_LIMIT_EXCEEDED)', () => {
			// 2000 m x 2000 m = 400 ha -> 15% = 300 m > 250 m -> extensão >= 2600 m (>= 260 px)
			const aoi400Ha = makeUtmBoxAoiGeoJson(800000, 8590000, 802000, 8592000, 31980);
			const grid = createCanonicalGrid(aoi400Ha, 31980);

			expect(grid.width).toBeGreaterThanOrEqual(260);
			expect(grid.height).toBeGreaterThanOrEqual(260);

			// Trava Anti-OOM dispara antes de qualquer alocação de TypedArray
			expect(() => createCanonicalGrid(aoi400Ha, 31980, 10_000)).toThrow(DomainError);
			try {
				createCanonicalGrid(aoi400Ha, 31980, 10_000);
			} catch (err) {
				expect(err).toBeInstanceOf(DomainError);
				expect((err as DomainError).errorCode).toBe('ERR_GRID_PIXEL_LIMIT_EXCEEDED');
				expect((err as DomainError).statusCode).toBe(422);
			}
		});
	});

	describe('2. Normalização Radiométrica BOA e Teste de Invariância RNF-07 (Pré vs Pós-2022)', () => {
		const makeItem = (overrides: Partial<StacItemRaw> = {}): StacItemRaw => ({
			id: 'S2_TEST_ITEM',
			properties: {},
			assets: {
				blue: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b02.tif' },
				green: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b03.tif' },
				red: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b04.tif' },
				nir: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b08.tif' },
				scl: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/scl.tif' },
			},
			...overrides,
		});

		it('deve resolver a cascata determinística (raster:bands, earthsearch flag, baseline e INPE BDC) e produzir 0,00% falso positivo entre 2019 e 2026', () => {
			// Cena 2019 (Baseline 02.14 sem offset): Floresta intacta DN_RED=280, DN_NIR=3600 -> ρ_RED=0.028, ρ_NIR=0.36
			const item2019 = makeItem({
				id: 'S2A_20LMP_20190810_0_L2A',
				properties: {
					's2:processing_baseline': '02.14',
					'earthsearch:boa_offset_applied': false,
				},
			});

			// Cena 2026 Prioridade 1 (raster:bands explícito AWS): offset=-0.1 -> DN_RED=1280, DN_NIR=4600 -> ρ_RED=0.028, ρ_NIR=0.36
			const item2026RasterMeta = makeItem({
				id: 'S2B_20LMP_20260815_0_L2A',
				properties: { 's2:processing_baseline': '05.11' },
				assets: {
					blue: {
						href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b02.tif',
						'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
					},
					green: {
						href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b03.tif',
						'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
					},
					red: {
						href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b04.tif',
						'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
					},
					nir: {
						href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b08.tif',
						'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
					},
					scl: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/scl.tif' },
				},
			});

			// Cena 2026 Prioridade 2b (somente s2:processing_baseline >= 4.0)
			const item2026BaselineOnly = makeItem({
				id: 'S2B_20LMP_20260820_0_L2A',
				properties: { 's2:processing_baseline': '04.00' },
			});

			// Cena INPE BDC com nodata = -9999
			const itemInpeBdc: StacItemRaw = {
				id: 'S2_L2A-1_020030_20260820',
				properties: {},
				assets: {
					B02: { href: 'https://data.inpe.br/bdc/b02.tif' },
					B03: { href: 'https://data.inpe.br/bdc/b03.tif' },
					B04: {
						href: 'https://data.inpe.br/bdc/b04.tif',
						'raster:bands': [{ scale: 0.0001, nodata: -9999 }],
					},
					B08: {
						href: 'https://data.inpe.br/bdc/b08.tif',
						'raster:bands': [{ scale: 0.0001, nodata: -9999 }],
					},
					SCL: { href: 'https://data.inpe.br/bdc/scl.tif' },
				},
			};

			const calRed2019 = resolveOpticalRadiometry(item2019, 'aws_earth_search', 'RED');
			const calNir2019 = resolveOpticalRadiometry(item2019, 'aws_earth_search', 'NIR');
			const calRed2026 = resolveOpticalRadiometry(item2026RasterMeta, 'aws_earth_search', 'RED');
			const calNir2026 = resolveOpticalRadiometry(item2026RasterMeta, 'aws_earth_search', 'NIR');
			const calRedBaseline = resolveOpticalRadiometry(
				item2026BaselineOnly,
				'aws_earth_search',
				'RED',
			);
			const calInpeRed = resolveOpticalRadiometry(itemInpeBdc, 'inpe_bdc', 'RED');

			expect(calRed2019.boaOffsetApplied).toBe(false);
			expect(calRed2026.source).toBe('stac_raster_bands');
			expect(calRed2026.boaOffsetApplied).toBe(true);
			expect(calRedBaseline.source).toBe('processing_baseline');
			expect(calRedBaseline.boaOffsetApplied).toBe(true);
			expect(calInpeRed.source).toBe('inpe_bdc_default');

			const rhoRed2019 = dnToBoaReflectance(280, calRed2019);
			const rhoNir2019 = dnToBoaReflectance(3600, calNir2019);
			const rhoRed2026 = dnToBoaReflectance(1280, calRed2026);
			const rhoNir2026 = dnToBoaReflectance(4600, calNir2026);

			// Invariância física da vegetação densa (Spec Seção 3.2)
			expect(rhoRed2019).toBeCloseTo(0.028, 5);
			expect(rhoRed2026).toBeCloseTo(0.028, 5);
			expect(rhoNir2019).toBeCloseTo(0.36, 5);
			expect(rhoNir2026).toBeCloseTo(0.36, 5);
			expect(Number.isNaN(dnToBoaReflectance(0, calRed2026))).toBe(true);
			expect(Number.isNaN(dnToBoaReflectance(-9999, calInpeRed))).toBe(true);

			// Bug real Earth Search: flag earthsearch:boa_offset_applied=true coexistindo com raster:bands.offset=-0.1 estático
			const itemEarthSearchAlreadyApplied = makeItem({
				id: 'S2B_20LRL_20200601_1_L2A',
				properties: {
					's2:processing_baseline': '05.00',
					'earthsearch:boa_offset_applied': true,
				},
				assets: {
					blue: {
						href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b02.tif',
						'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
					},
					green: {
						href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b03.tif',
						'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
					},
					red: {
						href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b04.tif',
						'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
					},
					nir: {
						href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/b08.tif',
						'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }],
					},
					scl: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/scl.tif' },
				},
			});
			const calAlreadyApplied = resolveOpticalRadiometry(
				itemEarthSearchAlreadyApplied,
				'aws_earth_search',
				'RED',
			);
			expect(calAlreadyApplied.source).toBe('earthsearch_flag');
			expect(calAlreadyApplied.offsetFinal).toBe(0);
			expect(calAlreadyApplied.boaOffsetApplied).toBe(true);
			expect(dnToBoaReflectance(220, calAlreadyApplied)).toBeCloseTo(0.022, 5);

			// Executa classificação de controle florestal 2019 vs 2026 em 100 pixels intactos -> 0,00% falso positivo (RNF-07)
			const n = 100;
			const aoiMask = new Uint8Array(n).fill(1);
			const t0 = {
				red: new Float32Array(n).fill(rhoRed2019),
				nir: new Float32Array(n).fill(rhoNir2019),
				scl: new Uint8Array(n).fill(4),
			};
			const t1 = {
				red: new Float32Array(n).fill(rhoRed2026),
				nir: new Float32Array(n).fill(rhoNir2026),
				scl: new Uint8Array(n).fill(4),
			};

			const result = classifyMultitemporalNdvi({
				t0,
				t1,
				aoiMask,
				algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
			});

			expect(result.ndviT0[0]).toBeGreaterThan(0.75);
			expect(result.ndviT0[0]).toBeLessThan(0.9);
			expect(result.ndviT1[0]).toBeCloseTo(result.ndviT0[0]!, 5);
			expect(result.metrics.deforestationPixels).toBe(0);
			expect(result.metrics.degradationPixels).toBe(0);
			expect(result.metrics.stablePixels).toBe(n);
		});

		it('deve rejeitar asset de banda ausente ou com domínio fora da whitelist Anti-SSRF', () => {
			const brokenItem: StacItemRaw = {
				id: 'BROKEN_ITEM',
				properties: {},
				assets: {
					red: { href: 'https://evil.attacker.local/red.tif' },
				},
			};

			expect(() => resolveBandAsset(brokenItem, 'aws_earth_search', 'RED')).toThrow(DomainError);
			expect(() => resolveBandAsset(brokenItem, 'aws_earth_search', 'NIR')).toThrow(DomainError);
		});
	});

	describe('3. CogBandReader Multi-Tile + Alinhamento 20m/10m + Projeção Albers INPE', () => {
		it('deve ler COGs via HTTP Range 206, alinhar SCL 20m com ópticas 10m e aplicar precedência Limpo > Nuvem no mosaico', async () => {
			const aoi = makeUtmBoxAoiGeoJson(804000, 8594000, 804200, 8594200, 31980);
			const grid = createCanonicalGrid(aoi, 31980);
			const midE = (grid.e0 + grid.e1) / 2;

			// Tile 1 (Oeste limpo floresta; Leste obstruído por nuvem SCL=9)
			const originX = grid.e0 - 40;
			const originY = grid.n1 + 40;
			const optWidth = grid.width + 8;
			const optHeight = grid.height + 8;
			const sclWidth = Math.ceil(optWidth / 2);
			const sclHeight = Math.ceil(optHeight / 2);

			const t1Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/tile1';
			const t2Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/tile2';
			const farPrefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/far';

			const files: Record<string, ArrayBuffer> = {
				// Tile 1
				[`${t1Prefix}/scl.tif`]: buildUint8SclGeoTiff({
					originX,
					originY,
					pixelSize: 20,
					width: sclWidth,
					height: sclHeight,
					projectedEpsg: 32720,
					fillFn: (col) => (originX + (col + 0.5) * 20 < midE ? 4 : 9),
				}),
				[`${t1Prefix}/b02.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: optWidth,
					height: optHeight,
					projectedEpsg: 32720,
					fillFn: () => 1200,
				}),
				[`${t1Prefix}/b03.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: optWidth,
					height: optHeight,
					projectedEpsg: 32720,
					fillFn: () => 1400,
				}),
				[`${t1Prefix}/b04.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: optWidth,
					height: optHeight,
					projectedEpsg: 32720,
					fillFn: (col) => (originX + (col + 0.5) * 10 < midE ? 1280 : 6000),
				}),
				[`${t1Prefix}/b08.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: optWidth,
					height: optHeight,
					projectedEpsg: 32720,
					fillFn: (col) => (originX + (col + 0.5) * 10 < midE ? 4600 : 6100),
				}),

				// Tile 2 (Oeste NoData; Leste limpo com solo exposto/desmatamento: DN_RED=3500, DN_NIR=2200 -> ρ_RED=0.25, ρ_NIR=0.12)
				[`${t2Prefix}/scl.tif`]: buildUint8SclGeoTiff({
					originX,
					originY,
					pixelSize: 20,
					width: sclWidth,
					height: sclHeight,
					projectedEpsg: 32720,
					fillFn: (col) => (originX + (col + 0.5) * 20 >= midE ? 5 : 0),
				}),
				[`${t2Prefix}/b02.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: optWidth,
					height: optHeight,
					projectedEpsg: 32720,
					fillFn: () => 1800,
				}),
				[`${t2Prefix}/b03.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: optWidth,
					height: optHeight,
					projectedEpsg: 32720,
					fillFn: () => 2200,
				}),
				[`${t2Prefix}/b04.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: optWidth,
					height: optHeight,
					projectedEpsg: 32720,
					fillFn: () => 3500,
				}),
				[`${t2Prefix}/b08.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: optWidth,
					height: optHeight,
					projectedEpsg: 32720,
					fillFn: () => 2200,
				}),

				// Tile 3 distante (não intersecta a CanonicalGrid -> bandas ópticas NÃO devem ser requisitadas)
				[`${farPrefix}/scl.tif`]: buildUint8SclGeoTiff({
					originX: 200000,
					originY: 8200000,
					pixelSize: 20,
					width: 10,
					height: 10,
					projectedEpsg: 32720,
					fillFn: () => 4,
				}),
				[`${farPrefix}/b02.tif`]: new ArrayBuffer(8),
				[`${farPrefix}/b03.tif`]: new ArrayBuffer(8),
				[`${farPrefix}/b04.tif`]: new ArrayBuffer(8),
				[`${farPrefix}/b08.tif`]: new ArrayBuffer(8),
			};

			const buildAwsItem = (id: string, prefix: string): StacItemRaw => ({
				id,
				properties: { 's2:processing_baseline': '05.11' },
				assets: {
					blue: { href: `${prefix}/b02.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }] },
					green: { href: `${prefix}/b03.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }] },
					red: { href: `${prefix}/b04.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }] },
					nir: { href: `${prefix}/b08.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }] },
					scl: { href: `${prefix}/scl.tif` },
				},
			});

			const requestedUrls: string[] = [];
			const mockFetch = createMockRangeFetch(files, requestedUrls);

			const result = await readCanonicalSceneBands({
				grid,
				provider: 'aws_earth_search',
				items: [
					buildAwsItem('TILE_1', t1Prefix),
					buildAwsItem('TILE_2', t2Prefix),
					buildAwsItem('TILE_FAR', farPrefix),
				],
				safeFetchOptions: {
					lookupFn: async () => [{ address: '52.218.10.20', family: 4 }],
					fetchFn: mockFetch,
					maxAttempts: 1,
				},
			});

			expect(result.radiometryAudit.length).toBe(2);
			// O tile distante só teve seu cabeçalho SCL lido e não disparou leitura de bandas ópticas
			expect(requestedUrls.some((u) => u.startsWith(`${farPrefix}/b0`))).toBe(false);

			// Verifica metade oeste (Tile 1 floresta limpo: SCL=4, ρ_RED=0.028, ρ_NIR=0.36)
			const midRow = Math.floor(grid.height / 2);
			const westIdx = midRow * grid.width + Math.floor(grid.width * 0.25);
			expect(result.scl[westIdx]).toBe(4);
			expect(result.red[westIdx]).toBeCloseTo(0.028, 3);
			expect(result.nir[westIdx]).toBeCloseTo(0.36, 3);

			// Verifica metade leste (Tile 2 limpo substituiu nuvem SCL=9 do Tile 1: SCL=5, ρ_RED=0.25, ρ_NIR=0.12)
			const eastIdx = midRow * grid.width + Math.floor(grid.width * 0.75);
			expect(result.scl[eastIdx]).toBe(5);
			expect(result.red[eastIdx]).toBeCloseTo(0.25, 3);
			expect(result.nir[eastIdx]).toBeCloseTo(0.12, 3);
		});

		it('deve reprojetar corretamente no Caso Geral (projeção Albers EPSG:102033 do INPE BDC)', async () => {
			const aoi = makeUtmBoxAoiGeoJson(804000, 8594000, 804120, 8594120, 31980);
			const grid = createCanonicalGrid(aoi, 31980);

			// Projeta os 4 cantos da CanonicalGrid para Albers BDC (EPSG:102033)
			const corners = [
				projectCoords('EPSG:31980', INPE_BDC_ALBERS_CODE, grid.e0, grid.n0),
				projectCoords('EPSG:31980', INPE_BDC_ALBERS_CODE, grid.e1, grid.n0),
				projectCoords('EPSG:31980', INPE_BDC_ALBERS_CODE, grid.e1, grid.n1),
				projectCoords('EPSG:31980', INPE_BDC_ALBERS_CODE, grid.e0, grid.n1),
			];
			const xMin = Math.min(...corners.map((c) => c[0]));
			const xMax = Math.max(...corners.map((c) => c[0]));
			const yMin = Math.min(...corners.map((c) => c[1]));
			const yMax = Math.max(...corners.map((c) => c[1]));

			const originX = Math.floor(xMin / 10) * 10 - 100;
			const originY = Math.ceil(yMax / 10) * 10 + 100;
			const w = Math.ceil((xMax - originX + 100) / 10);
			const h = Math.ceil((originY - yMin + 100) / 10);

			const prefix = 'https://data.inpe.br/bdc/albers';
			const files: Record<string, ArrayBuffer> = {
				// GeoKey 32767 (User-Defined) força resolução por item.properties['proj:epsg'] = 102033
				[`${prefix}/SCL.tif`]: buildUint8SclGeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32767,
					fillFn: () => 4,
				}),
				[`${prefix}/B02.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32767,
					fillFn: () => 200,
				}),
				[`${prefix}/B03.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32767,
					fillFn: () => 350,
				}),
				[`${prefix}/B04.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32767,
					fillFn: () => 300,
				}),
				[`${prefix}/B08.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32767,
					fillFn: () => 3800,
				}),
			};

			const inpeItem: StacItemRaw = {
				id: 'S2_L2A_BDC_ALBERS',
				properties: { 'proj:epsg': 102033 },
				assets: {
					B02: { href: `${prefix}/B02.tif`, 'raster:bands': [{ scale: 0.0001, nodata: 0 }] },
					B03: { href: `${prefix}/B03.tif`, 'raster:bands': [{ scale: 0.0001, nodata: 0 }] },
					B04: { href: `${prefix}/B04.tif`, 'raster:bands': [{ scale: 0.0001, nodata: 0 }] },
					B08: { href: `${prefix}/B08.tif`, 'raster:bands': [{ scale: 0.0001, nodata: 0 }] },
					SCL: { href: `${prefix}/SCL.tif` },
				},
			};

			const bands = await readCanonicalSceneBands({
				grid,
				provider: 'inpe_bdc',
				items: [inpeItem],
				safeFetchOptions: {
					lookupFn: async () => [{ address: '200.137.197.10', family: 4 }],
					fetchFn: createMockRangeFetch(files),
					maxAttempts: 1,
				},
			});

			expect(bands.radiometryAudit[0]?.tileCrs).toBe(INPE_BDC_ALBERS_CODE);
			const centerIdx = Math.floor(grid.height / 2) * grid.width + Math.floor(grid.width / 2);
			expect(bands.scl[centerIdx]).toBe(4);
			expect(bands.red[centerIdx]).toBeCloseTo(0.03, 4);
			expect(bands.nir[centerIdx]).toBeCloseTo(0.38, 4);
		});
	});

	describe('4. Classificação ΔNDVI, Trava RN-03, Transparência RN-04 e Hard Bounds', () => {
		it('deve validar presets e impor hard bounds + invariantes lógicas em customParams', () => {
			expect(resolveAndValidateAlgorithmParams('TECHNICAL_STANDARD', null).isCustomParams).toBe(false);
			expect(resolveAndValidateAlgorithmParams('CONSERVATIVE').isCustomParams).toBe(false);

			expect(() =>
				resolveAndValidateAlgorithmParams('TECHNICAL_STANDARD', {
					...ANALYSIS_PRESETS.TECHNICAL_STANDARD,
				}),
			).toThrow(DomainError);

			// Hard bound violado (minMappingUnitHa < 0.10)
			expect(() =>
				resolveAndValidateAlgorithmParams('CUSTOM', {
					...ANALYSIS_PRESETS.TECHNICAL_STANDARD,
					minMappingUnitHa: 0.05,
				}),
			).toThrow(DomainError);

			// Invariante violado (ndviForestMin <= ndviClearedMax)
			expect(() =>
				resolveAndValidateAlgorithmParams('CUSTOM', {
					...ANALYSIS_PRESETS.TECHNICAL_STANDARD,
					ndviForestMin: 0.5,
					ndviClearedMax: 0.52,
				}),
			).toThrow(DomainError);

			const customOk = resolveAndValidateAlgorithmParams('CUSTOM', {
				...ANALYSIS_PRESETS.TECHNICAL_STANDARD,
				minMappingUnitHa: 0.35,
			});
			expect(customOk.isCustomParams).toBe(true);
			expect(customOk.params.minMappingUnitHa).toBe(0.35);
		});

		it('deve classificar todas as transições (Desmatamento, Degradação, Regeneração, Estável, Nuvem) e respeitar RN-03 e RN-04', () => {
			// Grade com 10 pixels: 8 dentro da AOI (aoiMask=1) + 2 margem visual (aoiMask=0)
			const aoiMask = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
			const makeBands = (pairs: Array<[number, number, number]>) => ({
				red: new Float32Array(pairs.map((p) => p[0])),
				nir: new Float32Array(pairs.map((p) => p[1])),
				scl: new Uint8Array(pairs.map((p) => p[2])),
			});

			// Helpers para construir refletância que produz exatamente um NDVI alvo (red = 0.05 -> nir = 0.05*(1+ndvi)/(1-ndvi))
			const reflectForNdvi = (ndvi: number, scl = 4): [number, number, number] => {
				const red = 0.05;
				const nir = (red * (1 + ndvi)) / (1 - ndvi);
				return [red, nir, scl];
			};

			const t0 = makeBands([
				reflectForNdvi(0.8, 4), // 0: Floresta -> Desmatamento (0.80 -> 0.20, Δ=-0.60)
				reflectForNdvi(0.75, 4), // 1: Floresta -> Degradação (0.75 -> 0.50, Δ=-0.25)
				reflectForNdvi(0.3, 5), // 2: Solo exposto -> Regeneração (0.30 -> 0.72, Δ=+0.42)
				reflectForNdvi(0.82, 4), // 3: Floresta estável (0.82 -> 0.80)
				reflectForNdvi(0.3, 5), // 4: Solo exposto que perde NDVI (0.30 -> 0.02, Δ=-0.28) -> RN-03 trava: NÃO é desmatamento!
				reflectForNdvi(0.8, 9), // 5: Obstruído por nuvem em T0 (SCL=9) -> 255
				reflectForNdvi(0.8, 4), // 6: Obstruído por sombra de nuvem em T1 (SCL=3) -> 255
				reflectForNdvi(0.8, 4), // 7: Nuvem cirrus em T1 (SCL=10) -> 255
				reflectForNdvi(0.8, 4), // 8: Margem visual (aoiMask=0) -> ignorado
				reflectForNdvi(0.8, 4), // 9: Margem visual (aoiMask=0) -> ignorado
			]);

			const t1 = makeBands([
				reflectForNdvi(0.2, 5),
				reflectForNdvi(0.5, 4),
				reflectForNdvi(0.72, 4),
				reflectForNdvi(0.8, 4),
				reflectForNdvi(0.02, 5),
				reflectForNdvi(0.2, 5),
				reflectForNdvi(0.2, 3),
				reflectForNdvi(0.2, 10),
				reflectForNdvi(0.1, 5), // seria desmatamento, mas está fora da AOI
				reflectForNdvi(0.1, 9), // seria nuvem, mas está fora da AOI
			]);

			const res = classifyMultitemporalNdvi({
				t0,
				t1,
				aoiMask,
				algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
			});

			expect(res.classMap[0]).toBe(PIXEL_CLASS.DEFORESTATION);
			expect(res.classMap[1]).toBe(PIXEL_CLASS.DEGRADATION);
			expect(res.classMap[2]).toBe(PIXEL_CLASS.REGROWTH);
			expect(res.classMap[3]).toBe(PIXEL_CLASS.STABLE);
			expect(res.classMap[4]).toBe(PIXEL_CLASS.STABLE); // RN-03 garantido
			expect(res.classMap[5]).toBe(PIXEL_CLASS.CLOUD_OBSTRUCTED);
			expect(res.classMap[6]).toBe(PIXEL_CLASS.CLOUD_OBSTRUCTED);
			expect(res.classMap[7]).toBe(PIXEL_CLASS.CLOUD_OBSTRUCTED);
			expect(res.classMap[8]).toBe(PIXEL_CLASS.STABLE);
			expect(res.classMap[9]).toBe(PIXEL_CLASS.STABLE);

			expect(res.metrics.aoiTotalPixels).toBe(8);
			expect(res.metrics.validAnalyzedPixels).toBe(5);
			expect(res.metrics.cloudMaskedPixels).toBe(3);
			expect(res.metrics.cloudObstructionPct).toBe(37.5);
			expect(res.metrics.visibilityCompromisedWarning).toBe(false);

			// Caso com > 50% nuvem aciona selo de visibilidade comprometida (RN-04)
			const cloudyMask = new Uint8Array([1, 1, 1]);
			const cloudyRes = classifyMultitemporalNdvi({
				t0: makeBands([reflectForNdvi(0.8, 9), reflectForNdvi(0.8, 8), reflectForNdvi(0.8, 4)]),
				t1: makeBands([reflectForNdvi(0.8, 4), reflectForNdvi(0.8, 4), reflectForNdvi(0.8, 4)]),
				aoiMask: cloudyMask,
				algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
			});
			expect(cloudyRes.metrics.cloudObstructionPct).toBeCloseTo(66.67, 2);
			expect(cloudyRes.metrics.visibilityCompromisedWarning).toBe(true);
		});
	});
});
