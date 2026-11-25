import { BaseClient, BaseResponse, fromCustomClient, type GeoTIFFImage } from 'geotiff';
import { safeExternalFetch, type SafeFetchOptions } from '../helpers/antiSsrfHttp.js';
import type { AoiPolygonGeoJson } from '../validation/caseValidation.js';
import {
	ensureProjDefinitions,
	INPE_BDC_ALBERS_CODE,
	isEquivalentUtmZone,
	projectCoords,
} from './projRegistry.js';

class FetchBackedGeoTiffResponse extends BaseResponse {
	private readonly res: Response;

	constructor(res: Response) {
		super();
		this.res = res;
	}

	override get ok(): boolean {
		return this.res.ok;
	}

	override get status(): number {
		return this.res.status;
	}

	override getHeader(headerName: string): string | undefined {
		return this.res.headers.get(headerName) ?? undefined;
	}

	override async getData(): Promise<ArrayBuffer> {
		return this.res.arrayBuffer();
	}
}

// Cliente geotiff.js blindado que passa 100% dos Range requests pela camada Anti-SSRF
export class AntiSsrfGeoTiffClient extends BaseClient {
	private readonly safeOptions: SafeFetchOptions;

	constructor(url: string, safeOptions: SafeFetchOptions = {}) {
		super(url);
		this.safeOptions = safeOptions;
	}

	override async request(options: RequestInit = {}): Promise<BaseResponse> {
		const response = await safeExternalFetch(this.url, options, this.safeOptions);
		return new FetchBackedGeoTiffResponse(response);
	}
}

export interface MetricGridSpec {
	e0: number;
	n0: number;
	e1: number;
	n1: number;
	width: number;
	height: number;
	cellSizeM: number;
	utmSrid: number;
}

// Spec Seção 4.1: Rasterização exata de polígono via Scanline Polygon Fill
export function rasterizePolygonScanline(
	ringUtm: ReadonlyArray<[number, number]>,
	grid: MetricGridSpec,
): Uint8Array {
	const { e0, n1, width, height, cellSizeM } = grid;
	const mask = new Uint8Array(width * height);

	if (ringUtm.length < 4) {
		return mask;
	}

	const polyCols = new Float64Array(ringUtm.length);
	const polyRows = new Float64Array(ringUtm.length);
	for (let i = 0; i < ringUtm.length; i++) {
		const [e, n] = ringUtm[i]!;
		polyCols[i] = (e - e0) / cellSizeM;
		polyRows[i] = (n1 - n) / cellSizeM;
	}

	const intersections: number[] = [];
	const edgeCount = ringUtm.length - 1;

	for (let r = 0; r < height; r++) {
		const scanY = r + 0.5;
		intersections.length = 0;

		for (let i = 0; i < edgeCount; i++) {
			const x1 = polyCols[i]!;
			const y1 = polyRows[i]!;
			const x2 = polyCols[i + 1]!;
			const y2 = polyRows[i + 1]!;

			if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
				const t = (scanY - y1) / (y2 - y1);
				intersections.push(x1 + t * (x2 - x1));
			}
		}

		intersections.sort((a, b) => a - b);

		const rowOffset = r * width;
		for (let k = 0; k + 1 < intersections.length; k += 2) {
			const cStart = Math.max(0, Math.ceil(intersections[k]! - 0.5));
			const cEnd = Math.min(width - 1, Math.floor(intersections[k + 1]! - 0.5));
			for (let c = cStart; c <= cEnd; c++) {
				mask[rowOffset + c] = 1;
			}
		}
	}

	return mask;
}

// Spec Seção 4.2: Classificação oficial dos códigos ESA da banda SCL
export function classifySclPixel(sclValue: number, nodataValue = 0): 'nodata' | 'clean' | 'cloud' {
	if (!Number.isFinite(sclValue) || sclValue === nodataValue || sclValue === 0) {
		return 'nodata';
	}
	// 2 = Dark/Topo Shadow, 4 = Vegetation, 5 = Bare Soil, 6 = Water, 7 = Unclassified -> Válidos
	if (sclValue === 2 || sclValue === 4 || sclValue === 5 || sclValue === 6 || sclValue === 7) {
		return 'clean';
	}
	// 1 = Saturated/Defective, 3 = Cloud Shadow, 8 = Cloud Medium, 9 = Cloud High, 10 = Cirrus, 11 = Snow
	return 'cloud';
}

