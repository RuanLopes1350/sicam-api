import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { RasterType } from '../../../config/db/schema/enums.js';
import { DomainError } from '../../helpers/domainError.js';
import { classifySclPixel } from '../sclAnalyzer.js';
import type { CanonicalGrid } from './canonicalGrid.js';
import type { CanonicalSceneBands } from './cogBandReader.js';
import { PIXEL_CLASS } from './ndviClassifier.js';

export interface ChannelStretchBounds {
	p2: number;
	p98: number;
	cleanSampleCount: number;
	usedFallback: boolean;
}

export interface RenderedRasterEvidence {
	assetType: RasterType;
	mimeType: 'image/png';
	buffer: Buffer;
	sizeBytes: number;
	sha256: string;
	widthPx: number;
	heightPx: number;
	bounds4674: [number, number, number, number];
}

export interface RenderEvidenceRastersResult {
	rasters: Record<RasterType, RenderedRasterEvidence>;
	stretchAudit: {
		blue: ChannelStretchBounds;
		green: ChannelStretchBounds;
		red: ChannelStretchBounds;
		nir: ChannelStretchBounds;
	};
}

const FALLBACK_VISIBLE_BOUNDS: [number, number] = [0.01, 0.22];
const FALLBACK_NIR_BOUNDS: [number, number] = [0.02, 0.45];

// Spec Parte I — Seção 6: Stretch P2–P98 pareado entre T0 e T1 usando exclusivamente pixels sem nuvem
export function computePairedCleanStretchBounds(
	bandT0: Float32Array,
	sclT0: Uint8Array,
	bandT1: Float32Array,
	sclT1: Uint8Array,
	fallback: [number, number],
): ChannelStretchBounds {
	const bins = 10_000;
	const histogram = new Uint32Array(bins + 1);
	let cleanSampleCount = 0;

	const accumulate = (band: Float32Array, scl: Uint8Array): void => {
		for (let i = 0; i < band.length; i++) {
			if (classifySclPixel(scl[i]!) !== 'clean') {
				continue;
			}
			const val = band[i]!;
			if (!Number.isFinite(val)) {
				continue;
			}
			const clamped = val <= 0 ? 0 : val >= 1 ? 1 : val;
			const binIdx = Math.round(clamped * bins);
			histogram[binIdx] = histogram[binIdx]! + 1;
			cleanSampleCount++;
		}
	};

	accumulate(bandT0, sclT0);
	accumulate(bandT1, sclT1);

	if (cleanSampleCount < 20) {
		return {
			p2: fallback[0],
			p98: fallback[1],
			cleanSampleCount,
			usedFallback: true,
		};
	}

	const targetP2 = Math.max(1, Math.floor(cleanSampleCount * 0.02));
	const targetP98 = Math.min(cleanSampleCount, Math.ceil(cleanSampleCount * 0.98));

	let cumulative = 0;
	let p2Bin = -1;
	let p98Bin = bins;

	for (let b = 0; b <= bins; b++) {
		cumulative += histogram[b]!;
		if (p2Bin === -1 && cumulative >= targetP2) {
			p2Bin = b;
		}
		if (cumulative >= targetP98) {
			p98Bin = b;
			break;
		}
	}

	const p2 = (p2Bin === -1 ? 0 : p2Bin) / bins;
	const p98 = p98Bin / bins;

	if (p98 - p2 < 1e-4) {
		return {
			p2: fallback[0],
			p98: fallback[1],
			cleanSampleCount,
			usedFallback: true,
		};
	}

	return {
		p2: Number(p2.toFixed(4)),
		p98: Number(p98.toFixed(4)),
		cleanSampleCount,
		usedFallback: false,
	};
}

function computeSceneChannelPercentiles(
	band: Float32Array,
	scl: Uint8Array,
	fallback: [number, number],
): ChannelStretchBounds {
	const emptyScl = new Uint8Array(0);
	const emptyBand = new Float32Array(0);
	return computePairedCleanStretchBounds(band, scl, emptyBand, emptyScl, fallback);
}

