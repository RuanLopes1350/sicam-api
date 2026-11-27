import { WAYBACK_WHITELISTED_HOSTS } from '../../config/presets.js';
import { logger } from '../../config/loggerConfig.js';
import { safeExternalFetch, type SafeFetchOptions } from '../helpers/antiSsrfHttp.js';

export interface WaybackVintageItem {
	releaseNum: number;
	itemId: string;
	itemTitle: string;
	releaseDate: string;
	captureDate: string | null;
	effectiveDate: string;
	resolutionM: number | null;
	providerLabel: string | null;
	maxZoom: number;
	tileUrlTemplate: string;
}

export interface WaybackCatalogEntry {
	releaseNum: number;
	itemId: string;
	itemTitle: string;
	releaseDate: string;
	metadataLayerUrl: string | null;
	tileUrlTemplate: string;
}

export interface LocalWaybackDiscoveryResult {
	maxZoom: number;
	vintages: WaybackVintageItem[];
}

const WAYBACK_CONFIG_URL =
	'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
const WAYBACK_TILE_BASE_URL =
	'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile';
const WAYBACK_TILEMAP_BASE_URL =
	'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap';

const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
const LOCAL_VINTAGE_CACHE_TTL_MS = 30 * 60 * 1000;

let catalogCache: { expiresAt: number; entries: WaybackCatalogEntry[] } | null = null;
const localVintageCache = new Map<
	string,
	{ expiresAt: number; result: LocalWaybackDiscoveryResult }
>();

export function buildWaybackTileUrlTemplate(releaseNum: number): string {
	return `${WAYBACK_TILE_BASE_URL}/${releaseNum}/{z}/{y}/{x}`;
}

export function buildWaybackTileUrl(
	releaseNum: number,
	z: number,
	y: number,
	x: number,
): string {
	return `${WAYBACK_TILE_BASE_URL}/${releaseNum}/${z}/${y}/${x}`;
}

export function lonLatToWebMercatorPixel(
	lon: number,
	lat: number,
	zoom: number,
): { pxX: number; pxY: number } {
	const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
	const scalePx = 256 * 2 ** zoom;
	const pxX = ((lon + 180) / 360) * scalePx;
	const latRad = (clampedLat * Math.PI) / 180;
	const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
	const pxY = (0.5 - mercN / (2 * Math.PI)) * scalePx;
	return { pxX, pxY };
}

export function lonLatToWebMercatorTile(
	lon: number,
	lat: number,
	zoom: number,
): { z: number; tx: number; ty: number } {
	const { pxX, pxY } = lonLatToWebMercatorPixel(lon, lat, zoom);
	const maxTile = 2 ** zoom - 1;
	const tx = Math.max(0, Math.min(maxTile, Math.floor(pxX / 256)));
	const ty = Math.max(0, Math.min(maxTile, Math.floor(pxY / 256)));
	return { z: zoom, tx, ty };
}

export async function runWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) {
		return [];
	}
	const results = new Array<R>(items.length);
	let cursor = 0;
	const limit = Math.max(1, Math.min(concurrency, items.length));

	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (true) {
				const idx = cursor;
				cursor += 1;
				if (idx >= items.length) {
					return;
				}
				results[idx] = await worker(items[idx]!, idx);
			}
		}),
	);

	return results;
}

function sanitizeMetadataLayerUrl(rawUrl: unknown): string | null {
	if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
		return null;
	}
	try {
		const parsed = new URL(rawUrl.trim());
		if (parsed.protocol !== 'https:' || !WAYBACK_WHITELISTED_HOSTS.has(parsed.hostname.toLowerCase())) {
			return null;
		}
		return parsed.toString().replace(/\/+$/, '');
	} catch {
		return null;
	}
}

function formatSrcDateNumeric(raw: unknown): string | null {
	if (typeof raw !== 'number' && typeof raw !== 'string') {
		return null;
	}
	const str = String(Math.trunc(Number(raw)));
	if (!/^\d{8}$/.test(str)) {
		return null;
	}
	return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
}

function formatSrcDateEpoch(raw: unknown): string | null {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		return null;
	}
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) {
		return null;
	}
	return d.toISOString().slice(0, 10);
}

