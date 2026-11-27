import { env } from '../../../config/env.js';
import { DomainError } from '../../helpers/domainError.js';
import type { AoiPolygonGeoJson } from '../../validation/caseValidation.js';
import { ensureProjDefinitions, projectCoords } from '../projRegistry.js';
import { rasterizePolygonScanline } from '../sclAnalyzer.js';

export interface CanonicalGrid {
	e0: number;
	n0: number;
	e1: number;
	n1: number;
	width: number;
	height: number;
	pixelCount: number;
	pixelSizeM: 10;
	utmSrid: number;
	aoiBoundsUtm: [number, number, number, number];
	bounds4674: [number, number, number, number];
	ringUtm: [number, number][];
}

// Spec Parte I — Seção 1.1: Grade métrica unificada (snap 10m, margem visual >= max(15%, 250m), trava Anti-OOM)
export function createCanonicalGrid(
	aoiGeoJson: AoiPolygonGeoJson,
	utmSrid: number,
	maxPixelsGuard: number = env.GEO_MAX_PIXELS_GUARD,
): CanonicalGrid {
	ensureProjDefinitions();

	const ring4674 = aoiGeoJson.coordinates[0];
	if (!ring4674 || ring4674.length < 4) {
		throw new DomainError(
			'ERR_INVALID_GEOMETRY',
			'Polígono da AOI inválido para construção da grade canônica.',
		);
	}

	const utmCrs = `EPSG:${utmSrid}`;
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

	const deltaE = eMax - eMin;
	const deltaN = nMax - nMin;
	// Margem mínima de 2300 m garante cobertura integral (>= ~4,7 km x 4,7 km) para a escala mínima 1:25.000 no Sentinel-2 (10 m/px)
	const marginM = Math.max(0.15 * Math.max(deltaE, deltaN), 2300);

	const e0 = Math.floor((eMin - marginM) / 10) * 10;
	const e1 = Math.ceil((eMax + marginM) / 10) * 10;
	const n0 = Math.floor((nMin - marginM) / 10) * 10;
	const n1 = Math.ceil((nMax + marginM) / 10) * 10;

	const width = Math.round((e1 - e0) / 10);
	const height = Math.round((n1 - n0) / 10);
	const pixelCount = width * height;

	if (width <= 0 || height <= 0 || !Number.isFinite(pixelCount) || pixelCount > maxPixelsGuard) {
		throw new DomainError(
			'ERR_GRID_PIXEL_LIMIT_EXCEEDED',
			`A grade canônica de 10 m (${width} x ${height} = ${pixelCount} px) excede o teto operacional de ${maxPixelsGuard} pixels.`,
			{
				invalidParams: [
					{
						field: 'aoiGeoJson',
						reason: 'GRID_PIXEL_LIMIT_EXCEEDED',
						meta: { width, height, pixelCount, maxPixelsGuard },
					},
				],
			},
		);
	}

	const eMid = (e0 + e1) / 2;
	const nMid = (n0 + n1) / 2;
	const gridControlPoints: ReadonlyArray<[number, number]> = [
		[e0, n0],
		[e1, n0],
		[e1, n1],
		[e0, n1],
		[eMid, n0],
		[e1, nMid],
		[eMid, n1],
		[e0, nMid],
	];

	let minLon = Number.POSITIVE_INFINITY;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;

	for (const [e, n] of gridControlPoints) {
		const [lon, lat] = projectCoords(utmCrs, 'EPSG:4674', e, n);
		if (lon < minLon) minLon = lon;
		if (lat < minLat) minLat = lat;
		if (lon > maxLon) maxLon = lon;
		if (lat > maxLat) maxLat = lat;
	}

	return {
		e0,
		n0,
		e1,
		n1,
		width,
		height,
		pixelCount,
		pixelSizeM: 10,
		utmSrid,
		aoiBoundsUtm: [eMin, nMin, eMax, nMax],
		bounds4674: [
			Number(minLon.toFixed(7)),
			Number(minLat.toFixed(7)),
			Number(maxLon.toFixed(7)),
			Number(maxLat.toFixed(7)),
		],
		ringUtm,
	};
}

// Spec Parte I — Seção 1.2: Conversão coordenada <-> pixel na Grade Canônica
export function utmToCol(grid: CanonicalGrid, easting: number): number {
	return Math.floor((easting - grid.e0) / grid.pixelSizeM);
}

export function utmToRow(grid: CanonicalGrid, northing: number): number {
	return Math.floor((grid.n1 - northing) / grid.pixelSizeM);
}

export function colToCenterE(grid: CanonicalGrid, col: number): number {
	return grid.e0 + (col + 0.5) * grid.pixelSizeM;
}

export function rowToCenterN(grid: CanonicalGrid, row: number): number {
	return grid.n1 - (row + 0.5) * grid.pixelSizeM;
}

// Spec Parte I — Seção 4.1: Máscara binária da AOI (0 = margem visual, 1 = dentro da AOI)
export function buildCanonicalAoiMask(grid: CanonicalGrid): Uint8Array {
	return rasterizePolygonScanline(grid.ringUtm, {
		e0: grid.e0,
		n0: grid.n0,
		e1: grid.e1,
		n1: grid.n1,
		width: grid.width,
		height: grid.height,
		cellSizeM: grid.pixelSizeM,
		utmSrid: grid.utmSrid,
	});
}