// Preserva balanço de branco natural em RGB BOA (mesmos ganhos/limites comuns em R, G e B por cena)
function computeSceneTrueColorStretchBounds(scene: {
	red: Float32Array;
	green: Float32Array;
	blue: Float32Array;
	scl: Uint8Array;
}): {
	red: ChannelStretchBounds;
	green: ChannelStretchBounds;
	blue: ChannelStretchBounds;
} {
	const rStats = computeSceneChannelPercentiles(scene.red, scene.scl, FALLBACK_VISIBLE_BOUNDS);
	const gStats = computeSceneChannelPercentiles(scene.green, scene.scl, FALLBACK_VISIBLE_BOUNDS);
	const bStats = computeSceneChannelPercentiles(scene.blue, scene.scl, FALLBACK_VISIBLE_BOUNDS);

	const minP2 = Math.min(rStats.p2, gStats.p2, bStats.p2);
	const low = Number(Math.min(0.025, Math.max(0, minP2 * 0.55)).toFixed(4));
	const maxP98 = Math.max(rStats.p98, gStats.p98, bStats.p98);
	const high = Number(Math.min(0.32, Math.max(0.14, maxP98)).toFixed(4));

	const shared: ChannelStretchBounds = {
		p2: low,
		p98: Math.max(low + 0.08, high),
		cleanSampleCount: Math.min(rStats.cleanSampleCount, gStats.cleanSampleCount, bStats.cleanSampleCount),
		usedFallback: rStats.usedFallback || gStats.usedFallback || bStats.usedFallback,
	};

	return {
		red: shared,
		green: shared,
		blue: shared,
	};
}

function clampFalseColorChannelBounds(
	stats: ChannelStretchBounds,
	minSpan: number,
	maxCap: number,
): ChannelStretchBounds {
	const low = Number(Math.min(0.03, Math.max(0, stats.p2)).toFixed(4));
	const high = Number(Math.max(low + minSpan, Math.min(maxCap, stats.p98)).toFixed(4));
	return {
		p2: low,
		p98: high,
		cleanSampleCount: stats.cleanSampleCount,
		usedFallback: stats.usedFallback,
	};
}

function stretchValueToByte(
	val: number,
	bounds: ChannelStretchBounds,
	invGamma: number,
): number {
	const span = bounds.p98 - bounds.p2;
	if (span <= 0) {
		return 0;
	}
	const norm = (val - bounds.p2) / span;
	const clamped = norm <= 0 ? 0 : norm >= 1 ? 1 : norm;
	const adjusted = invGamma === 1 ? clamped : Math.pow(clamped, invGamma);
	return Math.round(255 * adjusted);
}

function buildCompositeRgbaBuffer(params: {
	pixelCount: number;
	rBand: Float32Array;
	gBand: Float32Array;
	bBand: Float32Array;
	scl: Uint8Array;
	rBounds: ChannelStretchBounds;
	gBounds: ChannelStretchBounds;
	bBounds: ChannelStretchBounds;
	gamma: number;
}): Uint8Array {
	const { pixelCount, rBand, gBand, bBand, scl, rBounds, gBounds, bBounds, gamma } = params;
	const rgba = new Uint8Array(pixelCount * 4);
	const invGamma = gamma === 1 ? 1 : 1 / gamma;

	for (let i = 0; i < pixelCount; i++) {
		const offset = i * 4;
		if (classifySclPixel(scl[i]!) === 'nodata') {
			continue;
		}

		const rv = rBand[i]!;
		const gv = gBand[i]!;
		const bv = bBand[i]!;
		if (!Number.isFinite(rv) || !Number.isFinite(gv) || !Number.isFinite(bv)) {
			continue;
		}

		rgba[offset] = stretchValueToByte(rv, rBounds, invGamma);
		rgba[offset + 1] = stretchValueToByte(gv, gBounds, invGamma);
		rgba[offset + 2] = stretchValueToByte(bv, bBounds, invGamma);
		rgba[offset + 3] = 255;
	}

	return rgba;
}

