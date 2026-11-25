import type { StacProvider } from '../../config/db/schema/enums.js';
import {
	assertSafeWhitelistedUrl,
	type SafeFetchOptions,
	safeExternalFetch,
} from '../helpers/antiSsrfHttp.js';
import { DomainError } from '../helpers/domainError.js';
import type { AoiPolygonGeoJson } from '../validation/caseValidation.js';

const ITEM_ID_STRICT_REGEX = /^[A-Za-z0-9._-]+$/;

export const STAC_PROVIDER_CONFIG: Record<
	StacProvider,
	{
		baseUrl: string;
		defaultCollection: string;
		sclAssetKeys: readonly string[];
		opticalBandAssetKeys: {
			blue: readonly string[];
			green: readonly string[];
			red: readonly string[];
			nir: readonly string[];
		};
		previewAssetKeys: readonly string[];
	}
> = {
	aws_earth_search: {
		baseUrl: 'https://earth-search.aws.element84.com/v1',
		defaultCollection: 'sentinel-2-l2a',
		sclAssetKeys: ['scl', 'SCL'],
		opticalBandAssetKeys: {
			blue: ['blue', 'B02'],
			green: ['green', 'B03'],
			red: ['red', 'B04'],
			nir: ['nir', 'B08'],
		},
		previewAssetKeys: ['thumbnail', 'overview'],
	},
	inpe_bdc: {
		baseUrl: 'https://data.inpe.br/bdc/stac/v1',
		defaultCollection: 'S2_L2A-1',
		sclAssetKeys: ['SCL', 'scl'],
		opticalBandAssetKeys: {
			blue: ['B02', 'blue'],
			green: ['B03', 'green'],
			red: ['B04', 'red'],
			nir: ['B08', 'nir'],
		},
		previewAssetKeys: ['thumbnail', 'TCI'],
	},
};

export interface StacRasterBandMeta {
	scale?: number;
	offset?: number;
	nodata?: number | string;
}

export interface StacAssetRaw {
	href: string;
	type?: string;
	roles?: string[];
	'raster:bands'?: StacRasterBandMeta[];
}

export interface StacItemRaw {
	id: string;
	collection?: string;
	bbox?: number[];
	geometry?: {
		type: string;
		coordinates: unknown;
	};
	properties: Record<string, unknown>;
	assets: Record<string, StacAssetRaw>;
}

export interface NormalizedStacItem {
	id: string;
	provider: StacProvider;
	collection: string;
	acquiredAt: string;
	passDateUtc: string; // YYYY-MM-DD
	mgrsTile: string;
	globalCloudPct: number;
	processingBaseline: string | null;
	boaOffsetApplied: boolean;
	projEpsg: number | null;
	sclHref: string;
	thumbnailHref: string | null;
	raw: StacItemRaw;
}

export function assertValidStacItemId(itemId: string): string {
	const trimmed = itemId.trim();
	if (trimmed.length === 0 || trimmed.length > 140 || !ITEM_ID_STRICT_REGEX.test(trimmed)) {
		throw new DomainError(
			'ERR_STAC_ITEM_INVALID',
			`Identificador de item STAC inválido ('${itemId}').`,
			{
				invalidParams: [{ field: 'itemId', reason: 'INVALID_STAC_ITEM_ID' }],
			},
		);
	}
	return trimmed;
}

export function extractMgrsTile(item: StacItemRaw): string {
	const props = item.properties;
	if (typeof props['s2:mgrs_tile'] === 'string' && props['s2:mgrs_tile'].trim()) {
		return props['s2:mgrs_tile'].trim().toUpperCase();
	}
	if (typeof props['grid:code'] === 'string' && props['grid:code'].startsWith('MGRS-')) {
		return props['grid:code'].slice('MGRS-'.length).toUpperCase();
	}
	if (
		(typeof props['mgrs:utm_zone'] === 'number' || typeof props['mgrs:utm_zone'] === 'string') &&
		typeof props['mgrs:latitude_band'] === 'string' &&
		typeof props['mgrs:grid_square'] === 'string'
	) {
		return `${props['mgrs:utm_zone']}${props['mgrs:latitude_band']}${props['mgrs:grid_square']}`.toUpperCase();
	}

	const idMatch =
		/S2[A-C]_(\d{1,2}[A-Z]{3})_\d{8}/i.exec(item.id) ?? /_T(\d{2}[A-Z]{3})_/i.exec(item.id);
	if (idMatch?.[1]) {
		return idMatch[1].toUpperCase();
	}

	return item.id;
}

