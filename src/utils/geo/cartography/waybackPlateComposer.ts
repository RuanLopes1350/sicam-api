import sharp from 'sharp';
import { WAYBACK_WHITELISTED_HOSTS } from '../../../config/presets.js';
import { safeExternalFetch, type SafeFetchOptions } from '../../helpers/antiSsrfHttp.js';
import { projectCoords } from '../projRegistry.js';
import {
	buildWaybackTileUrl,
	lonLatToWebMercatorPixel,
	lonLatToWebMercatorTile,
	runWithConcurrency,
} from '../waybackClient.js';

const CONTROL_GRID_DIVS = 16;
const CONTROL_GRID_STEPS = CONTROL_GRID_DIVS + 1;

function sampleBilinearChannel(
	mosaic: Uint8Array,
	mosaicW: number,
	mosaicH: number,
	fx: number,
	fy: number,
	channelOffset: number,
): number {
	const x0 = Math.max(0, Math.min(mosaicW - 1, Math.floor(fx)));
	const y0 = Math.max(0, Math.min(mosaicH - 1, Math.floor(fy)));
	const x1 = Math.min(mosaicW - 1, x0 + 1);
	const y1 = Math.min(mosaicH - 1, y0 + 1);
	const wx = fx - x0;
	const wy = fy - y0;

	const i00 = (y0 * mosaicW + x0) * 4 + channelOffset;
	const i10 = (y0 * mosaicW + x1) * 4 + channelOffset;
	const i01 = (y1 * mosaicW + x0) * 4 + channelOffset;
	const i11 = (y1 * mosaicW + x1) * 4 + channelOffset;

	const top = mosaic[i00]! * (1 - wx) + mosaic[i10]! * wx;
	const bottom = mosaic[i01]! * (1 - wx) + mosaic[i11]! * wx;
	return Math.round(top * (1 - wy) + bottom * wy);
}

/**
 * Monta recorte 300 DPI reprojetado de Web Mercator (tiles Esri Wayback ~0,3m–1m)
 * diretamente para a janela exata em UTM SIRGAS 2000 com interpolação bilinear de malha 17x17,
 * garantindo encaixe milimétrico com a grade UTM e os polígonos PostGIS no PDF offline.
 */