function resolveTileCrs(image: GeoTIFFImage, fallbackEpsg?: number | null, isInpeBdc?: boolean): string {
	const geoKeys = image.getGeoKeys();
	const projected = geoKeys?.ProjectedCSTypeGeoKey;
	if (typeof projected === 'number' && projected > 1000 && projected !== 32767) {
		return `EPSG:${projected}`;
	}
	const geographic = geoKeys?.GeographicTypeGeoKey;
	if (typeof geographic === 'number' && geographic > 1000 && geographic !== 32767) {
		return `EPSG:${geographic}`;
	}
	if (fallbackEpsg && fallbackEpsg > 1000) {
		return `EPSG:${fallbackEpsg}`;
	}
	if (isInpeBdc) {
		return INPE_BDC_ALBERS_CODE;
	}
	return 'EPSG:4326';
}

export interface SclTileInput {
	href: string;
	projEpsg?: number | null;
	isInpeBdc?: boolean;
}

export interface AoiSclEvaluationResult {
	aoiCloudPct: number;
	aoiCoveragePct: number;
}

// RF-12 & Spec Seção 2.3: Lê apenas a janela recortada da banda SCL via HTTP Range e calcula % nuvem real na AOI
export async function computeAoiSclMetrics(params: {
	aoiGeoJson: AoiPolygonGeoJson;
	utmSrid: number;
	sclTiles: ReadonlyArray<SclTileInput>;
	safeFetchOptions?: SafeFetchOptions;
}): Promise<AoiSclEvaluationResult> {
	ensureProjDefinitions();

	const ring4674 = params.aoiGeoJson.coordinates[0];
	if (!ring4674 || ring4674.length < 4 || params.sclTiles.length === 0) {
		return { aoiCloudPct: 100, aoiCoveragePct: 0 };
	}

	const utmCrs = `EPSG:${params.utmSrid}`;
	let eMin = Number.POSITIVE_INFINITY;
	let nMin = Number.POSITIVE_INFINITY;
	let eMax = Number.NEGATIVE_INFINITY;
	let nMax = Number.NEGATIVE_INFINITY;

	const ringUtm: [number, number][] = [];
	for (const [lon, lat] of ring4674) {
		const [e, n] = projectCoords('EPSG:4674', utmCrs, lon, lat);
		ringUtm.push([e, n]);
		if (e < eMin) eMin = e;
		if (n < nMin) nMin = n;
		if (e > eMax) eMax = e;
		if (n > nMax) nMax = n;
	}

	const spanMax = Math.max(eMax - eMin, nMax - nMin, 20);
	// Banda SCL tem resolução nativa de 20m; em AOIs grandes limitamos a grade de busca a ~240x240 para resposta rápida
	const cellSizeM = Math.max(20, Math.ceil(spanMax / 240 / 20) * 20);

	const e0 = Math.floor(eMin / cellSizeM) * cellSizeM;
	const e1 = Math.ceil(eMax / cellSizeM) * cellSizeM;
	const n0 = Math.floor(nMin / cellSizeM) * cellSizeM;
	const n1 = Math.ceil(nMax / cellSizeM) * cellSizeM;

	const width = Math.max(1, Math.round((e1 - e0) / cellSizeM));
	const height = Math.max(1, Math.round((n1 - n0) / cellSizeM));

	const grid: MetricGridSpec = {
		e0,
		n0,
		e1,
		n1,
		width,
		height,
		cellSizeM,
		utmSrid: params.utmSrid,
	};

	const aoiMask = rasterizePolygonScanline(ringUtm, grid);
	let totalAoiPixels = 0;
	for (let i = 0; i < aoiMask.length; i++) {
		if (aoiMask[i] === 1) totalAoiPixels++;
	}

	// Para quadrantes muito pequenos onde nenhum centro de célula de 20m caiu dentro do polígono, avalia o centroide
	if (totalAoiPixels === 0) {
		aoiMask[Math.floor(height / 2) * width + Math.floor(width / 2)] = 1;
		totalAoiPixels = 1;
	}

	// Estado por pixel na AOI: 0 = NoData, 1 = Cloud/Obstructed, 2 = Clean Valid
	const mergedState = new Uint8Array(width * height);

	// 4 cantos + 4 pontos médios das arestas (Spec Seção 2.3 — curvatura em Albers)
	const eMid = (e0 + e1) / 2;
	const nMid = (n0 + n1) / 2;
	const boundaryPointsUtm: ReadonlyArray<[number, number]> = [
		[e0, n0],
		[e1, n0],
		[e1, n1],
		[e0, n1],
		[eMid, n0],
		[e1, nMid],
		[eMid, n1],
		[e0, nMid],
	];

	for (const tile of params.sclTiles) {
		const client = new AntiSsrfGeoTiffClient(tile.href, params.safeFetchOptions);
		const tiff = await fromCustomClient(client, { maxRanges: 0, allowFullFile: true });
		const image = await tiff.getImage(0);

		const imgWidth = image.getWidth();
		const imgHeight = image.getHeight();
		const origin = image.getOrigin();
		const resolution = image.getResolution();
		const originX = origin[0]!;
		const originY = origin[1]!;
		const resX = resolution[0]!; // positivo (Leste)
		const resY = resolution[1]!; // negativo em GeoTIFF Norte-para- cima (ex: -20)
		const nodataVal = image.getGDALNoData() ?? 0;

		const tileCrs = resolveTileCrs(image, tile.projEpsg, tile.isInpeBdc);
		const sameUtm = isEquivalentUtmZone(params.utmSrid, tileCrs);

		let xMin = Number.POSITIVE_INFINITY;
		let yMin = Number.POSITIVE_INFINITY;
		let xMax = Number.NEGATIVE_INFINITY;
		let yMax = Number.NEGATIVE_INFINITY;

		for (const [pe, pn] of boundaryPointsUtm) {
			const [tx, ty] = sameUtm ? [pe, pn] : projectCoords(utmCrs, tileCrs, pe, pn);
			if (tx < xMin) xMin = tx;
			if (ty < yMin) yMin = ty;
			if (tx > xMax) xMax = tx;
			if (ty > yMax) yMax = ty;
		}

		// Converte bbox projetada para janela de pixels com margem de 2px
		const rawColA = (xMin - originX) / resX;
		const rawColB = (xMax - originX) / resX;
		const rawRowA = (yMin - originY) / resY;
		const rawRowB = (yMax - originY) / resY;

		const px0 = Math.max(0, Math.floor(Math.min(rawColA, rawColB)) - 2);
		const px1 = Math.min(imgWidth, Math.ceil(Math.max(rawColA, rawColB)) + 2);
		const py0 = Math.max(0, Math.floor(Math.min(rawRowA, rawRowB)) - 2);
		const py1 = Math.min(imgHeight, Math.ceil(Math.max(rawRowA, rawRowB)) + 2);

		if (px0 >= px1 || py0 >= py1) {
			continue;
		}

		const rasters = await image.readRasters({
			window: [px0, py0, px1, py1],
			samples: [0],
			interleave: false,
		});

		const band = rasters[0];
		if (!band) continue;
		const winWidth = px1 - px0;
		const winHeight = py1 - py0;

		for (let r = 0; r < height; r++) {
			const nCenter = n1 - (r + 0.5) * cellSizeM;
			const rowBase = r * width;

			for (let c = 0; c < width; c++) {
				const idx = rowBase + c;
				if (aoiMask[idx] !== 1) continue;
				// Se já temos pixel limpo (2) de outro tile na faixa de sobreposição, preserva-o (Spec 2.3)
				if (mergedState[idx] === 2) continue;

				const eCenter = e0 + (c + 0.5) * cellSizeM;
				const [tx, ty] = sameUtm
					? [eCenter, nCenter]
					: projectCoords(utmCrs, tileCrs, eCenter, nCenter);

				const colInImg = Math.floor((tx - originX) / resX);
				const rowInImg = Math.floor((ty - originY) / resY);
				const localCol = colInImg - px0;
				const localRow = rowInImg - py0;

				if (localCol < 0 || localCol >= winWidth || localRow < 0 || localRow >= winHeight) {
					continue;
				}

				const rawVal = Number(band[localRow * winWidth + localCol]);
				const cls = classifySclPixel(rawVal, nodataVal);
				if (cls === 'clean') {
					mergedState[idx] = 2;
				} else if (cls === 'cloud' && mergedState[idx] === 0) {
					mergedState[idx] = 1;
				}
			}
		}
	}

	let cleanPixels = 0;
	let cloudPixels = 0;
	for (let i = 0; i < aoiMask.length; i++) {
		if (aoiMask[i] !== 1) continue;
		if (mergedState[i] === 2) cleanPixels++;
		else if (mergedState[i] === 1) cloudPixels++;
	}

	const coveredPixels = cleanPixels + cloudPixels;
	const aoiCoveragePct = Math.min(100, Number(((coveredPixels / totalAoiPixels) * 100).toFixed(2)));
	const aoiCloudPct =
		coveredPixels > 0 ? Math.min(100, Number(((cloudPixels / coveredPixels) * 100).toFixed(2))) : 100;

	return {
		aoiCloudPct,
		aoiCoveragePct,
	};
}
