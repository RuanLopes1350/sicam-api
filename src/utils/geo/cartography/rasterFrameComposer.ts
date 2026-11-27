import sharp from 'sharp';

interface ResamplePlan {
	srcLeft: number;
	srcTop: number;
	srcCropW: number;
	srcCropH: number;
	patchW: number;
	patchH: number;
	clipLeft: number;
	clipTop: number;
	finalW: number;
	finalH: number;
	dstLeft: number;
	dstTop: number;
}

function computeResamplePlan(params: {
	srcWidthPx: number;
	srcHeightPx: number;
	gridBboxUtm: [number, number, number, number];
	mapBboxUtm: [number, number, number, number];
	targetWidthPx: number;
	targetHeightPx: number;
}): ResamplePlan | null {
	const {
		srcWidthPx,
		srcHeightPx,
		gridBboxUtm,
		mapBboxUtm,
		targetWidthPx,
		targetHeightPx,
	} = params;

	const [gEMin, gNMin, gEMax, gNMax] = gridBboxUtm;
	const [mEMin, mNMin, mEMax, mNMax] = mapBboxUtm;

	const gridWidthM = gEMax - gEMin;
	const gridHeightM = gNMax - gNMin;
	const mapWidthM = mEMax - mEMin;
	const mapHeightM = mNMax - mNMin;

	if (gridWidthM <= 0 || gridHeightM <= 0 || mapWidthM <= 0 || mapHeightM <= 0) {
		return null;
	}

	const iEMin = Math.max(gEMin, mEMin);
	const iEMax = Math.min(gEMax, mEMax);
	const iNMin = Math.max(gNMin, mNMin);
	const iNMax = Math.min(gNMax, mNMax);

	if (iEMin >= iEMax || iNMin >= iNMax) {
		return null;
	}

	const rawSrcLeft = Math.floor(((iEMin - gEMin) / gridWidthM) * srcWidthPx);
	const rawSrcRight = Math.ceil(((iEMax - gEMin) / gridWidthM) * srcWidthPx);
	const rawSrcTop = Math.floor(((gNMax - iNMax) / gridHeightM) * srcHeightPx);
	const rawSrcBottom = Math.ceil(((gNMax - iNMin) / gridHeightM) * srcHeightPx);

	const srcLeft = Math.max(0, Math.min(srcWidthPx - 1, rawSrcLeft));
	const srcRight = Math.max(srcLeft + 1, Math.min(srcWidthPx, rawSrcRight));
	const srcTop = Math.max(0, Math.min(srcHeightPx - 1, rawSrcTop));
	const srcBottom = Math.max(srcTop + 1, Math.min(srcHeightPx, rawSrcBottom));

	const srcCropW = srcRight - srcLeft;
	const srcCropH = srcBottom - srcTop;

	// Coordenadas UTM exatas cobertas pelos pixels inteiros extraídos
	const cropEMin = gEMin + (srcLeft / srcWidthPx) * gridWidthM;
	const cropEMax = gEMin + (srcRight / srcWidthPx) * gridWidthM;
	const cropNMax = gNMax - (srcTop / srcHeightPx) * gridHeightM;
	const cropNMin = gNMax - (srcBottom / srcHeightPx) * gridHeightM;

	const rawDstLeft = Math.round(((cropEMin - mEMin) / mapWidthM) * targetWidthPx);
	const rawDstTop = Math.round(((mNMax - cropNMax) / mapHeightM) * targetHeightPx);
	const patchW = Math.max(1, Math.round(((cropEMax - cropEMin) / mapWidthM) * targetWidthPx));
	const patchH = Math.max(1, Math.round(((cropNMax - cropNMin) / mapHeightM) * targetHeightPx));

	// Recorta sobras fora de [0..targetWidthPx, 0..targetHeightPx] com alinhamento sub-pixel preservado
	const clipLeft = Math.max(0, -rawDstLeft);
	const clipTop = Math.max(0, -rawDstTop);
	const dstLeft = Math.max(0, rawDstLeft);
	const dstTop = Math.max(0, rawDstTop);

	const finalW = Math.min(patchW - clipLeft, targetWidthPx - dstLeft);
	const finalH = Math.min(patchH - clipTop, targetHeightPx - dstTop);

	if (finalW <= 0 || finalH <= 0) {
		return null;
	}

	return {
		srcLeft,
		srcTop,
		srcCropW,
		srcCropH,
		patchW,
		patchH,
		clipLeft,
		clipTop,
		finalW,
		finalH,
		dstLeft,
		dstTop,
	};
}

async function clipResizedPatchIfNeeded(resizedBuf: Buffer, plan: ResamplePlan): Promise<Buffer> {
	if (
		plan.clipLeft === 0 &&
		plan.clipTop === 0 &&
		plan.finalW === plan.patchW &&
		plan.finalH === plan.patchH
	) {
		return resizedBuf;
	}
	return sharp(resizedBuf)
		.extract({
			left: plan.clipLeft,
			top: plan.clipTop,
			width: plan.finalW,
			height: plan.finalH,
		})
		.png()
		.toBuffer();
}