// Spec Seção 3.2: Detecta deterministicamente se o offset radiométrico BOA (+1000 / -0.1) aplica-se à cena
export function detectBoaOffsetApplied(item: StacItemRaw, provider: StacProvider): {
	processingBaseline: string | null;
	boaOffsetApplied: boolean;
} {
	const rawBaseline = item.properties['s2:processing_baseline'];
	const processingBaseline =
		typeof rawBaseline === 'string' && rawBaseline.trim().length > 0 ? rawBaseline.trim() : null;

	const cfg = STAC_PROVIDER_CONFIG[provider];
	for (const redKey of cfg.opticalBandAssetKeys.red) {
		const bandMeta = item.assets[redKey]?.['raster:bands']?.[0];
		if (bandMeta && typeof bandMeta.offset === 'number') {
			return {
				processingBaseline,
				boaOffsetApplied: bandMeta.offset < 0,
			};
		}
	}

	if (item.properties['earthsearch:boa_offset_applied'] === true) {
		return { processingBaseline, boaOffsetApplied: true };
	}
	if (item.properties['earthsearch:boa_offset_applied'] === false) {
		return { processingBaseline, boaOffsetApplied: false };
	}

	if (processingBaseline) {
		const num = Number.parseFloat(processingBaseline);
		if (Number.isFinite(num) && num >= 4.0) {
			return { processingBaseline, boaOffsetApplied: true };
		}
	}

	return { processingBaseline, boaOffsetApplied: false };
}

function resolveWhitelistedAssetHref(rawHref: string, baseUrl: string): string {
	const resolved = new URL(rawHref, `${baseUrl}/`).toString();
	assertSafeWhitelistedUrl(resolved);
	return resolved;
}

export function normalizeStacItem(
	item: StacItemRaw,
	provider: StacProvider,
): NormalizedStacItem | null {
	const id = assertValidStacItemId(item.id);
	const cfg = STAC_PROVIDER_CONFIG[provider];
	const collection =
		typeof item.collection === 'string' && item.collection.trim()
			? item.collection.trim()
			: cfg.defaultCollection;

	const dtRaw = item.properties.datetime;
	if (typeof dtRaw !== 'string') return null;
	const dt = new Date(dtRaw);
	if (Number.isNaN(dt.getTime())) return null;

	let sclHref: string | null = null;
	for (const key of cfg.sclAssetKeys) {
		const asset = item.assets?.[key];
		if (asset?.href) {
			sclHref = resolveWhitelistedAssetHref(asset.href, cfg.baseUrl);
			break;
		}
	}
	if (!sclHref) {
		return null;
	}

	let thumbnailHref: string | null = null;
	for (const key of cfg.previewAssetKeys) {
		const asset = item.assets?.[key];
		if (asset?.href) {
			try {
				thumbnailHref = resolveWhitelistedAssetHref(asset.href, cfg.baseUrl);
				break;
			} catch {
				thumbnailHref = null;
			}
		}
	}

	const cloudRaw = item.properties['eo:cloud_cover'];
	const globalCloudPct =
		typeof cloudRaw === 'number' && Number.isFinite(cloudRaw)
			? Number(Math.max(0, Math.min(100, cloudRaw)).toFixed(2))
			: 100;

	const projEpsgRaw = item.properties['proj:epsg'];
	const projEpsg =
		typeof projEpsgRaw === 'number' && Number.isInteger(projEpsgRaw) ? projEpsgRaw : null;

	const { processingBaseline, boaOffsetApplied } = detectBoaOffsetApplied(item, provider);
	const isoUtc = dt.toISOString();

	return {
		id,
		provider,
		collection,
		acquiredAt: isoUtc,
		passDateUtc: isoUtc.slice(0, 10),
		mgrsTile: extractMgrsTile(item),
		globalCloudPct,
		processingBaseline,
		boaOffsetApplied,
		projEpsg,
		sclHref,
		thumbnailHref,
		raw: item,
	};
}

export interface StacCatalogAdapter {
	searchItems(params: {
		provider: StacProvider;
		aoiGeoJson: AoiPolygonGeoJson;
		fromDate: string;
		toDate: string;
		maxGlobalCloudPct: number;
	}): Promise<NormalizedStacItem[]>;

