import type { PaperFormat, RasterType } from '../../../config/db/schema/enums.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/loggerConfig.js';
import cartographyRepository, {
	type CartographyRunBundle,
} from '../../../repository/cartographyRepository.js';
import { storageRepository } from '../../../repository/storageRepository.js';
import type { SafeFetchOptions } from '../../helpers/antiSsrfHttp.js';
import { DomainError } from '../../helpers/domainError.js';
import { createCanonicalGrid } from '../core/canonicalGrid.js';
import {
	discoverLocalWaybackVintages,
	fetchWaybackCatalog,
	selectBestWaybackPair,
	type WaybackVintageItem,
} from '../waybackClient.js';
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
	MIN_HIRES_SCALE_DENOMINATOR,
} from './scaleAndLayout.js';
import { renderMapPanelSvg } from './utmGridSvg.js';
import { composeWaybackUtmFramePngDataUri } from './waybackPlateComposer.js';

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
	t0WaybackReleaseNum?: number | null;
	t1WaybackReleaseNum?: number | null;
	enableWayback?: boolean;
	waybackFetchOptions?: SafeFetchOptions;
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
	let lockedFrame = computeLockedCartographicFrame(bundle.aoiBoundsUtm, params.paperFormat);

	const maskMeta = bundle.rastersByType.delta_ndvi_mask;
	const preloaded = params.preloadedRasterBuffers;
	const targetW = lockedFrame.layout.mapInnerWidthPx;
	const targetH = lockedFrame.layout.mapInnerHeightPx;

	let t0RgbDataUri: string | null = null;
	let t1RgbDataUri: string | null = null;
	let visualBasemapSource: { t0Label: string; t1Label: string; isHiRes: boolean } | null = null;

	const shouldTryWayback =
		params.enableWayback ?? (env.ENABLE_WAYBACK_HIRES && env.NODE_ENV !== 'test');
	if (shouldTryWayback) {
		try {
			const discovery = await discoverLocalWaybackVintages({
				lon: bundle.aoiCenterLonLat[0],
				lat: bundle.aoiCenterLonLat[1],
				safeFetchOptions: params.waybackFetchOptions,
			});
			const autoPair = selectBestWaybackPair(
				discovery.vintages,
				bundle.t0AcquiredAt,
				bundle.t1AcquiredAt,
			);

			const resolveVintage = async (
				requestedRelease: number | null | undefined,
				fallbackVintage: WaybackVintageItem | null,
			): Promise<WaybackVintageItem | null> => {
				if (!requestedRelease) return fallbackVintage;
				const inLocal = discovery.vintages.find((v) => v.releaseNum === requestedRelease);
				if (inLocal) return inLocal;
				const catalog = await fetchWaybackCatalog(params.waybackFetchOptions);
				const inGlobal = catalog.find((c) => c.releaseNum === requestedRelease);
				if (!inGlobal) return fallbackVintage;
				return {
					releaseNum: inGlobal.releaseNum,
					itemId: inGlobal.itemId,
					itemTitle: inGlobal.itemTitle,
					releaseDate: inGlobal.releaseDate,
					captureDate: null,
					effectiveDate: inGlobal.releaseDate,
					resolutionM: null,
					providerLabel: null,
					maxZoom: discovery.maxZoom,
					tileUrlTemplate: inGlobal.tileUrlTemplate,
				};
			};

			const [t0Vintage, t1Vintage] = await Promise.all([
				resolveVintage(params.t0WaybackReleaseNum, autoPair.selectedT0),
				resolveVintage(params.t1WaybackReleaseNum, autoPair.selectedT1),
			]);

			if (t0Vintage && t1Vintage) {
				const hiresFrame = computeLockedCartographicFrame(
					bundle.aoiBoundsUtm,
					params.paperFormat,
					MIN_HIRES_SCALE_DENOMINATOR,
				);
				const [uri0, uri1] = await Promise.all([
					composeWaybackUtmFramePngDataUri({
						releaseNum: t0Vintage.releaseNum,
						maxZoom: t0Vintage.maxZoom,
						utmSrid: bundle.utmSrid,
						mapBboxUtm: hiresFrame.mapBboxUtm,
						targetWidthPx: targetW,
						targetHeightPx: targetH,
						safeFetchOptions: params.waybackFetchOptions,
					}),
					composeWaybackUtmFramePngDataUri({
						releaseNum: t1Vintage.releaseNum,
						maxZoom: t1Vintage.maxZoom,
						utmSrid: bundle.utmSrid,
						mapBboxUtm: hiresFrame.mapBboxUtm,
						targetWidthPx: targetW,
						targetHeightPx: targetH,
						safeFetchOptions: params.waybackFetchOptions,
					}),
				]);

				lockedFrame = hiresFrame;
				t0RgbDataUri = uri0;
				t1RgbDataUri = uri1;
				const formatRes = (v: WaybackVintageItem) =>
					v.resolutionM ? ` · ${v.resolutionM.toFixed(2).replace('.', ',')} m/px` : '';
				visualBasemapSource = {
					t0Label: `Esri Wayback (${t0Vintage.effectiveDate}${formatRes(t0Vintage)})`,
					t1Label: `Esri Wayback (${t1Vintage.effectiveDate}${formatRes(t1Vintage)})`,
					isHiRes: true,
				};
			}
		} catch (err) {
			logger.warn(
				{ runId: params.runId, err },
				'Fallback para raster Sentinel-2 na Carta-Imagem PDF após indisponibilidade do Wayback.',
			);
		}
	}

	const needSentinelRasters = !t0RgbDataUri || !t1RgbDataUri;
	const [t0RgbObj, t1RgbObj, deltaMaskObj] = await Promise.all([
		needSentinelRasters
			? preloaded?.t0_rgb
				? Promise.resolve({ buffer: preloaded.t0_rgb })
				: storageRepository.getPrivateObjectBytes(t0RgbMeta.storageKey, t0RgbMeta.storageBucket)
			: Promise.resolve(null),
		needSentinelRasters
			? preloaded?.t1_rgb
				? Promise.resolve({ buffer: preloaded.t1_rgb })
				: storageRepository.getPrivateObjectBytes(t1RgbMeta.storageKey, t1RgbMeta.storageBucket)
			: Promise.resolve(null),
		preloaded?.delta_ndvi_mask
			? Promise.resolve({ buffer: preloaded.delta_ndvi_mask })
			: maskMeta
				? storageRepository.getPrivateObjectBytes(maskMeta.storageKey, maskMeta.storageBucket)
				: Promise.resolve(null),
	]);

	if (needSentinelRasters) {
		const [sentinelT0Uri, sentinelT1Uri] = await Promise.all([
			composePrintFramePngDataUri({
				sourcePngBuffer: t0RgbObj!.buffer,
				gridBboxUtm,
				mapBboxUtm: lockedFrame.mapBboxUtm,
				targetWidthPx: targetW,
				targetHeightPx: targetH,
			}),
			composePrintFramePngDataUri({
				sourcePngBuffer: t1RgbObj!.buffer,
				gridBboxUtm,
				mapBboxUtm: lockedFrame.mapBboxUtm,
				targetWidthPx: targetW,
				targetHeightPx: targetH,
			}),
		]);
		t0RgbDataUri = sentinelT0Uri;
		t1RgbDataUri = sentinelT1Uri;
	}

	const [cloudOverlayT1, cloudOverlayT0] = await Promise.all([
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
		rgbDataUri: t0RgbDataUri!,
		cloudOverlayDataUri: cloudOverlayT0,
		aoiGeoJson: bundle.aoiGeoJson,
		features: [],
	});

	const t1PanelSvg = renderMapPanelSvg({
		panelKey: 't1',
		frame: lockedFrame,
		utmSrid: bundle.utmSrid,
		rgbDataUri: t1RgbDataUri!,
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
		visualBasemapSource,
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