// Spec Parte II — Seção 2.2: Recorta/reamostra o raster RGB exato para MapBBox_UTM a 300 DPI (lanczos3)
export async function composePrintFramePngDataUri(params: {
	sourcePngBuffer: Buffer;
	gridBboxUtm: [number, number, number, number];
	mapBboxUtm: [number, number, number, number];
	targetWidthPx: number;
	targetHeightPx: number;
}): Promise<string> {
	const meta = await sharp(params.sourcePngBuffer).metadata();
	const srcWidthPx = meta.width ?? 0;
	const srcHeightPx = meta.height ?? 0;

	const canvas = sharp({
		create: {
			width: params.targetWidthPx,
			height: params.targetHeightPx,
			channels: 4,
			background: { r: 241, g: 245, b: 249, alpha: 1 },
		},
	});

	if (srcWidthPx <= 0 || srcHeightPx <= 0) {
		const fallbackBuf = await canvas.png({ compressionLevel: 9 }).toBuffer();
		return `data:image/png;base64,${fallbackBuf.toString('base64')}`;
	}

	const plan = computeResamplePlan({
		srcWidthPx,
		srcHeightPx,
		gridBboxUtm: params.gridBboxUtm,
		mapBboxUtm: params.mapBboxUtm,
		targetWidthPx: params.targetWidthPx,
		targetHeightPx: params.targetHeightPx,
	});

	if (!plan) {
		const emptyBuf = await canvas.png({ compressionLevel: 9 }).toBuffer();
		return `data:image/png;base64,${emptyBuf.toString('base64')}`;
	}

	const resizePipeline = sharp(params.sourcePngBuffer)
		.extract({
			left: plan.srcLeft,
			top: plan.srcTop,
			width: plan.srcCropW,
			height: plan.srcCropH,
		})
		.flatten({ background: { r: 241, g: 245, b: 249 } })
		.ensureAlpha(1)
		.resize(plan.patchW, plan.patchH, {
			kernel: sharp.kernel.mitchell,
			fit: 'fill',
		});

	if (plan.patchW > plan.srcCropW * 1.25 || plan.patchH > plan.srcCropH * 1.25) {
		resizePipeline.sharpen({ sigma: 0.85, m1: 0.7, m2: 1.5 });
	}

	const resizedPatch = await resizePipeline.png().toBuffer();

	const finalPatch = await clipResizedPatchIfNeeded(resizedPatch, plan);

	const composed = await canvas
		.composite([
			{
				input: finalPatch,
				left: plan.dstLeft,
				top: plan.dstTop,
			},
		])
		.png({ compressionLevel: 9 })
		.toBuffer();

	return `data:image/png;base64,${composed.toString('base64')}`;
}

// Extrai apenas pixels obstruídos por nuvem/sombra (R=158, G=158, B=158 em delta_ndvi_mask) com hachura sutil
export async function composeCloudHatchOverlayDataUri(params: {
	deltaMaskPngBuffer: Buffer;
	gridBboxUtm: [number, number, number, number];
	mapBboxUtm: [number, number, number, number];
	targetWidthPx: number;
	targetHeightPx: number;
	opacityScale?: number;
}): Promise<string | null> {
	const { data, info } = await sharp(params.deltaMaskPngBuffer)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });

	const cloudOnlyRgba = new Uint8Array(data.length);
	const opacityScale = params.opacityScale ?? 1.0;
	let hasCloudPixels = false;

	for (let r = 0; r < info.height; r++) {
		for (let c = 0; c < info.width; c++) {
			const idx = (r * info.width + c) * 4;
			const red = data[idx]!;
			const green = data[idx + 1]!;
			const blue = data[idx + 2]!;
			const alpha = data[idx + 3]!;

			if (alpha > 0 && red === 158 && green === 158 && blue === 158) {
				hasCloudPixels = true;
				const isStripe = (r + c) % 4 === 0;
				cloudOnlyRgba[idx] = isStripe ? 248 : 148;
				cloudOnlyRgba[idx + 1] = isStripe ? 250 : 163;
				cloudOnlyRgba[idx + 2] = isStripe ? 252 : 184;
				cloudOnlyRgba[idx + 3] = Math.max(10, Math.round((isStripe ? 120 : 85) * opacityScale));
			}
		}
	}

	if (!hasCloudPixels) {
		return null;
	}

	const cloudMaskPng = await sharp(cloudOnlyRgba, {
		raw: { width: info.width, height: info.height, channels: 4 },
	})
		.png()
		.toBuffer();

	const plan = computeResamplePlan({
		srcWidthPx: info.width,
		srcHeightPx: info.height,
		gridBboxUtm: params.gridBboxUtm,
		mapBboxUtm: params.mapBboxUtm,
		targetWidthPx: params.targetWidthPx,
		targetHeightPx: params.targetHeightPx,
	});

	if (!plan) {
		return null;
	}

	const resizedPatch = await sharp(cloudMaskPng)
		.extract({
			left: plan.srcLeft,
			top: plan.srcTop,
			width: plan.srcCropW,
			height: plan.srcCropH,
		})
		.resize(plan.patchW, plan.patchH, {
			kernel: sharp.kernel.nearest,
			fit: 'fill',
		})
		.png()
		.toBuffer();

	const finalPatch = await clipResizedPatchIfNeeded(resizedPatch, plan);

	const composed = await sharp({
		create: {
			width: params.targetWidthPx,
			height: params.targetHeightPx,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	})
		.composite([
			{
				input: finalPatch,
				left: plan.dstLeft,
				top: plan.dstTop,
			},
		])
		.png({ compressionLevel: 9 })
		.toBuffer();

	return `data:image/png;base64,${composed.toString('base64')}`;
}
