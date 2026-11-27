import type { StacProvider } from '../../../config/db/schema/enums.js';
import { assertSafeWhitelistedUrl } from '../../helpers/antiSsrfHttp.js';
import { DomainError } from '../../helpers/domainError.js';
import { STAC_PROVIDER_CONFIG, type StacAssetRaw, type StacItemRaw } from '../stacClient.js';

export type OpticalBandName = 'BLUE' | 'GREEN' | 'RED' | 'NIR';
export type LogicalBandName = OpticalBandName | 'SCL';

export interface RadiometricCalibration {
	scale: number;
	offsetFinal: number;
	nodataValues: readonly number[];
	boaOffsetApplied: boolean;
	source:
		| 'stac_raster_bands'
		| 'inpe_bdc_default'
		| 'earthsearch_flag'
		| 'processing_baseline'
		| 'default_scale';
}

export interface ResolvedBandAsset {
	assetKey: string;
	asset: StacAssetRaw;
	href: string;
}

// Spec Parte I — Seção 2.1: Mapeamento estrito de bandas por provedor STAC
export function resolveBandAsset(
	item: StacItemRaw,
	provider: StacProvider,
	band: LogicalBandName,
): ResolvedBandAsset {
	const cfg = STAC_PROVIDER_CONFIG[provider];
	let candidateKeys: readonly string[];

	switch (band) {
		case 'BLUE':
			candidateKeys = cfg.opticalBandAssetKeys.blue;
			break;
		case 'GREEN':
			candidateKeys = cfg.opticalBandAssetKeys.green;
			break;
		case 'RED':
			candidateKeys = cfg.opticalBandAssetKeys.red;
			break;
		case 'NIR':
			candidateKeys = cfg.opticalBandAssetKeys.nir;
			break;
		case 'SCL':
			candidateKeys = cfg.sclAssetKeys;
			break;
	}

	for (const key of candidateKeys) {
		const asset = item.assets?.[key];
		if (asset?.href) {
			const resolvedHref = new URL(asset.href, `${cfg.baseUrl}/`).toString();
			assertSafeWhitelistedUrl(resolvedHref);
			return { assetKey: key, asset, href: resolvedHref };
		}
	}

	throw new DomainError(
		'ERR_STAC_ITEM_INVALID',
		`Asset obrigatório da banda '${band}' ausente no item STAC '${item.id}' (${provider}).`,
	);
}

// Spec Parte I — Seção 3.2: Cascata determinística para normalização radiométrica BOA (Baseline 04.00+)
export function resolveOpticalRadiometry(
	item: StacItemRaw,
	provider: StacProvider,
	band: OpticalBandName,
): RadiometricCalibration {
	const { asset } = resolveBandAsset(item, provider, band);
	const bandMeta = asset['raster:bands']?.[0];

	const nodataSet = new Set<number>([0]);
	if (typeof bandMeta?.nodata === 'number' && Number.isFinite(bandMeta.nodata)) {
		nodataSet.add(bandMeta.nodata);
	}
	const nodataValues = Array.from(nodataSet);

	const scale =
		typeof bandMeta?.scale === 'number' && Number.isFinite(bandMeta.scale)
			? bandMeta.scale
			: 0.0001;

	// Prioridade 1 — INPE Brazil Data Cube padronizado por fator 10000 (offset = 0)
	if (provider === 'inpe_bdc') {
		return {
			scale,
			offsetFinal: 0,
			nodataValues,
			boaOffsetApplied: false,
			source: 'inpe_bdc_default',
		};
	}

	// Prioridade 2 — Flag explícita earthsearch:boa_offset_applied (evita dupla subtração quando raster:bands mantém offset=-0.1 estático)
	const earthSearchFlag = item.properties['earthsearch:boa_offset_applied'];
	if (earthSearchFlag === true) {
		return {
			scale,
			offsetFinal: 0,
			nodataValues,
			boaOffsetApplied: true,
			source: 'earthsearch_flag',
		};
	}
	if (earthSearchFlag === false) {
		const rawBaseline = item.properties['s2:processing_baseline'];
		const baselineNum =
			rawBaseline !== undefined && rawBaseline !== null
				? Number.parseFloat(String(rawBaseline))
				: Number.NaN;
		if (Number.isFinite(baselineNum) && baselineNum >= 4.0) {
			const fallbackOffset =
				typeof bandMeta?.offset === 'number' && bandMeta.offset < 0
					? bandMeta.offset
					: -1000 * scale;
			return {
				scale,
				offsetFinal: fallbackOffset,
				nodataValues,
				boaOffsetApplied: true,
				source: 'earthsearch_flag',
			};
		}
		return {
			scale,
			offsetFinal: 0,
			nodataValues,
			boaOffsetApplied: false,
			source: 'earthsearch_flag',
		};
	}

	// Prioridade 3 — Metadado explícito raster:bands (quando não há flag earthsearch:boa_offset_applied)
	if (typeof bandMeta?.scale === 'number' && typeof bandMeta?.offset === 'number') {
		return {
			scale: bandMeta.scale,
			offsetFinal: bandMeta.offset,
			nodataValues,
			boaOffsetApplied: bandMeta.offset < 0,
			source: 'stac_raster_bands',
		};
	}

	// Prioridade 4 — s2:processing_baseline >= 4.00
	const rawBaseline = item.properties['s2:processing_baseline'];
	if (rawBaseline !== undefined && rawBaseline !== null) {
		const baselineNum = Number.parseFloat(String(rawBaseline));
		if (Number.isFinite(baselineNum)) {
			const hasOffset = baselineNum >= 4.0;
			return {
				scale,
				offsetFinal: hasOffset ? -1000 * scale : 0,
				nodataValues,
				boaOffsetApplied: hasOffset,
				source: 'processing_baseline',
			};
		}
	}

	// Fallback seguro
	return {
		scale,
		offsetFinal: 0,
		nodataValues,
		boaOffsetApplied: false,
		source: 'default_scale',
	};
}

// Spec Parte I — Seção 3.1: Conversão DN -> ρ_BOA em [0.0, 1.0] (NaN para NoData)
export function dnToBoaReflectance(dn: number, calibration: RadiometricCalibration): number {
	if (!Number.isFinite(dn) || calibration.nodataValues.includes(dn)) {
		return Number.NaN;
	}
	const rho = dn * calibration.scale + calibration.offsetFinal;
	if (rho <= 0) return 0;
	if (rho >= 1) return 1;
	return rho;
}
