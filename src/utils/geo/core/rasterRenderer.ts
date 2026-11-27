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
	const low = Number(Math.min(0.045, Math.max(0, minP2 * 0.8)).toFixed(4));
	const maxP98 = Math.max(rStats.p98, gStats.p98, bStats.p98);
	const high = Number(Math.min(0.28, Math.max(0.13, maxP98 * 0.96)).toFixed(4));

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
	microContrast = false,
): number {
	const span = bounds.p98 - bounds.p2;
	if (span <= 0) {
		return 0;
	}
	const norm = (val - bounds.p2) / span;
	const clamped = norm <= 0 ? 0 : norm >= 1 ? 1 : norm;
	let adjusted = invGamma === 1 ? clamped : Math.pow(clamped, invGamma);
	if (microContrast) {
		// Curva S suave (15% smoothstep) recupera microcontraste sem clipping de sombras ou brilhos
		const sCurve = adjusted * adjusted * (3 - 2 * adjusted);
		adjusted = adjusted * 0.85 + sCurve * 0.15;
	}
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
	microContrast?: boolean;
}): Uint8Array {
	const {
		pixelCount,
		rBand,
		gBand,
		bBand,
		scl,
		rBounds,
		gBounds,
		bBounds,
		gamma,
		microContrast = false,
	} = params;
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

		rgba[offset] = stretchValueToByte(rv, rBounds, invGamma, microContrast);
		rgba[offset + 1] = stretchValueToByte(gv, gBounds, invGamma, microContrast);
		rgba[offset + 2] = stretchValueToByte(bv, bBounds, invGamma, microContrast);
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

/**
 * Compensa o desfoque óptico (MTF/PSF) do sensor Sentinel-2 em grade nativa de 10 m
 * usando filtro unsharp puramente em luminância (Rec.709), preservando cromaticidade
 * e ignorando vizinhos nodata (alpha === 0).
 */
export function applyNativeLuminanceMtfSharpen(
	rgba: Uint8Array,
	width: number,
	height: number,
	strength = 0.85,
): Uint8Array {
	const pixelCount = width * height;
	if (width < 3 || height < 3 || rgba.length !== pixelCount * 4 || strength <= 0) {
		return rgba;
	}

	const lum = new Float32Array(pixelCount);
	const valid = new Uint8Array(pixelCount);
	for (let i = 0; i < pixelCount; i++) {
		const offset = i * 4;
		if (rgba[offset + 3]! > 0) {
			valid[i] = 1;
			lum[i] =
				0.2126 * rgba[offset]! + 0.7152 * rgba[offset + 1]! + 0.0722 * rgba[offset + 2]!;
		}
	}

	const out = new Uint8Array(rgba);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = y * width + x;
			if (!valid[idx]) continue;

			let acc = 0;
			let wSum = 0;
			for (let dy = -1; dy <= 1; dy++) {
				const ny = y + dy;
				if (ny < 0 || ny >= height) continue;
				for (let dx = -1; dx <= 1; dx++) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx;
					if (nx < 0 || nx >= width) continue;
					const nIdx = ny * width + nx;
					if (!valid[nIdx]) continue;
					const w = dx === 0 || dy === 0 ? 2 : 1;
					acc += lum[nIdx]! * w;
					wSum += w;
				}
			}

			if (wSum === 0) continue;
			const centerY = lum[idx]!;
			const meanY = acc / wSum;
			const deltaY = (centerY - meanY) * strength;
			const offset = idx * 4;

			if (centerY > 1) {
				const ratio = Math.max(0, (centerY + deltaY) / centerY);
				out[offset] = Math.min(255, Math.max(0, Math.round(rgba[offset]! * ratio)));
				out[offset + 1] = Math.min(255, Math.max(0, Math.round(rgba[offset + 1]! * ratio)));
				out[offset + 2] = Math.min(255, Math.max(0, Math.round(rgba[offset + 2]! * ratio)));
			} else {
				out[offset] = Math.min(255, Math.max(0, Math.round(rgba[offset]! + deltaY)));
				out[offset + 1] = Math.min(255, Math.max(0, Math.round(rgba[offset + 1]! + deltaY)));
				out[offset + 2] = Math.min(255, Math.max(0, Math.round(rgba[offset + 2]! + deltaY)));
			}
		}
	}

	return out;
}