function buildDeltaMaskRgbaBuffer(filteredClassMap: Uint8Array): Uint8Array {
	const rgba = new Uint8Array(filteredClassMap.length * 4);

	for (let i = 0; i < filteredClassMap.length; i++) {
		const code = filteredClassMap[i]!;
		const offset = i * 4;

		switch (code) {
			case PIXEL_CLASS.DEFORESTATION:
				// #E53935 alpha 165
				rgba[offset] = 229;
				rgba[offset + 1] = 57;
				rgba[offset + 2] = 53;
				rgba[offset + 3] = 165;
				break;
			case PIXEL_CLASS.DEGRADATION:
				// #FB8C00 alpha 150
				rgba[offset] = 251;
				rgba[offset + 1] = 140;
				rgba[offset + 2] = 0;
				rgba[offset + 3] = 150;
				break;
			case PIXEL_CLASS.REGROWTH:
				// #00E676 alpha 150
				rgba[offset] = 0;
				rgba[offset + 1] = 230;
				rgba[offset + 2] = 118;
				rgba[offset + 3] = 150;
				break;
			case PIXEL_CLASS.CLOUD_OBSTRUCTED:
				// #9E9E9E alpha 95
				rgba[offset] = 158;
				rgba[offset + 1] = 158;
				rgba[offset + 2] = 158;
				rgba[offset + 3] = 95;
				break;
			default:
				// 0 = Estável / fora da AOI -> transparente
				break;
		}
	}

	return rgba;
}

async function encodeLosslessPngEvidence(
	assetType: RasterType,
	rgba: Uint8Array,
	grid: CanonicalGrid,
): Promise<RenderedRasterEvidence> {
	const buffer = await sharp(rgba, {
		raw: {
			width: grid.width,
			height: grid.height,
			channels: 4,
		},
	})
		.png({
			compressionLevel: 9,
			adaptiveFiltering: false,
		})
		.toBuffer();

	const sha256 = createHash('sha256').update(buffer).digest('hex');

	return {
		assetType,
		mimeType: 'image/png',
		buffer,
		sizeBytes: buffer.byteLength,
		sha256,
		widthPx: grid.width,
		heightPx: grid.height,
		bounds4674: [...grid.bounds4674],
	};
}