export async function composeWaybackUtmFramePngDataUri(params: {
	releaseNum: number;
	maxZoom: number;
	utmSrid: number;
	mapBboxUtm: [number, number, number, number];
	targetWidthPx: number;
	targetHeightPx: number;
	safeFetchOptions?: SafeFetchOptions;
}): Promise<string> {
	const { releaseNum, maxZoom, utmSrid, mapBboxUtm, targetWidthPx, targetHeightPx, safeFetchOptions } =
		params;
	const [e0, n0, e1, n1] = mapBboxUtm;
	const utmCrs = `EPSG:${utmSrid}`;

	const sampleUtmPoints: Array<[number, number]> = [
		[e0, n0],
		[(e0 + e1) / 2, n0],
		[e1, n0],
		[e1, (n0 + n1) / 2],
		[e1, n1],
		[(e0 + e1) / 2, n1],
		[e0, n1],
		[e0, (n0 + n1) / 2],
	];

	let minLon = Number.POSITIVE_INFINITY;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;

	for (const [e, n] of sampleUtmPoints) {
		const [lon, lat] = projectCoords(utmCrs, 'EPSG:4674', e, n);
		if (lon < minLon) minLon = lon;
		if (lat < minLat) minLat = lat;
		if (lon > maxLon) maxLon = lon;
		if (lat > maxLat) maxLat = lat;
	}

	const clampedMaxZoom = Math.max(10, Math.min(18, Math.trunc(maxZoom)));
	let chosenZ = 10;
	let txMin = 0;
	let txMax = 0;
	let tyMin = 0;
	let tyMax = 0;

	for (let z = clampedMaxZoom; z >= 10; z--) {
		const nw = lonLatToWebMercatorTile(minLon, maxLat, z);
		const se = lonLatToWebMercatorTile(maxLon, minLat, z);
		const cols = se.tx - nw.tx + 1;
		const rows = se.ty - nw.ty + 1;
		chosenZ = z;
		txMin = nw.tx;
		txMax = se.tx;
		tyMin = nw.ty;
		tyMax = se.ty;
		if (cols * rows <= 36) {
			break;
		}
	}

	const cols = txMax - txMin + 1;
	const rows = tyMax - tyMin + 1;
	const mosaicW = cols * 256;
	const mosaicH = rows * 256;
	const mosaic = new Uint8Array(mosaicW * mosaicH * 4);

	const tileList: Array<{ tx: number; ty: number }> = [];
	for (let ty = tyMin; ty <= tyMax; ty++) {
		for (let tx = txMin; tx <= txMax; tx++) {
			tileList.push({ tx, ty });
		}
	}

	await runWithConcurrency(tileList, 8, async ({ tx, ty }) => {
		const tileUrl = buildWaybackTileUrl(releaseNum, chosenZ, ty, tx);
		const response = await safeExternalFetch(
			tileUrl,
			{ method: 'GET' },
			{
				timeoutMs: 12_000,
				maxAttempts: 2,
				...safeFetchOptions,
				allowedHosts: WAYBACK_WHITELISTED_HOSTS,
			},
		);
		if (!response.ok) {
			throw new Error(`Tile Wayback indisponível (${tileUrl}: HTTP ${response.status}).`);
		}

		const tileBytes = Buffer.from(await response.arrayBuffer());
		const { data } = await sharp(tileBytes)
			.resize(256, 256, { fit: 'fill' })
			.ensureAlpha(1)
			.raw()
			.toBuffer({ resolveWithObject: true });

		const dstOriginX = (tx - txMin) * 256;
		const dstOriginY = (ty - tyMin) * 256;
		const rowBytes = 256 * 4;

		for (let row = 0; row < 256; row++) {
			const srcStart = row * rowBytes;
			const dstStart = ((dstOriginY + row) * mosaicW + dstOriginX) * 4;
			mosaic.set(data.subarray(srcStart, srcStart + rowBytes), dstStart);
		}
	});

	// Malha 17x17 UTM -> pixel contínuo no mosaico Web Mercator para corrigir convergência meridiana
	const gridPxX = new Float64Array(CONTROL_GRID_STEPS * CONTROL_GRID_STEPS);
	const gridPxY = new Float64Array(CONTROL_GRID_STEPS * CONTROL_GRID_STEPS);
	const originMosaicX = txMin * 256;
	const originMosaicY = tyMin * 256;

	for (let gy = 0; gy < CONTROL_GRID_STEPS; gy++) {
		const n = n1 - (gy / CONTROL_GRID_DIVS) * (n1 - n0);
		for (let gx = 0; gx < CONTROL_GRID_STEPS; gx++) {
			const e = e0 + (gx / CONTROL_GRID_DIVS) * (e1 - e0);
			const [lon, lat] = projectCoords(utmCrs, 'EPSG:4674', e, n);
			const px = lonLatToWebMercatorPixel(lon, lat, chosenZ);
			const idx = gy * CONTROL_GRID_STEPS + gx;
			gridPxX[idx] = px.pxX - originMosaicX;
			gridPxY[idx] = px.pxY - originMosaicY;
		}
	}

	const outRgba = new Uint8Array(targetWidthPx * targetHeightPx * 4);
	const maxSampleX = mosaicW - 1.0001;
	const maxSampleY = mosaicH - 1.0001;

	for (let oy = 0; oy < targetHeightPx; oy++) {
		const vNorm = ((oy + 0.5) / targetHeightPx) * CONTROL_GRID_DIVS;
		const cy = Math.min(CONTROL_GRID_DIVS - 1, Math.max(0, Math.floor(vNorm)));
		const fy = vNorm - cy;
		const row0 = cy * CONTROL_GRID_STEPS;
		const row1 = (cy + 1) * CONTROL_GRID_STEPS;

		for (let ox = 0; ox < targetWidthPx; ox++) {
			const uNorm = ((ox + 0.5) / targetWidthPx) * CONTROL_GRID_DIVS;
			const cx = Math.min(CONTROL_GRID_DIVS - 1, Math.max(0, Math.floor(uNorm)));
			const fx = uNorm - cx;

			const i00 = row0 + cx;
			const i10 = row0 + cx + 1;
			const i01 = row1 + cx;
			const i11 = row1 + cx + 1;

			const mx =
				(gridPxX[i00]! * (1 - fx) + gridPxX[i10]! * fx) * (1 - fy) +
				(gridPxX[i01]! * (1 - fx) + gridPxX[i11]! * fx) * fy;
			const my =
				(gridPxY[i00]! * (1 - fx) + gridPxY[i10]! * fx) * (1 - fy) +
				(gridPxY[i01]! * (1 - fx) + gridPxY[i11]! * fx) * fy;

			const clampedX = Math.max(0, Math.min(maxSampleX, mx));
			const clampedY = Math.max(0, Math.min(maxSampleY, my));

			const outOffset = (oy * targetWidthPx + ox) * 4;
			outRgba[outOffset] = sampleBilinearChannel(mosaic, mosaicW, mosaicH, clampedX, clampedY, 0);
			outRgba[outOffset + 1] = sampleBilinearChannel(
				mosaic,
				mosaicW,
				mosaicH,
				clampedX,
				clampedY,
				1,
			);
			outRgba[outOffset + 2] = sampleBilinearChannel(
				mosaic,
				mosaicW,
				mosaicH,
				clampedX,
				clampedY,
				2,
			);
			outRgba[outOffset + 3] = 255;
		}
	}

	const pngBuf = await sharp(outRgba, {
		raw: {
			width: targetWidthPx,
			height: targetHeightPx,
			channels: 4,
		},
	})
		.sharpen({ sigma: 0.65, m1: 0.6, m2: 1.4 })
		.png({ compressionLevel: 6 })
		.toBuffer();

	return `data:image/png;base64,${pngBuf.toString('base64')}`;
}
