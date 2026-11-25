import { fromCustomClient, type GeoTIFFImage, type TypedArray } from 'geotiff';
import type { StacProvider } from '../../../config/db/schema/enums.js';
import type { SafeFetchOptions } from '../../helpers/antiSsrfHttp.js';
import { INPE_BDC_ALBERS_CODE, isEquivalentUtmZone, projectCoords } from '../projRegistry.js';
import { AntiSsrfGeoTiffClient, classifySclPixel } from '../sclAnalyzer.js';
import type { StacItemRaw } from '../stacClient.js';
import { type CanonicalGrid, colToCenterE, rowToCenterN } from './canonicalGrid.js';
import {
	dnToBoaReflectance,
	type OpticalBandName,
	type RadiometricCalibration,
	resolveBandAsset,
	resolveOpticalRadiometry,
} from './radiometry.js';

export interface TileRadiometryAudit {
	itemId: string;
	tileCrs: string;
	calibrations: Record<OpticalBandName, RadiometricCalibration>;
}

export interface CanonicalSceneBands {
	blue: Float32Array;
	green: Float32Array;
	red: Float32Array;
	nir: Float32Array;
	scl: Uint8Array;
	radiometryAudit: TileRadiometryAudit[];
}

interface SampledRasterWindow {
	data: TypedArray;
	originX: number;
	originY: number;
	resX: number;
	resY: number;
	px0: number;
	py0: number;
	winWidth: number;
	winHeight: number;
	nodata: number;
}

function resolveTileCrs(image: GeoTIFFImage, item: StacItemRaw, provider: StacProvider): string {
	const geoKeys = image.getGeoKeys();
	const projected = geoKeys?.ProjectedCSTypeGeoKey;
	if (typeof projected === 'number' && projected > 1000 && projected !== 32767) {
		return `EPSG:${projected}`;
	}
	const geographic = geoKeys?.GeographicTypeGeoKey;
	if (typeof geographic === 'number' && geographic > 1000 && geographic !== 32767) {
		return `EPSG:${geographic}`;
	}
	const itemEpsg = item.properties['proj:epsg'];
	if (typeof itemEpsg === 'number' && Number.isInteger(itemEpsg) && itemEpsg > 1000) {
		return `EPSG:${itemEpsg}`;
	}
	if (provider === 'inpe_bdc') {
		return INPE_BDC_ALBERS_CODE;
	}
	return 'EPSG:4326';
}

function computeProjectedPixelWindow(
	image: GeoTIFFImage,
	utmCrs: string,
	tileCrs: string,
	sameUtm: boolean,
	boundaryPointsUtm: ReadonlyArray<[number, number]>,
): { px0: number; py0: number; px1: number; py1: number } | null {
	const imgWidth = image.getWidth();
	const imgHeight = image.getHeight();
	const origin = image.getOrigin();
	const resolution = image.getResolution();
	const originX = origin[0]!;
	const originY = origin[1]!;
	const resX = resolution[0]!;
	const resY = resolution[1]!;

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

	const rawColA = (xMin - originX) / resX;
	const rawColB = (xMax - originX) / resX;
	const rawRowA = (yMin - originY) / resY;
	const rawRowB = (yMax - originY) / resY;

	const px0 = Math.max(0, Math.floor(Math.min(rawColA, rawColB)) - 2);
	const px1 = Math.min(imgWidth, Math.ceil(Math.max(rawColA, rawColB)) + 2);
	const py0 = Math.max(0, Math.floor(Math.min(rawRowA, rawRowB)) - 2);
	const py1 = Math.min(imgHeight, Math.ceil(Math.max(rawRowA, rawRowB)) + 2);

	if (px0 >= px1 || py0 >= py1) {
		return null;
	}

	return { px0, py0, px1, py1 };
}