	getItem(params: {
		provider: StacProvider;
		collection: string;
		itemId: string;
	}): Promise<NormalizedStacItem>;

	fetchAssetBytes(href: string): Promise<{ contentType: string; buffer: Buffer }>;
}

export class HttpStacCatalogAdapter implements StacCatalogAdapter {
	private readonly safeOptions: SafeFetchOptions;

	constructor(safeOptions: SafeFetchOptions = {}) {
		this.safeOptions = safeOptions;
	}

	async searchItems(params: {
		provider: StacProvider;
		aoiGeoJson: AoiPolygonGeoJson;
		fromDate: string;
		toDate: string;
		maxGlobalCloudPct: number;
	}): Promise<NormalizedStacItem[]> {
		const cfg = STAC_PROVIDER_CONFIG[params.provider];
		const searchUrl = `${cfg.baseUrl}/search`;

		const payload: Record<string, unknown> = {
			collections: [cfg.defaultCollection],
			intersects: params.aoiGeoJson,
			datetime: `${params.fromDate}T00:00:00Z/${params.toDate}T23:59:59Z`,
			limit: 80,
		};

		if (params.provider === 'aws_earth_search') {
			payload.query = {
				'eo:cloud_cover': { lte: params.maxGlobalCloudPct },
			};
		}

		const res = await safeExternalFetch(
			searchUrl,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/geo+json, application/json',
				},
				body: JSON.stringify(payload),
			},
			this.safeOptions,
		);

		if (!res.ok) {
			throw new DomainError(
				'ERR_UPSTREAM_STAC_UNAVAILABLE',
				`Catálogo STAC '${params.provider}' respondeu com status HTTP ${res.status}.`,
			);
		}

		const body = (await res.json()) as { features?: StacItemRaw[] };
		const features = Array.isArray(body.features) ? body.features : [];

		const normalized: NormalizedStacItem[] = [];
		for (const feat of features) {
			const item = normalizeStacItem(feat, params.provider);
			if (!item) continue;
			if (item.globalCloudPct > params.maxGlobalCloudPct) continue;
			normalized.push(item);
		}

		return normalized;
	}

	async getItem(params: {
		provider: StacProvider;
		collection: string;
		itemId: string;
	}): Promise<NormalizedStacItem> {
		const cleanItemId = assertValidStacItemId(params.itemId);
		const cleanCollection = assertValidStacItemId(params.collection);
		const cfg = STAC_PROVIDER_CONFIG[params.provider];
		const itemUrl = `${cfg.baseUrl}/collections/${encodeURIComponent(cleanCollection)}/items/${encodeURIComponent(cleanItemId)}`;

		const res = await safeExternalFetch(
			itemUrl,
			{
				method: 'GET',
				headers: { Accept: 'application/geo+json, application/json' },
			},
			this.safeOptions,
		);

		if (res.status === 404) {
			throw new DomainError(
				'ERR_STAC_ITEM_INVALID',
				`Item STAC '${cleanItemId}' não encontrado no provedor '${params.provider}'.`,
			);
		}

		if (!res.ok) {
			throw new DomainError(
				'ERR_UPSTREAM_STAC_UNAVAILABLE',
				`Falha ao consultar item STAC '${cleanItemId}' em '${params.provider}' (HTTP ${res.status}).`,
			);
		}

		const raw = (await res.json()) as StacItemRaw;
		const normalized = normalizeStacItem(raw, params.provider);
		if (!normalized) {
			throw new DomainError(
				'ERR_STAC_ITEM_INVALID',
				`Metadados ou assets obrigatórios ausentes no item STAC '${cleanItemId}'.`,
			);
		}

		return normalized;
	}

	async fetchAssetBytes(href: string): Promise<{ contentType: string; buffer: Buffer }> {
		const res = await safeExternalFetch(href, { method: 'GET' }, this.safeOptions);
		if (!res.ok) {
			throw new DomainError(
				'ERR_UPSTREAM_STAC_UNAVAILABLE',
				`Falha ao obter preview satelital (HTTP ${res.status}).`,
			);
		}
		const contentType = res.headers.get('content-type') ?? 'image/jpeg';
		const arrayBuf = await res.arrayBuffer();
		return {
			contentType,
			buffer: Buffer.from(arrayBuf),
		};
	}
}