/**
 * Baixa e valida o catálogo histórico global do Esri World Imagery Wayback via whitelist Anti-SSRF.
 */
export async function fetchWaybackCatalog(
	safeFetchOptions?: SafeFetchOptions,
): Promise<WaybackCatalogEntry[]> {
	const useCache = !safeFetchOptions?.fetchFn;
	if (useCache && catalogCache && catalogCache.expiresAt > Date.now()) {
		return catalogCache.entries;
	}

	const response = await safeExternalFetch(
		WAYBACK_CONFIG_URL,
		{ method: 'GET' },
		{
			timeoutMs: 10_000,
			maxAttempts: 2,
			...safeFetchOptions,
			allowedHosts: WAYBACK_WHITELISTED_HOSTS,
		},
	);

	if (!response.ok) {
		throw new Error(`Falha ao obter catálogo Wayback (HTTP ${response.status}).`);
	}

	const raw = (await response.json()) as Record<
		string,
		{
			itemID?: unknown;
			itemTitle?: unknown;
			metadataLayerUrl?: unknown;
		}
	>;

	const entries: WaybackCatalogEntry[] = [];
	for (const [key, item] of Object.entries(raw ?? {})) {
		const releaseNum = Number(key);
		if (!Number.isInteger(releaseNum) || releaseNum <= 0) {
			continue;
		}
		const itemTitle = typeof item?.itemTitle === 'string' ? item.itemTitle.trim() : '';
		const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(itemTitle);
		if (!dateMatch) {
			continue;
		}
		const releaseDate = dateMatch[1]!;
		const itemId =
			typeof item?.itemID === 'string' && item.itemID.trim()
				? item.itemID.trim()
				: String(releaseNum);

		entries.push({
			releaseNum,
			itemId,
			itemTitle: itemTitle || `World Imagery (Wayback ${releaseDate})`,
			releaseDate,
			metadataLayerUrl: sanitizeMetadataLayerUrl(item?.metadataLayerUrl),
			tileUrlTemplate: buildWaybackTileUrlTemplate(releaseNum),
		});
	}

	entries.sort((a, b) => {
		const byDate = b.releaseDate.localeCompare(a.releaseDate);
		return byDate !== 0 ? byDate : b.releaseNum - a.releaseNum;
	});

	if (useCache && entries.length > 0) {
		catalogCache = {
			expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
			entries,
		};
	}

	return entries;
}

interface ArcGisTileMapResponse {
	data?: unknown;
	select?: unknown;
}

async function fetchTileMapNode(
	releaseNum: number,
	z: number,
	ty: number,
	tx: number,
	safeFetchOptions?: SafeFetchOptions,
): Promise<ArcGisTileMapResponse | null> {
	const url = `${WAYBACK_TILEMAP_BASE_URL}/${releaseNum}/${z}/${ty}/${tx}?f=json`;
	const response = await safeExternalFetch(
		url,
		{ method: 'GET' },
		{
			timeoutMs: 6_000,
			maxAttempts: 2,
			...safeFetchOptions,
			allowedHosts: WAYBACK_WHITELISTED_HOSTS,
		},
	);
	if (!response.ok) {
		return null;
	}
	return (await response.json()) as ArcGisTileMapResponse;
}