async function readBandWindow(params: {
	href: string;
	utmCrs: string;
	tileCrsFallback: string;
	sirgasUtmSrid: number;
	boundaryPointsUtm: ReadonlyArray<[number, number]>;
	item: StacItemRaw;
	provider: StacProvider;
	safeFetchOptions: SafeFetchOptions;
}): Promise<{ sampled: SampledRasterWindow; tileCrs: string } | null> {
	const client = new AntiSsrfGeoTiffClient(params.href, params.safeFetchOptions);
	const tiff = await fromCustomClient(client, { maxRanges: 0, allowFullFile: true });
	const image = await tiff.getImage(0);

	const tileCrs = resolveTileCrs(image, params.item, params.provider) || params.tileCrsFallback;
	const sameUtm = isEquivalentUtmZone(params.sirgasUtmSrid, tileCrs);

	const win = computeProjectedPixelWindow(
		image,
		params.utmCrs,
		tileCrs,
		sameUtm,
		params.boundaryPointsUtm,
	);
	if (!win) {
		return null;
	}

	const rasters = await image.readRasters({
		window: [win.px0, win.py0, win.px1, win.py1],
		samples: [0],
		interleave: false,
		signal: AbortSignal.timeout(25_000),
	});

	const data = rasters[0];
	if (!data) {
		return null;
	}

	const origin = image.getOrigin();
	const resolution = image.getResolution();

	return {
		tileCrs,
		sampled: {
			data,
			originX: origin[0]!,
			originY: origin[1]!,
			resX: resolution[0]!,
			resY: resolution[1]!,
			px0: win.px0,
			py0: win.py0,
			winWidth: win.px1 - win.px0,
			winHeight: win.py1 - win.py0,
			nodata: image.getGDALNoData() ?? 0,
		},
	};
}

function sampleNearestValue(win: SampledRasterWindow, tx: number, ty: number): number {
	const colInImg = Math.floor((tx - win.originX) / win.resX);
	const rowInImg = Math.floor((ty - win.originY) / win.resY);
	const localCol = colInImg - win.px0;
	const localRow = rowInImg - win.py0;

	if (localCol < 0 || localCol >= win.winWidth || localRow < 0 || localRow >= win.winHeight) {
		return Number.NaN;
	}

	return Number(win.data[localRow * win.winWidth + localCol]);
}

