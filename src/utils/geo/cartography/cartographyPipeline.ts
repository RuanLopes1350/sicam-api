import type { PaperFormat, RasterType } from '../../../config/db/schema/enums.js';
import cartographyRepository, {
	type CartographyRunBundle,
} from '../../../repository/cartographyRepository.js';
import { storageRepository } from '../../../repository/storageRepository.js';
import { DomainError } from '../../helpers/domainError.js';
import { createCanonicalGrid } from '../core/canonicalGrid.js';
import { renderIbgeInsetMapSvg } from './insetMapSvg.js';
import { renderHtmlToCartographicPdf } from './pdfRenderer.js';
import { buildCartographicPlateHtml } from './plateTemplateHtml.js';
import {
	composeCloudHatchOverlayDataUri,
	composePrintFramePngDataUri,
} from './rasterFrameComposer.js';
import {
	computeLockedCartographicFrame,
	type LockedCartographicFrame,
} from './scaleAndLayout.js';
import { renderMapPanelSvg } from './utmGridSvg.js';

export interface RenderRunCartographicPlateResult {
	pdfBuffer: Buffer;
	pdfSha256: string;
	pdfSizeBytes: number;
	paperFormat: PaperFormat;
	cartographicScale: number;
	lockedFrame: LockedCartographicFrame;
	blockedRequests: string[];
	bundle: CartographyRunBundle;
}