async function queryReleaseCaptureMetadata(
	entry: WaybackCatalogEntry,
	lon: number,
	lat: number,
	zoom: number,
	safeFetchOptions?: SafeFetchOptions,
): Promise<{
	captureDate: string | null;
	resolutionM: number | null;
	providerLabel: string | null;
}> {
	if (!entry.metadataLayerUrl) {
		return { captureDate: null, resolutionM: null, providerLabel: null };
	}

	const layerIdx = Math.max(0, Math.min(13, 23 - zoom));
	const url = `${entry.metadataLayerUrl}/${layerIdx}/query?geometry=${encodeURIComponent(`${lon},${lat}`)}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=SRC_DATE,SRC_DATE2,SRC_RES,NICE_NAME,NICE_DESC&returnGeometry=false&f=json`;

	try {
		const response = await safeExternalFetch(
			url,
			{ method: 'GET' },
			{
				timeoutMs: 4_500,
				maxAttempts: 1,
				...safeFetchOptions,
				allowedHosts: WAYBACK_WHITELISTED_HOSTS,
			},
		);
		if (!response.ok) {
			return { captureDate: null, resolutionM: null, providerLabel: null };
		}
		const payload = (await response.json()) as {
			features?: Array<{ attributes?: Record<string, unknown> }>;
		};
		const attrs = payload.features?.[0]?.attributes;
		if (!attrs) {
			return { captureDate: null, resolutionM: null, providerLabel: null };
		}

		const captureDate =
			formatSrcDateEpoch(attrs.SRC_DATE2) ?? formatSrcDateNumeric(attrs.SRC_DATE);
		const rawRes = typeof attrs.SRC_RES === 'number' ? attrs.SRC_RES : Number(attrs.SRC_RES);
		const resolutionM =
			Number.isFinite(rawRes) && rawRes > 0 ? Number(rawRes.toFixed(2)) : null;

		const desc = typeof attrs.NICE_DESC === 'string' ? attrs.NICE_DESC.trim() : '';
		const niceName = typeof attrs.NICE_NAME === 'string' ? attrs.NICE_NAME.trim() : '';
		const providerParts = [desc, niceName].filter(Boolean);
		const providerLabel = providerParts.length > 0 ? providerParts.join(' · ') : null;

		return { captureDate, resolutionM, providerLabel };
	} catch {
		return { captureDate: null, resolutionM: null, providerLabel: null };
	}
}

/**
 * Descobre apenas as safras históricas que contêm atualizações locais reais no tile da AOI
 * (evitando safras repetidas entre os 199 releases globais) e consulta metadados SRC_DATE2/SRC_RES.
 */
export async function discoverLocalWaybackVintages(params: {
	lon: number;
	lat: number;
	maxHops?: number;
	safeFetchOptions?: SafeFetchOptions;
}): Promise<LocalWaybackDiscoveryResult> {
	const { lon, lat, maxHops = 25, safeFetchOptions } = params;
	const useCache = !safeFetchOptions?.fetchFn;

	const catalog = await fetchWaybackCatalog(safeFetchOptions);
	if (catalog.length === 0) {
		return { maxZoom: 17, vintages: [] };
	}

	const byNum = new Map<number, WaybackCatalogEntry>();
	const idxByNum = new Map<number, number>();
	catalog.forEach((entry, i) => {
		byNum.set(entry.releaseNum, entry);
		idxByNum.set(entry.releaseNum, i);
	});

	let bestZoom = 17;
	let firstTm: ArcGisTileMapResponse | null = null;
	let bestTx = 0;
	let bestTy = 0;

	for (const z of [17, 16, 15, 14]) {
		const tile = lonLatToWebMercatorTile(lon, lat, z);
		const tm = await fetchTileMapNode(
			catalog[0]!.releaseNum,
			z,
			tile.ty,
			tile.tx,
			safeFetchOptions,
		).catch(() => null);
		if (tm && Array.isArray(tm.data) && tm.data[0] === 1) {
			bestZoom = z;
			bestTx = tile.tx;
			bestTy = tile.ty;
			firstTm = tm;
			break;
		}
	}

	if (!firstTm) {
		return { maxZoom: 17, vintages: [] };
	}

	const cacheKey = `${bestZoom}/${bestTx}/${bestTy}`;
	if (useCache) {
		const cached = localVintageCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.result;
		}
	}

	const discovered: WaybackCatalogEntry[] = [];
	const seenReleases = new Set<number>();
	let idx = 0;

	while (idx < catalog.length && discovered.length < maxHops) {
		const cur = catalog[idx]!;
		const tm =
			idx === 0 && firstTm
				? firstTm
				: await fetchTileMapNode(cur.releaseNum, bestZoom, bestTy, bestTx, safeFetchOptions).catch(
						() => null,
					);

		if (!tm || !Array.isArray(tm.data) || tm.data[0] === 0) {
			break;
		}

		const selectCandidate = Array.isArray(tm.select) ? Number(tm.select[0]) : Number.NaN;
		const selectedNum =
			Number.isInteger(selectCandidate) && selectCandidate > 0 ? selectCandidate : cur.releaseNum;
		const resolved = byNum.get(selectedNum) ?? cur;

		if (!seenReleases.has(resolved.releaseNum)) {
			seenReleases.add(resolved.releaseNum);
			discovered.push(resolved);
		}

		const selIdx = idxByNum.get(resolved.releaseNum);
		idx = Math.max(idx + 1, (selIdx !== undefined ? selIdx : idx) + 1);
	}

	const metaList = await runWithConcurrency(discovered, 6, (entry) =>
		queryReleaseCaptureMetadata(entry, lon, lat, bestZoom, safeFetchOptions),
	);

	const vintages: WaybackVintageItem[] = discovered.map((entry, i) => {
		const meta = metaList[i] ?? { captureDate: null, resolutionM: null, providerLabel: null };
		return {
			releaseNum: entry.releaseNum,
			itemId: entry.itemId,
			itemTitle: entry.itemTitle,
			releaseDate: entry.releaseDate,
			captureDate: meta.captureDate,
			effectiveDate: meta.captureDate ?? entry.releaseDate,
			resolutionM: meta.resolutionM,
			providerLabel: meta.providerLabel,
			maxZoom: bestZoom,
			tileUrlTemplate: entry.tileUrlTemplate,
		};
	});

	const result: LocalWaybackDiscoveryResult = {
		maxZoom: bestZoom,
		vintages,
	};

	if (useCache && vintages.length > 0) {
		localVintageCache.set(cacheKey, {
			expiresAt: Date.now() + LOCAL_VINTAGE_CACHE_TTL_MS,
			result,
		});
	}

	logger.info(
		{ lon, lat, maxZoom: bestZoom, vintagesCount: vintages.length },
		'Safras locais Esri Wayback descobertas.',
	);

	return result;
}