// Spec Parte I — Seção 6: Geração dos 5 arquivos PNG lossless de evidência visual via sharp
export async function renderCanonicalEvidenceRasters(params: {
	grid: CanonicalGrid;
	t0: Pick<CanonicalSceneBands, 'blue' | 'green' | 'red' | 'nir' | 'scl'>;
	t1: Pick<CanonicalSceneBands, 'blue' | 'green' | 'red' | 'nir' | 'scl'>;
	filteredClassMap: Uint8Array;
}): Promise<RenderEvidenceRastersResult> {
	const { grid, t0, t1, filteredClassMap } = params;
	const n = grid.pixelCount;

	if (
		t0.blue.length !== n ||
		t0.green.length !== n ||
		t0.red.length !== n ||
		t0.nir.length !== n ||
		t0.scl.length !== n ||
		t1.blue.length !== n ||
		t1.green.length !== n ||
		t1.red.length !== n ||
		t1.nir.length !== n ||
		t1.scl.length !== n ||
		filteredClassMap.length !== n
	) {
		throw new DomainError(
			'ERR_INTERNAL_SERVER_ERROR',
			'Dimensões inconsistentes dos buffers espectrais para renderização dos rasters PNG.',
		);
	}

	const stretchAudit = {
		blue: computePairedCleanStretchBounds(t0.blue, t0.scl, t1.blue, t1.scl, FALLBACK_VISIBLE_BOUNDS),
		green: computePairedCleanStretchBounds(
			t0.green,
			t0.scl,
			t1.green,
			t1.scl,
			FALLBACK_VISIBLE_BOUNDS,
		),
		red: computePairedCleanStretchBounds(t0.red, t0.scl, t1.red, t1.scl, FALLBACK_VISIBLE_BOUNDS),
		nir: computePairedCleanStretchBounds(t0.nir, t0.scl, t1.nir, t1.scl, FALLBACK_NIR_BOUNDS),
	};

	const t0TrueColor = computeSceneTrueColorStretchBounds(t0);
	const t1TrueColor = computeSceneTrueColorStretchBounds(t1);

	const t0NirBounds = clampFalseColorChannelBounds(
		computeSceneChannelPercentiles(t0.nir, t0.scl, FALLBACK_NIR_BOUNDS),
		0.2,
		0.55,
	);
	const t0RedFcBounds = clampFalseColorChannelBounds(
		computeSceneChannelPercentiles(t0.red, t0.scl, FALLBACK_VISIBLE_BOUNDS),
		0.12,
		0.3,
	);
	const t0GreenFcBounds = clampFalseColorChannelBounds(
		computeSceneChannelPercentiles(t0.green, t0.scl, FALLBACK_VISIBLE_BOUNDS),
		0.12,
		0.3,
	);

	const t1NirBounds = clampFalseColorChannelBounds(
		computeSceneChannelPercentiles(t1.nir, t1.scl, FALLBACK_NIR_BOUNDS),
		0.2,
		0.55,
	);
	const t1RedFcBounds = clampFalseColorChannelBounds(
		computeSceneChannelPercentiles(t1.red, t1.scl, FALLBACK_VISIBLE_BOUNDS),
		0.12,
		0.3,
	);
	const t1GreenFcBounds = clampFalseColorChannelBounds(
		computeSceneChannelPercentiles(t1.green, t1.scl, FALLBACK_VISIBLE_BOUNDS),
		0.12,
		0.3,
	);

	const t0RgbRgba = buildCompositeRgbaBuffer({
		pixelCount: n,
		rBand: t0.red,
		gBand: t0.green,
		bBand: t0.blue,
		scl: t0.scl,
		rBounds: t0TrueColor.red,
		gBounds: t0TrueColor.green,
		bBounds: t0TrueColor.blue,
		gamma: 1.45,
	});

	const t1RgbRgba = buildCompositeRgbaBuffer({
		pixelCount: n,
		rBand: t1.red,
		gBand: t1.green,
		bBand: t1.blue,
		scl: t1.scl,
		rBounds: t1TrueColor.red,
		gBounds: t1TrueColor.green,
		bBounds: t1TrueColor.blue,
		gamma: 1.45,
	});

	const t0FalseColorRgba = buildCompositeRgbaBuffer({
		pixelCount: n,
		rBand: t0.nir,
		gBand: t0.red,
		bBand: t0.green,
		scl: t0.scl,
		rBounds: t0NirBounds,
		gBounds: t0RedFcBounds,
		bBounds: t0GreenFcBounds,
		gamma: 1.25,
	});

	const t1FalseColorRgba = buildCompositeRgbaBuffer({
		pixelCount: n,
		rBand: t1.nir,
		gBand: t1.red,
		bBand: t1.green,
		scl: t1.scl,
		rBounds: t1NirBounds,
		gBounds: t1RedFcBounds,
		bBounds: t1GreenFcBounds,
		gamma: 1.25,
	});

	const deltaMaskRgba = buildDeltaMaskRgbaBuffer(filteredClassMap);

	const [t0Rgb, t1Rgb, t0FalseColor, t1FalseColor, deltaNdviMask] = await Promise.all([
		encodeLosslessPngEvidence('t0_rgb', t0RgbRgba, grid),
		encodeLosslessPngEvidence('t1_rgb', t1RgbRgba, grid),
		encodeLosslessPngEvidence('t0_false_color', t0FalseColorRgba, grid),
		encodeLosslessPngEvidence('t1_false_color', t1FalseColorRgba, grid),
		encodeLosslessPngEvidence('delta_ndvi_mask', deltaMaskRgba, grid),
	]);

	return {
		rasters: {
			t0_rgb: t0Rgb,
			t1_rgb: t1Rgb,
			t0_false_color: t0FalseColor,
			t1_false_color: t1FalseColor,
			delta_ndvi_mask: deltaNdviMask,
		},
		stretchAudit,
	};
}