// Orquestrador completo da Carta-Imagem A4/A3 (300 DPI) no Chromium Offline
export async function renderRunCartographicPlatePdf(params: {
	runId: string;
	paperFormat: PaperFormat;
	issuer: { fullName: string; registrationCode: string };
	observations?: string | null;
	datasetFingerprintSha256: string;
	emittedAt?: Date;
	preloadedBundle?: CartographyRunBundle;
	preloadedRasterBuffers?: Partial<Record<RasterType, Buffer>>;
}): Promise<RenderRunCartographicPlateResult> {
	const bundle =
		params.preloadedBundle ?? (await cartographyRepository.findCartographyRunBundle(params.runId));
	if (!bundle) {
		throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
	}

	const t0RgbMeta = bundle.rastersByType.t0_rgb;
	const t1RgbMeta = bundle.rastersByType.t1_rgb;
	if (!t0RgbMeta || !t1RgbMeta) {
		throw new DomainError(
			'ERR_RUN_NOT_REVIEWABLE',
			'As evidências raster RGB de T0 e T1 ainda não foram persistidas para emissão cartográfica.',
		);
	}

	const grid = createCanonicalGrid(bundle.aoiGeoJson, bundle.utmSrid);
	const gridBboxUtm: [number, number, number, number] = [grid.e0, grid.n0, grid.e1, grid.n1];
	const lockedFrame = computeLockedCartographicFrame(bundle.aoiBoundsUtm, params.paperFormat);

	const maskMeta = bundle.rastersByType.delta_ndvi_mask;
	const preloaded = params.preloadedRasterBuffers;
	const [t0RgbObj, t1RgbObj, deltaMaskObj] = await Promise.all([
		preloaded?.t0_rgb
			? Promise.resolve({ buffer: preloaded.t0_rgb })
			: storageRepository.getPrivateObjectBytes(t0RgbMeta.storageKey, t0RgbMeta.storageBucket),
		preloaded?.t1_rgb
			? Promise.resolve({ buffer: preloaded.t1_rgb })
			: storageRepository.getPrivateObjectBytes(t1RgbMeta.storageKey, t1RgbMeta.storageBucket),
		preloaded?.delta_ndvi_mask
			? Promise.resolve({ buffer: preloaded.delta_ndvi_mask })
			: maskMeta
				? storageRepository.getPrivateObjectBytes(maskMeta.storageKey, maskMeta.storageBucket)
				: Promise.resolve(null),
	]);

	const targetW = lockedFrame.layout.mapInnerWidthPx;
	const targetH = lockedFrame.layout.mapInnerHeightPx;

	const [t0RgbDataUri, t1RgbDataUri, cloudOverlayT1, cloudOverlayT0] = await Promise.all([
		composePrintFramePngDataUri({
			sourcePngBuffer: t0RgbObj.buffer,
			gridBboxUtm,
			mapBboxUtm: lockedFrame.mapBboxUtm,
			targetWidthPx: targetW,
			targetHeightPx: targetH,
		}),
		composePrintFramePngDataUri({
			sourcePngBuffer: t1RgbObj.buffer,
			gridBboxUtm,
			mapBboxUtm: lockedFrame.mapBboxUtm,
			targetWidthPx: targetW,
			targetHeightPx: targetH,
		}),
		deltaMaskObj
			? composeCloudHatchOverlayDataUri({
					deltaMaskPngBuffer: deltaMaskObj.buffer,
					gridBboxUtm,
					mapBboxUtm: lockedFrame.mapBboxUtm,
					targetWidthPx: targetW,
					targetHeightPx: targetH,
					opacityScale: 1.0,
				})
			: Promise.resolve(null),
		deltaMaskObj
			? composeCloudHatchOverlayDataUri({
					deltaMaskPngBuffer: deltaMaskObj.buffer,
					gridBboxUtm,
					mapBboxUtm: lockedFrame.mapBboxUtm,
					targetWidthPx: targetW,
					targetHeightPx: targetH,
					opacityScale: 0.45,
				})
			: Promise.resolve(null),
	]);

	const t0PanelSvg = renderMapPanelSvg({
		panelKey: 't0',
		frame: lockedFrame,
		utmSrid: bundle.utmSrid,
		rgbDataUri: t0RgbDataUri,
		cloudOverlayDataUri: cloudOverlayT0,
		aoiGeoJson: bundle.aoiGeoJson,
		features: [],
	});

	const t1PanelSvg = renderMapPanelSvg({
		panelKey: 't1',
		frame: lockedFrame,
		utmSrid: bundle.utmSrid,
		rgbDataUri: t1RgbDataUri,
		cloudOverlayDataUri: cloudOverlayT1,
		aoiGeoJson: bundle.aoiGeoJson,
		features: bundle.activeFeatures,
	});

	const insetWidthMm = lockedFrame.layout.footerBlocksMm[1] - 5.2;
	const insetHeightMm = params.paperFormat === 'A3' ? 49.0 : 34.5;

	const ibgeInsetSvg = renderIbgeInsetMapSvg({
		widthMm: Number(insetWidthMm.toFixed(1)),
		heightMm: insetHeightMm,
		stateUf: bundle.stateUf,
		stateName: bundle.ibgeInset.stateName,
		stateGeom: bundle.ibgeInset.stateGeom,
		municipalities: bundle.ibgeInset.municipalities,
		primaryMunicipalityIbge: bundle.primaryMunicipalityIbge,
		primaryMunicipalityName: bundle.primaryMunicipalityName,
		aoiCenterLonLat: bundle.aoiCenterLonLat,
	});

	const html = await buildCartographicPlateHtml({
		bundle,
		frame: lockedFrame,
		paperFormat: params.paperFormat,
		t0PanelSvg,
		t1PanelSvg,
		ibgeInsetSvg,
		issuer: params.issuer,
		observations: params.observations,
		datasetFingerprintSha256: params.datasetFingerprintSha256,
		emittedAt: params.emittedAt ?? new Date(),
	});

	const rendered = await renderHtmlToCartographicPdf(html, params.paperFormat);

	return {
		pdfBuffer: rendered.pdfBuffer,
		pdfSha256: rendered.pdfSha256,
		pdfSizeBytes: rendered.pdfSizeBytes,
		paperFormat: params.paperFormat,
		cartographicScale: lockedFrame.scaleDenominator,
		lockedFrame,
		blockedRequests: rendered.blockedRequests,
		bundle,
	};
}