/**
 * Seleciona automaticamente o melhor par histórico (T0 < T1) alinhado às datas da análise Sentinel-2.
 */
export function selectBestWaybackPair(
	vintages: readonly WaybackVintageItem[],
	t0Date: Date,
	t1Date: Date,
): {
	selectedT0: WaybackVintageItem | null;
	selectedT1: WaybackVintageItem | null;
} {
	if (vintages.length === 0) {
		return { selectedT0: null, selectedT1: null };
	}

	const t0Ms = t0Date.getTime();
	const t1Ms = t1Date.getTime();

	const parseEffectiveMs = (v: WaybackVintageItem): number => {
		const ms = Date.parse(v.effectiveDate);
		return Number.isFinite(ms) ? ms : Date.parse(v.releaseDate);
	};

	// Escolhe T1 pela menor distância absoluta em relação à data-alvo Sentinel-2 (empate favorece mais recente)
	let selectedT1 = vintages[0]!;
	let bestT1Dist = Math.abs(parseEffectiveMs(selectedT1) - t1Ms);
	for (const candidate of vintages.slice(1)) {
		const dist = Math.abs(parseEffectiveMs(candidate) - t1Ms);
		if (
			dist < bestT1Dist ||
			(dist === bestT1Dist && candidate.releaseDate > selectedT1.releaseDate)
		) {
			bestT1Dist = dist;
			selectedT1 = candidate;
		}
	}

	if (vintages.length === 1) {
		return { selectedT0: selectedT1, selectedT1 };
	}

	const earlier = vintages.filter((v) => v.releaseDate < selectedT1.releaseDate);
	const others = vintages.filter((v) => v.releaseNum !== selectedT1.releaseNum);
	const marginMs = t0Ms + 120 * 86_400_000;
	const withinT0Margin = earlier.filter((v) => parseEffectiveMs(v) <= marginMs);

	const t0Pool =
		withinT0Margin.length > 0 ? withinT0Margin : earlier.length > 0 ? earlier : others;

	let selectedT0 = t0Pool[0]!;
	let bestT0Dist = Math.abs(parseEffectiveMs(selectedT0) - t0Ms);
	for (const candidate of t0Pool.slice(1)) {
		const dist = Math.abs(parseEffectiveMs(candidate) - t0Ms);
		if (
			dist < bestT0Dist ||
			(dist === bestT0Dist && candidate.releaseDate < selectedT0.releaseDate)
		) {
			bestT0Dist = dist;
			selectedT0 = candidate;
		}
	}

	return { selectedT0, selectedT1 };
}
