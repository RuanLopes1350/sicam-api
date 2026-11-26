import { writeArrayBuffer } from 'geotiff';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_PRESETS } from '../src/config/presets.js';
import {
	applyMorphologicalOpeningCross3x3,
	buildAllowedDomainMask,
	classifyMultitemporalNdvi,
	computePairedCleanStretchBounds,
	createCanonicalGrid,
	dilateCross3x3,
	erodeCross3x3,
	executePostClassificationPipeline,
	extractApprovedComponents8Conn,
	GEO_CORE_ENGINE_VERSION,
	PIXEL_CLASS,
	renderCanonicalEvidenceRasters,
	runGeoCoreAnalysisPipeline,
	vectorizeAllComponents,
	vectorizeComponentToPolygons,
} from '../src/utils/geo/core/index.js';
import { projectCoords } from '../src/utils/geo/projRegistry.js';
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

function createMockRangeFetch(filesByUrl: Record<string, ArrayBuffer>): typeof globalThis.fetch {
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

function fillRect(
	buf: Uint8Array | Float32Array,
	width: number,
	c0: number,
	r0: number,
	c1: number,
	r1: number,
	value: number,
): void {
	for (let r = r0; r < r1; r++) {
		for (let c = c0; c < c1; c++) {
			buf[r * width + c] = value;
		}
	}
}

describe('Task API-07 — Motor Científico geo-core Parte 2', () => {
	describe('1. Abertura Morfológica 3x3 em Cruz (+)', () => {
		it('deve remover filetes de 1 px e ruído isolado, preservar bloco compacto e impedir invasão de nuvem/margem', () => {
			const w = 12;
			const h = 12;
			const aoiMask = new Uint8Array(w * h).fill(1);
			// Margem visual nas extremidades direita (c = 11)
			for (let r = 0; r < h; r++) {
				aoiMask[r * w + 11] = 0;
			}

			const classMap = new Uint8Array(w * h).fill(PIXEL_CLASS.DEFORESTATION);
			// Coloca nuvem no pixel (r=3, c=7) encostando no bloco compacto
			classMap[3 * w + 7] = PIXEL_CLASS.CLOUD_OBSTRUCTED;

			const allowedDomain = buildAllowedDomainMask(aoiMask, classMap);

			const bin = new Uint8Array(w * h);
			// Bloco sólido 5x5 em [2..6, 2..6] exceto nuvem em (r=3, c=7)
			fillRect(bin, w, 2, 2, 7, 7, 1);
			// Filete de 1 px (falso positivo de borda/estrada) em r=9, c=1..9
			fillRect(bin, w, 1, 9, 10, 10, 1);
			// Ruído pontual isolado 1x1 em (1, 10)
			bin[1 * w + 10] = 1;

			const eroded = erodeCross3x3(bin, w, h);
			// Apenas o miolo [3..5, 3..5] do bloco 5x5 sobrevive à erosão em cruz
			expect(eroded[4 * w + 4]).toBe(1);
			expect(eroded[9 * w + 5]).toBe(0);
			expect(eroded[1 * w + 10]).toBe(0);

			const opened = applyMorphologicalOpeningCross3x3({
				binaryMask: bin,
				width: w,
				height: h,
				allowedDomainMask: allowedDomain,
				kernelSize: 3,
			});

			// Filete de 1 px e ponto isolado foram totalmente eliminados
			for (let c = 1; c <= 9; c++) {
				expect(opened[9 * w + c]).toBe(0);
			}
			expect(opened[1 * w + 10]).toBe(0);
			// Centro do bloco foi restaurado pela dilatação
			expect(opened[4 * w + 4]).toBe(1);
			expect(opened[3 * w + 3]).toBe(1);
			// Nunca invade nuvem nem margem AOI=0
			expect(opened[3 * w + 7]).toBe(0);
			expect(opened[4 * w + 11]).toBe(0);

			// Se forçado um pixel erodido ao lado da nuvem (r=3, c=6), dilatação não sobrescreve (r=3, c=7)
			const forcedEroded = new Uint8Array(w * h);
			forcedEroded[3 * w + 6] = 1;
			forcedEroded[3 * w + 10] = 1;
			const dilated = dilateCross3x3(forcedEroded, w, h, allowedDomain);
			expect(dilated[3 * w + 7]).toBe(0);
			expect(dilated[3 * w + 11]).toBe(0);
			expect(dilated[3 * w + 5]).toBe(1);

			// kernelSize === 0 desabilita filtragem mantendo o domínio válido
			const bypass = applyMorphologicalOpeningCross3x3({
				binaryMask: bin,
				width: w,
				height: h,
				allowedDomainMask: allowedDomain,
				kernelSize: 0,
			});
			expect(bypass[9 * w + 5]).toBe(1);
			expect(bypass[1 * w + 10]).toBe(1);

			// Grade menor que 3x3 retorna erosão vazia e inconsistência lança DomainError
			expect(erodeCross3x3(new Uint8Array([1, 1, 1, 1]), 2, 2)).toEqual(new Uint8Array(4));
			expect(() => buildAllowedDomainMask(new Uint8Array(3), new Uint8Array(4))).toThrow(DomainError);
			expect(() => erodeCross3x3(new Uint8Array(3), 2, 2)).toThrow(DomainError);
		});
	});

	describe('2. Rotulagem CCL 8-Vizinhos (Union-Find) + Filtro MMU', () => {
		it('deve conectar manchas diagonais por 8-vizinhos, descartar componentes < MMU e calcular médias espectrais exatas', () => {
			const w = 20;
			const h = 20;
			const length = w * h;
			const bin = new Uint8Array(length);
			const ndviT0 = new Float32Array(length).fill(0.75);
			const ndviT1 = new Float32Array(length).fill(0.25);
			const deltaNdvi = new Float32Array(length).fill(-0.5);

			// Componente 1 (diagonal conectada): bloco 5x4 = 20 px em [1..5, 1..4] + bloco 4x3 = 12 px em [6..9, 5..7]
			// Tocam na diagonal entre (c=5, r=4) e (c=6, r=5) -> total 32 px >= 25 px (0.25 ha)
			fillRect(bin, w, 1, 1, 6, 5, 1);
			fillRect(bin, w, 6, 5, 10, 8, 1);

			// Ajuste espectral distinto na segunda sub-região para testar média exata
			for (let r = 5; r < 8; r++) {
				for (let c = 6; c < 10; c++) {
					const idx = r * w + c;
					ndviT0[idx] = 0.85;
					ndviT1[idx] = 0.15;
					deltaNdvi[idx] = -0.7;
				}
			}

			// Componente 2 (abaixo do MMU 0.25 ha): 4x4 = 16 px < 25 px
			fillRect(bin, w, 12, 12, 16, 16, 1);

			const res = extractApprovedComponents8Conn({
				binaryMask: bin,
				width: w,
				height: h,
				featureClass: 'deforestation',
				minMappingUnitHa: 0.25,
				ndviT0,
				ndviT1,
				deltaNdvi,
			});

			expect(res.minPixelsRequired).toBe(25);
			expect(res.components).toHaveLength(1);
			expect(res.discardedMmuComponents).toBe(1);
			expect(res.discardedMmuPixels).toBe(16);

			const comp = res.components[0]!;
			expect(comp.pixelCount).toBe(32);
			expect(comp.approxAreaHa).toBe(0.32);
			expect(comp.bboxPx).toEqual([1, 1, 9, 7]);
			// Média exata: (20 * 0.75 + 12 * 0.85) / 32 = 25.2 / 32 = 0.7875
			expect(comp.meanNdviT0).toBe(0.7875);
			// Média exata: (20 * 0.25 + 12 * 0.15) / 32 = 6.8 / 32 = 0.2125
			expect(comp.meanNdviT1).toBe(0.2125);
			// Média exata: (20 * -0.5 + 12 * -0.7) / 32 = -18.4 / 32 = -0.575
			expect(comp.meanDeltaNdvi).toBe(-0.575);
			// Máscara aprovada removeu o componente menor que MMU
			expect(res.approvedMask[13 * w + 13]).toBe(0);
			expect(res.approvedMask[2 * w + 2]).toBe(1);

			// Verifica proteção IEEE-754 (0.14 ha = exatos 14 px, não 15)
			const ieeeCheck = extractApprovedComponents8Conn({
				binaryMask: new Uint8Array(16).fill(1),
				width: 4,
				height: 4,
				featureClass: 'regrowth',
				minMappingUnitHa: 0.14,
				ndviT0: new Float32Array(16).fill(0.3),
				ndviT1: new Float32Array(16).fill(0.7),
				deltaNdvi: new Float32Array(16).fill(0.4),
			});
			expect(ieeeCheck.minPixelsRequired).toBe(14);
			expect(ieeeCheck.components).toHaveLength(1);
		});
	});

	describe('3. Vetorização por Contorno de Arestas (Buracos, Sela e Douglas-Peucker 5m)', () => {
		it('deve preservar anéis internos (buracos), desambiguar vértices de sela e suavizar escadinha sem perder área', () => {
			const aoi = makeUtmBoxAoiGeoJson(804000, 8594000, 804500, 8594500, 31980);
			const grid = createCanonicalGrid(aoi, 31980);
			const n = grid.pixelCount;

			const ndviT0 = new Float32Array(n).fill(0.78);
			const ndviT1 = new Float32Array(n).fill(0.22);
			const deltaNdvi = new Float32Array(n).fill(-0.56);

			// 3a) Polígono em anel ("donut"): 12x12 px (1.44 ha) com ilha interna 4x4 px (0.16 ha) -> 128 px (1.28 ha)
			const donutBin = new Uint8Array(n);
			fillRect(donutBin, grid.width, 30, 30, 42, 42, 1);
			fillRect(donutBin, grid.width, 34, 34, 38, 38, 0);

			const donutCcl = extractApprovedComponents8Conn({
				binaryMask: donutBin,
				width: grid.width,
				height: grid.height,
				featureClass: 'deforestation',
				minMappingUnitHa: 0.25,
				ndviT0,
				ndviT1,
				deltaNdvi,
			});
			expect(donutCcl.components).toHaveLength(1);
			const donutPolys = vectorizeComponentToPolygons(donutCcl.components[0]!, grid, 5.0);
			expect(donutPolys).toHaveLength(1);
			const donutPoly = donutPolys[0]!;
			expect(donutPoly.geomGeoJson.type).toBe('Polygon');
			expect(donutPoly.geomGeoJson.coordinates).toHaveLength(2); // Exterior + 1 buraco
			expect(donutPoly.approxAreaHa).toBeCloseTo(1.28, 3);
			expect(donutPoly.pixelCount).toBe(128);

			// Anel exterior e buraco devem estar fechados em EPSG:4674
			const extRing = donutPoly.geomGeoJson.coordinates[0]!;
			const holeRing = donutPoly.geomGeoJson.coordinates[1]!;
			expect(extRing[0]).toEqual(extRing[extRing.length - 1]);
			expect(holeRing[0]).toEqual(holeRing[holeRing.length - 1]);

			// Ponto representativo interno deve cair FORA do buraco [34..38, 34..38]
			const [repE, repN] = donutPoly.representativePointUtm;
			const holeMinE = grid.e0 + 34 * 10;
			const holeMaxE = grid.e0 + 38 * 10;
			const holeMinN = grid.n1 - 38 * 10;
			const holeMaxN = grid.n1 - 34 * 10;
			const insideHole = repE > holeMinE && repE < holeMaxE && repN > holeMinN && repN < holeMaxN;
			expect(insideHole).toBe(false);

			// 3b) Vértice de sela: dois blocos 5x5 tocando apenas na quina (c=35, r=35)
			const saddleBin = new Uint8Array(n);
			fillRect(saddleBin, grid.width, 30, 30, 35, 35, 1);
			fillRect(saddleBin, grid.width, 35, 35, 40, 40, 1);

			const saddleCcl = extractApprovedComponents8Conn({
				binaryMask: saddleBin,
				width: grid.width,
				height: grid.height,
				featureClass: 'degradation',
				minMappingUnitHa: 0.25,
				ndviT0,
				ndviT1,
				deltaNdvi,
			});
			expect(saddleCcl.components).toHaveLength(1);
			const saddlePolys = vectorizeComponentToPolygons(saddleCcl.components[0]!, grid, 5.0);
			// Curva mais fechada à direita separa o vértice de sela em 2 polígonos simples de 0.25 ha cada
			expect(saddlePolys).toHaveLength(2);
			expect(saddlePolys[0]!.approxAreaHa).toBeCloseTo(0.25, 3);
			expect(saddlePolys[1]!.approxAreaHa).toBeCloseTo(0.25, 3);
			expect(saddlePolys[0]!.pixelCount + saddlePolys[1]!.pixelCount).toBe(50);

			// 3c) Eliminação de escadinha via Douglas-Peucker 5.0 m em disco/losango diagonal
			const staircaseBin = new Uint8Array(n);
			const cx = 50;
			const cy = 50;
			let diagCount = 0;
			for (let r = 38; r <= 62; r++) {
				for (let c = 38; c <= 62; c++) {
					// Losango diagonal girado a 45° gera dezenas de degraus "escadinha"
					if (Math.abs(r - cy) + Math.abs(c - cx) <= 10) {
						staircaseBin[r * grid.width + c] = 1;
						diagCount++;
					}
				}
			}

			const staircaseCcl = extractApprovedComponents8Conn({
				binaryMask: staircaseBin,
				width: grid.width,
				height: grid.height,
				featureClass: 'regrowth',
				minMappingUnitHa: 0.25,
				ndviT0,
				ndviT1,
				deltaNdvi,
			});

			const rawPoly = vectorizeComponentToPolygons(staircaseCcl.components[0]!, grid, 0)[0]!;
			const dpPoly = vectorizeComponentToPolygons(staircaseCcl.components[0]!, grid, 5.0)[0]!;

			expect(dpPoly.ringsUtm[0]!.length).toBeLessThan(rawPoly.ringsUtm[0]!.length);
			const exactHa = diagCount * 0.01;
			const areaDiffPct = (Math.abs(dpPoly.approxAreaHa - exactHa) / exactHa) * 100;
			expect(areaDiffPct).toBeLessThan(2.5);

			// Ordenação decrescente por área no vectorizeAllComponents
			const sorted = vectorizeAllComponents(
				[...saddleCcl.components, ...donutCcl.components, ...staircaseCcl.components],
				grid,
				5.0,
			);
			expect(sorted.length).toBe(4);
			for (let i = 1; i < sorted.length; i++) {
				expect(sorted[i - 1]!.approxAreaHa).toBeGreaterThanOrEqual(sorted[i]!.approxAreaHa);
			}
		});
	});

	describe('4. Renderização PNG Lossless via sharp (P2-P98 Pareado e Máscara RGBA)', () => {
		it('deve ignorar nuvens no stretch P2-P98, aplicar fallback e codificar os 5 PNGs com cores exatas', async () => {
			const aoi = makeUtmBoxAoiGeoJson(804000, 8594000, 804100, 8594100, 31980);
			const grid = createCanonicalGrid(aoi, 31980);
			const n = grid.pixelCount;

			const makeScene = (baseRed: number, cloudOffset: number) => {
				const blue = new Float32Array(n);
				const green = new Float32Array(n);
				const red = new Float32Array(n);
				const nir = new Float32Array(n);
				const scl = new Uint8Array(n).fill(4);

				for (let i = 0; i < n; i++) {
					const grad = (i % grid.width) / grid.width;
					blue[i] = 0.02 + 0.04 * grad;
					green[i] = 0.03 + 0.05 * grad;
					red[i] = baseRed + 0.06 * grad;
					nir[i] = 0.25 + 0.15 * grad;

					// 25% de nuvens muito brilhantes (0.98) que NÃO devem puxar P98 para cima
					if (i % 4 === cloudOffset) {
						scl[i] = 9;
						blue[i] = 0.95;
						green[i] = 0.96;
						red[i] = 0.98;
						nir[i] = 0.99;
					}
				}
				// Marca alguns pixels como NoData (scl = 0)
				scl[0] = 0;
				scl[1] = 0;
				return { blue, green, red, nir, scl };
			};

			const t0 = makeScene(0.02, 0);
			const t1 = makeScene(0.03, 1);

			const stretchRed = computePairedCleanStretchBounds(t0.red, t0.scl, t1.red, t1.scl, [0.01, 0.22]);
			expect(stretchRed.usedFallback).toBe(false);
			expect(stretchRed.p98).toBeLessThan(0.15);

			// Fallback com poucos pixels limpos
			const tinyFallback = computePairedCleanStretchBounds(
				new Float32Array(5).fill(0.1),
				new Uint8Array(5).fill(4),
				new Float32Array(5).fill(0.1),
				new Uint8Array(5).fill(9),
				[0.01, 0.22],
			);
			expect(tinyFallback.usedFallback).toBe(true);
			expect(tinyFallback.p2).toBe(0.01);
			expect(tinyFallback.p98).toBe(0.22);

			const filteredClassMap = new Uint8Array(n);
			filteredClassMap[10] = PIXEL_CLASS.DEFORESTATION;
			filteredClassMap[11] = PIXEL_CLASS.DEGRADATION;
			filteredClassMap[12] = PIXEL_CLASS.REGROWTH;
			filteredClassMap[13] = PIXEL_CLASS.CLOUD_OBSTRUCTED;
			filteredClassMap[14] = PIXEL_CLASS.STABLE;

			const rendered = await renderCanonicalEvidenceRasters({
				grid,
				t0,
				t1,
				filteredClassMap,
			});

			for (const assetType of [
				't0_rgb',
				't1_rgb',
				't0_false_color',
				't1_false_color',
				'delta_ndvi_mask',
			] as const) {
				const asset = rendered.rasters[assetType];
				expect(asset.mimeType).toBe('image/png');
				expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
				expect(asset.widthPx).toBe(grid.width);
				expect(asset.heightPx).toBe(grid.height);
				expect(asset.bounds4674).toEqual(grid.bounds4674);

				const meta = await sharp(asset.buffer).metadata();
				expect(meta.format).toBe('png');
				expect(meta.width).toBe(grid.width);
				expect(meta.height).toBe(grid.height);
				expect(meta.channels).toBe(4);
			}

			// Verifica cores RGBA exatas no PNG da máscara delta_ndvi_mask
			const { data: rawMask } = await sharp(rendered.rasters.delta_ndvi_mask.buffer)
				.raw()
				.toBuffer({ resolveWithObject: true });

			const pixelAt = (idx: number) => [
				rawMask[idx * 4],
				rawMask[idx * 4 + 1],
				rawMask[idx * 4 + 2],
				rawMask[idx * 4 + 3],
			];
			expect(pixelAt(10)).toEqual([229, 57, 53, 165]); // #E53935
			expect(pixelAt(11)).toEqual([251, 140, 0, 150]); // #FB8C00
			expect(pixelAt(12)).toEqual([0, 230, 118, 150]); // #00E676
			expect(pixelAt(13)).toEqual([158, 158, 158, 95]); // #9E9E9E
			expect(pixelAt(14)).toEqual([0, 0, 0, 0]); // transparente

			// Pixel NoData em T0 RGB deve permanecer transparente (alpha = 0)
			const { data: rawT0Rgb } = await sharp(rendered.rasters.t0_rgb.buffer)
				.raw()
				.toBuffer({ resolveWithObject: true });
			expect(rawT0Rgb[3]).toBe(0);
		});
	});

	describe('5. Orquestrador Completo runGeoCoreAnalysisPipeline (Parte 1 + Parte 2)', () => {
		it('deve executar ponta a ponta de COGs sintéticos até feições vetorizadas e 5 PNGs', async () => {
			// AOI 500m x 500m = 25 ha em Rondônia
			const aoi = makeUtmBoxAoiGeoJson(804000, 8594000, 804500, 8594500, 31980);
			const grid = createCanonicalGrid(aoi, 31980);

			const originX = grid.e0;
			const originY = grid.n1;
			const w = grid.width;
			const h = grid.height;

			// Coordenadas em pixels da CanonicalGrid dentro da AOI [25..74, 25..74]
			const colMinAoi = Math.round((804000 - grid.e0) / 10);
			const rowMinAoi = Math.round((grid.n1 - 8594500) / 10);

			const isInside = (c: number, r: number, c0: number, r0: number, c1: number, r1: number) =>
				c >= c0 && c < c1 && r >= r0 && r < r1;

			// Zona 1: Desmatamento donut 12x12 (1.44 ha) com ilha florestal 4x4 (0.16 ha) -> 1.28 ha
			const inDefDonut = (c: number, r: number) =>
				isInside(c, r, colMinAoi + 2, rowMinAoi + 2, colMinAoi + 14, rowMinAoi + 14) &&
				!isInside(c, r, colMinAoi + 6, rowMinAoi + 6, colMinAoi + 10, rowMinAoi + 10);

			// Zona 2: Filete 1px x 15px (eliminado pela abertura 3x3 em cruz)
			const inThinNoise = (c: number, r: number) =>
				r === rowMinAoi + 20 && c >= colMinAoi + 2 && c < colMinAoi + 17;

			// Zona 3: Mancha 3x4 = 12 px (0.12 ha < MMU 0.25 ha -> descartada pelo CCL)
			const inSmallPatch = (c: number, r: number) =>
				isInside(c, r, colMinAoi + 20, rowMinAoi + 2, colMinAoi + 23, rowMinAoi + 6);

			// Zona 4: Degradação 6x6 = 36 px (0.36 ha)
			const inDegradation = (c: number, r: number) =>
				isInside(c, r, colMinAoi + 25, rowMinAoi + 10, colMinAoi + 31, rowMinAoi + 16);

			// Zona 5: Regeneração 7x5 = 35 px (0.35 ha)
			const inRegrowth = (c: number, r: number) =>
				isInside(c, r, colMinAoi + 3, rowMinAoi + 25, colMinAoi + 10, rowMinAoi + 30);

			// Zona 6: Nuvem em T1 4x4 = 16 px
			const inCloudT1 = (c: number, r: number) =>
				isInside(c, r, colMinAoi + 35, rowMinAoi + 35, colMinAoi + 39, rowMinAoi + 39);

			// Baseline 04+ (offset -0.1, scale 0.0001): ρ = 0.03 -> DN 1300; ρ = 0.36 -> DN 4600 (NDVI ≈ 0.846 floresta)
			// Solo exposto: ρ_red = 0.24 -> DN 3400; ρ_nir = 0.28 -> DN 3800 (NDVI ≈ 0.077)
			// Degradada: ρ_red = 0.08 -> DN 1800; ρ_nir = 0.20 -> DN 3000 (NDVI ≈ 0.429 -> Δ = -0.417, > 0.42)
			const t0Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/pipe_t0';
			const t1Prefix = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/pipe_t1';

			const files: Record<string, ArrayBuffer> = {
				[`${t0Prefix}/scl.tif`]: buildUint8SclGeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: () => 4,
				}),
				[`${t0Prefix}/b02.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: () => 1250,
				}),
				[`${t0Prefix}/b03.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: () => 1400,
				}),
				[`${t0Prefix}/b04.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: (c, r) => (inRegrowth(c, r) ? 3400 : 1300),
				}),
				[`${t0Prefix}/b08.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: (c, r) => (inRegrowth(c, r) ? 3800 : 4600),
				}),

				[`${t1Prefix}/scl.tif`]: buildUint8SclGeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: (c, r) => (inCloudT1(c, r) ? 9 : 4),
				}),
				[`${t1Prefix}/b02.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: () => 1350,
				}),
				[`${t1Prefix}/b03.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: () => 1500,
				}),
				[`${t1Prefix}/b04.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: (c, r) => {
						if (inDefDonut(c, r) || inThinNoise(c, r) || inSmallPatch(c, r)) return 3400;
						if (inDegradation(c, r)) return 1800;
						return 1300;
					},
				}),
				[`${t1Prefix}/b08.tif`]: buildUint16GeoTiff({
					originX,
					originY,
					pixelSize: 10,
					width: w,
					height: h,
					projectedEpsg: 32720,
					fillFn: (c, r) => {
						if (inDefDonut(c, r) || inThinNoise(c, r) || inSmallPatch(c, r)) return 3800;
						if (inDegradation(c, r)) return 3000;
						return 4600;
					},
				}),
			};

			const buildItem = (id: string, prefix: string): StacItemRaw => ({
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

			const stages: string[] = [];
			const result = await runGeoCoreAnalysisPipeline({
				aoiGeoJson: aoi,
				utmSrid: 31980,
				t0Provider: 'aws_earth_search',
				t0Items: [buildItem('T0_PIPE', t0Prefix)],
				t1Provider: 'aws_earth_search',
				t1Items: [buildItem('T1_PIPE', t1Prefix)],
				algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
				safeFetchOptions: {
					lookupFn: async () => [{ address: '52.218.10.20', family: 4 }],
					fetchFn: createMockRangeFetch(files),
					maxAttempts: 1,
				},
				onStage: (stage) => {
					stages.push(stage);
				},
			});

			expect(result.engineVersion).toBe(GEO_CORE_ENGINE_VERSION);
			expect(stages).toEqual(['fetching_bands', 'processing_ndvi', 'vectorizing']);

			const post = result.postClassification;
			expect(result.rawClassification.metrics.deforestationPixels).toBe(155); // 128 donut + 15 filete + 12 pequeno
			expect(post.filteredMetrics.aoiTotalPixels).toBe(2500);
			expect(post.filteredMetrics.cloudMaskedPixels).toBe(16);
			// Abertura em cruz 3x3 elimina filete 1px (15), MMU descarta mancha 3x4 (12) e chanfra apenas os 4 cantos externos do donut (128 - 4 = 124)
			expect(post.filteredMetrics.deforestationPixels).toBe(124);
			expect(post.filteredMetrics.degradationPixels).toBe(32); // 6x6 - 4 cantos
			expect(post.filteredMetrics.regrowthPixels).toBe(31); // 7x5 - 4 cantos

			expect(post.features).toHaveLength(3);
			expect(post.features[0]!.featureClass).toBe('deforestation');
			expect(post.features[0]!.geomGeoJson.coordinates).toHaveLength(2);
			expect(post.features[0]!.approxAreaHa).toBeCloseTo(1.24, 3);
			expect(post.features[1]!.featureClass).toBe('degradation');
			expect(post.features[1]!.approxAreaHa).toBeCloseTo(0.32, 3);
			expect(post.features[2]!.featureClass).toBe('regrowth');
			expect(post.features[2]!.approxAreaHa).toBeCloseTo(0.31, 3);

			// Também testa execução direta isolada de executePostClassificationPipeline com erro de validação interna
			await expect(
				executePostClassificationPipeline({
					grid: result.grid,
					aoiMask: new Uint8Array(4),
					t0: result.t0,
					t1: result.t1,
					rawClassification: result.rawClassification,
					algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
				}),
			).rejects.toThrow(DomainError);
		});
	});
});