export async function progressiveResizeToPng(params: {
	pipeline: ReturnType<typeof sharp>;
	srcWidthPx: number;
	srcHeightPx: number;
	dstWidthPx: number;
	dstHeightPx: number;
	compressionLevel?: number;
}): Promise<Buffer> {
	const compressionLevel = params.compressionLevel ?? 9;
	const { srcWidthPx, srcHeightPx, dstWidthPx, dstHeightPx } = params;

	if (dstWidthPx <= srcWidthPx * 1.15 && dstHeightPx <= srcHeightPx * 1.15) {
		return params.pipeline
			.resize(dstWidthPx, dstHeightPx, {
				kernel: sharp.kernel.lanczos3,
				fit: 'fill',
			})
			.png({ compressionLevel })
			.toBuffer();
	}

	let curW = srcWidthPx;
	let curH = srcHeightPx;
	let current = params.pipeline;

	while (curW < dstWidthPx || curH < dstHeightPx) {
		const nextW =
			curW < dstWidthPx ? Math.min(dstWidthPx, Math.max(curW + 1, curW * 2)) : dstWidthPx;
		const nextH =
			curH < dstHeightPx ? Math.min(dstHeightPx, Math.max(curH + 1, curH * 2)) : dstHeightPx;
		const isFinal = nextW === dstWidthPx && nextH === dstHeightPx;

		const step = current
			.resize(nextW, nextH, {
				kernel: sharp.kernel.lanczos3,
				fit: 'fill',
			})
			.sharpen(
				isFinal
					? { sigma: 0.65, m1: 0.7, m2: 1.5 }
					: { sigma: 0.78, m1: 0.85, m2: 1.85 },
			);

		if (isFinal) {
			return step.png({ compressionLevel }).toBuffer();
		}

		const { data, info } = await step.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		current = sharp(data, {
			raw: {
				width: info.width,
				height: info.height,
				channels: info.channels,
			},
		});
		curW = info.width;
		curH = info.height;
	}

	return current.png({ compressionLevel }).toBuffer();
}

/**
 * Super-amostra PNGs de evidência Sentinel-2 (2x..4x em oitavas com lanczos3 + sharpen)
 * para exibição nítida no slider WebGL sem alterar o hash de custódia em S3.
 */
export async function upscaleEvidencePngProgressively(
	pngBuffer: Buffer,
	factor: number,
	isCategoricalMask = false,
): Promise<Buffer> {
	const safeFactor = Math.min(4, Math.max(1, Math.round(factor)));
	if (safeFactor <= 1) {
		return pngBuffer;
	}

	const meta = await sharp(pngBuffer).metadata();
	const srcW = meta.width ?? 0;
	const srcH = meta.height ?? 0;
	if (srcW <= 0 || srcH <= 0) {
		return pngBuffer;
	}

	const dstW = srcW * safeFactor;
	const dstH = srcH * safeFactor;

	if (isCategoricalMask) {
		return sharp(pngBuffer)
			.resize(dstW, dstH, {
				kernel: sharp.kernel.nearest,
				fit: 'fill',
			})
			.png({ compressionLevel: 6 })
			.toBuffer();
	}

	return progressiveResizeToPng({
		pipeline: sharp(pngBuffer).ensureAlpha(1),
		srcWidthPx: srcW,
		srcHeightPx: srcH,
		dstWidthPx: dstW,
		dstHeightPx: dstH,
		compressionLevel: 6,
	});
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
		gamma: 1.3,
		microContrast: true,
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
		gamma: 1.3,
		microContrast: true,
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

	const t0RgbSharpened = applyNativeLuminanceMtfSharpen(t0RgbRgba, grid.width, grid.height, 0.85);
	const t1RgbSharpened = applyNativeLuminanceMtfSharpen(t1RgbRgba, grid.width, grid.height, 0.85);
	const t0FcSharpened = applyNativeLuminanceMtfSharpen(
		t0FalseColorRgba,
		grid.width,
		grid.height,
		0.85,
	);
	const t1FcSharpened = applyNativeLuminanceMtfSharpen(
		t1FalseColorRgba,
		grid.width,
		grid.height,
		0.85,
	);

	const deltaMaskRgba = buildDeltaMaskRgbaBuffer(filteredClassMap);

	const [t0Rgb, t1Rgb, t0FalseColor, t1FalseColor, deltaNdviMask] = await Promise.all([
		encodeLosslessPngEvidence('t0_rgb', t0RgbSharpened, grid),
		encodeLosslessPngEvidence('t1_rgb', t1RgbSharpened, grid),
		encodeLosslessPngEvidence('t0_false_color', t0FcSharpened, grid),
		encodeLosslessPngEvidence('t1_false_color', t1FcSharpened, grid),
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