// Spec Parte I — Seção 2.2 e 2.3: Leitura COG via HTTP Range (4 bandas paralelas) + Mosaico Multi-Tile
export async function readCanonicalSceneBands(params: {
	grid: CanonicalGrid;
	provider: StacProvider;
	items: ReadonlyArray<StacItemRaw>;
	safeFetchOptions?: SafeFetchOptions;
}): Promise<CanonicalSceneBands> {
	const { grid, provider, items } = params;
	const safeFetchOptions: SafeFetchOptions = {
		timeoutMs: 25_000,
		...params.safeFetchOptions,
	};

	const blue = new Float32Array(grid.pixelCount).fill(Number.NaN);
	const green = new Float32Array(grid.pixelCount).fill(Number.NaN);
	const red = new Float32Array(grid.pixelCount).fill(Number.NaN);
	const nir = new Float32Array(grid.pixelCount).fill(Number.NaN);
	const scl = new Uint8Array(grid.pixelCount).fill(0);

	// Precedência de mosaico: 0 = NoData, 1 = Obstruído por nuvem/sombra, 2 = Pixel válido limpo
	const qualityRank = new Uint8Array(grid.pixelCount);
	const radiometryAudit: TileRadiometryAudit[] = [];

	const utmCrs = `EPSG:${grid.utmSrid}`;
	const eMid = (grid.e0 + grid.e1) / 2;
	const nMid = (grid.n0 + grid.n1) / 2;
	const boundaryPointsUtm: ReadonlyArray<[number, number]> = [
		[grid.e0, grid.n0],
		[grid.e1, grid.n0],
		[grid.e1, grid.n1],
		[grid.e0, grid.n1],
		[eMid, grid.n0],
		[grid.e1, nMid],
		[eMid, grid.n1],
		[grid.e0, nMid],
	];

	for (const item of items) {
		const sclAsset = resolveBandAsset(item, provider, 'SCL');
		const blueAsset = resolveBandAsset(item, provider, 'BLUE');
		const greenAsset = resolveBandAsset(item, provider, 'GREEN');
		const redAsset = resolveBandAsset(item, provider, 'RED');
		const nirAsset = resolveBandAsset(item, provider, 'NIR');

		const calibrations: Record<OpticalBandName, RadiometricCalibration> = {
			BLUE: resolveOpticalRadiometry(item, provider, 'BLUE'),
			GREEN: resolveOpticalRadiometry(item, provider, 'GREEN'),
			RED: resolveOpticalRadiometry(item, provider, 'RED'),
			NIR: resolveOpticalRadiometry(item, provider, 'NIR'),
		};

		// Lê SCL primeiro; se não intersectar a CanonicalGrid, pula as bandas ópticas
		const sclRead = await readBandWindow({
			href: sclAsset.href,
			utmCrs,
			tileCrsFallback: 'EPSG:4326',
			sirgasUtmSrid: grid.utmSrid,
			boundaryPointsUtm,
			item,
			provider,
			safeFetchOptions,
		});
		if (!sclRead) {
			continue;
		}

		// Limite de concorrência estrito: 4 bandas ópticas paralelas por job (Spec Seção 2.2)
		const [blueRead, greenRead, redRead, nirRead] = await Promise.all([
			readBandWindow({
				href: blueAsset.href,
				utmCrs,
				tileCrsFallback: sclRead.tileCrs,
				sirgasUtmSrid: grid.utmSrid,
				boundaryPointsUtm,
				item,
				provider,
				safeFetchOptions,
			}),
			readBandWindow({
				href: greenAsset.href,
				utmCrs,
				tileCrsFallback: sclRead.tileCrs,
				sirgasUtmSrid: grid.utmSrid,
				boundaryPointsUtm,
				item,
				provider,
				safeFetchOptions,
			}),
			readBandWindow({
				href: redAsset.href,
				utmCrs,
				tileCrsFallback: sclRead.tileCrs,
				sirgasUtmSrid: grid.utmSrid,
				boundaryPointsUtm,
				item,
				provider,
				safeFetchOptions,
			}),
			readBandWindow({
				href: nirAsset.href,
				utmCrs,
				tileCrsFallback: sclRead.tileCrs,
				sirgasUtmSrid: grid.utmSrid,
				boundaryPointsUtm,
				item,
				provider,
				safeFetchOptions,
			}),
		]);

		if (!blueRead || !greenRead || !redRead || !nirRead) {
			continue;
		}

		const tileCrs = redRead.tileCrs;
		const sameUtm = isEquivalentUtmZone(grid.utmSrid, tileCrs);

		radiometryAudit.push({
			itemId: item.id,
			tileCrs,
			calibrations,
		});

		const sclWin = sclRead.sampled;
		const blueWin = blueRead.sampled;
		const greenWin = greenRead.sampled;
		const redWin = redRead.sampled;
		const nirWin = nirRead.sampled;

		for (let r = 0; r < grid.height; r++) {
			const nCenter = rowToCenterN(grid, r);
			const rowOffset = r * grid.width;

			for (let c = 0; c < grid.width; c++) {
				const idx = rowOffset + c;
				if (qualityRank[idx] === 2) {
					continue;
				}

				const eCenter = colToCenterE(grid, c);
				const [tx, ty] = sameUtm
					? [eCenter, nCenter]
					: projectCoords(utmCrs, tileCrs, eCenter, nCenter);

				const rawScl = sampleNearestValue(sclWin, tx, ty);
				if (!Number.isFinite(rawScl) || rawScl === sclWin.nodata || rawScl === 0) {
					continue;
				}

				const sclClass = classifySclPixel(rawScl, sclWin.nodata);
				if (sclClass === 'nodata') {
					continue;
				}

				const rawBlue = sampleNearestValue(blueWin, tx, ty);
				const rawGreen = sampleNearestValue(greenWin, tx, ty);
				const rawRed = sampleNearestValue(redWin, tx, ty);
				const rawNir = sampleNearestValue(nirWin, tx, ty);

				const boaBlue = dnToBoaReflectance(rawBlue, calibrations.BLUE);
				const boaGreen = dnToBoaReflectance(rawGreen, calibrations.GREEN);
				const boaRed = dnToBoaReflectance(rawRed, calibrations.RED);
				const boaNir = dnToBoaReflectance(rawNir, calibrations.NIR);

				const hasValidOptical = !Number.isNaN(boaRed) && !Number.isNaN(boaNir);
				const candidateRank = sclClass === 'clean' && hasValidOptical ? 2 : 1;

				if (candidateRank > qualityRank[idx]!) {
					qualityRank[idx] = candidateRank;
					scl[idx] = Math.trunc(rawScl) & 0xff;
					blue[idx] = boaBlue;
					green[idx] = boaGreen;
					red[idx] = boaRed;
					nir[idx] = boaNir;
				}
			}
		}
	}

	return {
		blue,
		green,
		red,
		nir,
		scl,
		radiometryAudit,
	};
}
