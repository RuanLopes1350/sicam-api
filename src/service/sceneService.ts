import { importPKCS8, importSPKI, jwtVerify, SignJWT, type KeyLike } from 'jose';
import type { StacProvider } from '../config/db/schema/enums.js';
import { env } from '../config/env.js';
import caseRepository from '../repository/caseRepository.js';
import { computeAoiSclMetrics, type SclTileInput } from '../utils/geo/sclAnalyzer.js';
import {
	HttpStacCatalogAdapter,
	type NormalizedStacItem,
	type StacCatalogAdapter,
} from '../utils/geo/stacClient.js';
import { StacCircuitBreaker } from '../utils/helpers/antiSsrfHttp.js';
import { DomainError } from '../utils/helpers/domainError.js';
import { CaseIdParamsSchema, type AoiPolygonGeoJson } from '../utils/validation/caseValidation.js';
import {
	type ProviderWarning,
	type SceneCandidate,
	ScenePreviewQuerySchema,
	SceneSearchBodySchema,
	type TemporalWindow,
} from '../utils/validation/sceneValidation.js';

const MAX_WINDOW_SPAN_DAYS = 180;
const SCL_EVAL_CONCURRENCY = 4;

let previewPrivateKeyPromise: Promise<KeyLike> | null = null;
let previewPublicKeyPromise: Promise<KeyLike> | null = null;

async function getPreviewPrivateKey(): Promise<KeyLike> {
	if (!previewPrivateKeyPromise) {
		previewPrivateKeyPromise = importPKCS8(env.JWT_PRIVATE_KEY_PEM, 'EdDSA');
	}
	return previewPrivateKeyPromise;
}

async function getPreviewPublicKey(): Promise<KeyLike> {
	if (!previewPublicKeyPromise) {
		previewPublicKeyPromise = importSPKI(env.JWT_PUBLIC_KEY_PEM, 'EdDSA');
	}
	return previewPublicKeyPromise;
}

export interface PreviewTokenPayload {
	caseId: string;
	provider: StacProvider;
	collection: string;
	itemId: string;
}

export async function signScenePreviewToken(payload: PreviewTokenPayload): Promise<string> {
	const key = await getPreviewPrivateKey();
	return new SignJWT({
		caseId: payload.caseId,
		provider: payload.provider,
		collection: payload.collection,
		itemId: payload.itemId,
	})
		.setProtectedHeader({ alg: 'EdDSA', typ: 'SICAM-PREVIEW' })
		.setIssuer(env.JWT_ISSUER)
		.setAudience('sicam-scene-preview')
		.setIssuedAt()
		.setExpirationTime('1h')
		.sign(key);
}

export async function verifyScenePreviewToken(token: string): Promise<PreviewTokenPayload> {
	const key = await getPreviewPublicKey();
	try {
		const { payload } = await jwtVerify(token, key, {
			algorithms: ['EdDSA'],
			issuer: env.JWT_ISSUER,
			audience: 'sicam-scene-preview',
		});

		if (
			typeof payload.caseId !== 'string' ||
			typeof payload.provider !== 'string' ||
			typeof payload.collection !== 'string' ||
			typeof payload.itemId !== 'string'
		) {
			throw new Error('Claims incompletas no token de preview.');
		}

		return {
			caseId: payload.caseId,
			provider: payload.provider as StacProvider,
			collection: payload.collection,
			itemId: payload.itemId,
		};
	} catch {
		throw new DomainError(
			'ERR_STAC_ITEM_INVALID',
			'Token de pré-visualização de cena inválido ou expirado.',
		);
	}
}

function validateTemporalWindow(window: TemporalWindow, fieldPrefix: 't0Window' | 't1Window'): {
	fromMs: number;
	toMs: number;
} {
	const fromMs = Date.parse(`${window.from}T00:00:00Z`);
	const toMs = Date.parse(`${window.to}T23:59:59Z`);

	if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			`Janela temporal '${fieldPrefix}' inválida: 'from' deve ser anterior ou igual a 'to'.`,
			{
				invalidParams: [{ field: fieldPrefix, reason: 'INVALID_WINDOW_RANGE' }],
			},
		);
	}

	const spanDays = (toMs - fromMs) / 86_400_000;
	if (spanDays > MAX_WINDOW_SPAN_DAYS) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			`A janela temporal '${fieldPrefix}' excede o limite máximo de ${MAX_WINDOW_SPAN_DAYS} dias.`,
			{
				invalidParams: [
					{
						field: fieldPrefix,
						reason: 'MAX_WINDOW_SPAN_EXCEEDED',
						meta: { maxDays: MAX_WINDOW_SPAN_DAYS, requestedDays: Math.ceil(spanDays) },
					},
				],
			},
		);
	}

	return { fromMs, toMs };
}

// Executa tarefas assíncronas com teto estrito de concorrência (Spec Seção 2.2: 4 leituras paralelas)
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;

	async function runLane(): Promise<void> {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await worker(items[index]!);
		}
	}

	const lanes = Array.from({ length: Math.min(concurrency, items.length) }, () => runLane());
	await Promise.all(lanes);
	return results;
}

export type SclEvaluatorFn = (params: {
	aoiGeoJson: AoiPolygonGeoJson;
	utmSrid: number;
	sclTiles: ReadonlyArray<SclTileInput>;
}) => Promise<{ aoiCloudPct: number; aoiCoveragePct: number }>;

// RF-13: Deduplica reprocessamentos do mesmo tile MGRS e agrupa tiles adjacentes da mesma passagem em mosaico único
export function groupItemsIntoPassCandidates(items: ReadonlyArray<NormalizedStacItem>): Array<{
	candidateKey: string;
	provider: StacProvider;
	collection: string;
	passDateUtc: string;
	tiles: NormalizedStacItem[];
}> {
	const byPassKey = new Map<string, Map<string, NormalizedStacItem>>();

	for (const item of items) {
		const passKey = `${item.provider}:${item.collection}:${item.passDateUtc}`;
		let tileMap = byPassKey.get(passKey);
		if (!tileMap) {
			tileMap = new Map<string, NormalizedStacItem>();
			byPassKey.set(passKey, tileMap);
		}

		const prev = tileMap.get(item.mgrsTile);
		if (!prev) {
			tileMap.set(item.mgrsTile, item);
			continue;
		}

		// Mantém o item com baseline mais recente (evita duplicata _0_L2A vs _1_L2A no mesmo tile MGRS)
		const prevBase = Number.parseFloat(prev.processingBaseline ?? '0');
		const nextBase = Number.parseFloat(item.processingBaseline ?? '0');
		if (nextBase > prevBase || (nextBase === prevBase && item.id > prev.id)) {
			tileMap.set(item.mgrsTile, item);
		}
	}

	const groups: Array<{
		candidateKey: string;
		provider: StacProvider;
		collection: string;
		passDateUtc: string;
		tiles: NormalizedStacItem[];
	}> = [];

	for (const [candidateKey, tileMap] of byPassKey.entries()) {
		const tiles = Array.from(tileMap.values()).sort((a, b) => a.id.localeCompare(b.id));
		const first = tiles[0];
		if (!first) continue;
		groups.push({
			candidateKey,
			provider: first.provider,
			collection: first.collection,
			passDateUtc: first.passDateUtc,
			tiles,
		});
	}

	// Prioriza pré-avaliação pelas cenas globalmente mais limpas antes de abrir os COGs SCL
	groups.sort((a, b) => {
		const avgA = a.tiles.reduce((acc, t) => acc + t.globalCloudPct, 0) / a.tiles.length;
		const avgB = b.tiles.reduce((acc, t) => acc + t.globalCloudPct, 0) / b.tiles.length;
		return avgA - avgB;
	});

	return groups;
}

export class SceneService {
	private catalogAdapter: StacCatalogAdapter;
	private sclEvaluator: SclEvaluatorFn;
	private readonly circuitBreaker: StacCircuitBreaker;

	constructor(deps?: {
		catalogAdapter?: StacCatalogAdapter;
		sclEvaluator?: SclEvaluatorFn;
		circuitBreaker?: StacCircuitBreaker;
	}) {
		this.catalogAdapter = deps?.catalogAdapter ?? new HttpStacCatalogAdapter();
		this.sclEvaluator = deps?.sclEvaluator ?? computeAoiSclMetrics;
		this.circuitBreaker = deps?.circuitBreaker ?? new StacCircuitBreaker();
	}

	// Permite substituição limpa de adaptadores em testes de integração sem expor rotas internas
	setAdaptersForTesting(deps: {
		catalogAdapter?: StacCatalogAdapter;
		sclEvaluator?: SclEvaluatorFn;
		resetBreaker?: boolean;
	}): void {
		if (deps.catalogAdapter) this.catalogAdapter = deps.catalogAdapter;
		if (deps.sclEvaluator) this.sclEvaluator = deps.sclEvaluator;
		if (deps.resetBreaker) this.circuitBreaker.reset();
	}

	async searchScenes(rawParams: unknown, rawBody: unknown) {
		const { caseId } = CaseIdParamsSchema.parse(rawParams);
		const body = SceneSearchBodySchema.parse(rawBody);

		const t0Range = validateTemporalWindow(body.t0Window, 't0Window');
		const t1Range = validateTemporalWindow(body.t1Window, 't1Window');

		if (t1Range.toMs <= t0Range.fromMs) {
			throw new DomainError(
				'ERR_TEMPORAL_ORDER_INVALID',
				'A janela temporal alvo (t1Window) deve conter datas posteriores ao início da janela base (t0Window).',
				{
					invalidParams: [{ field: 't1Window', reason: 'TEMPORAL_ORDER_INVALID' }],
				},
			);
		}

		const caseEnvelope = await caseRepository.findSpatialEnvelopeById(caseId);
		if (!caseEnvelope) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Caso de análise não encontrado.');
		}

		const uniqueProviders = Array.from(new Set(body.providers));
		const providerWarnings = new Map<StacProvider, ProviderWarning>();
		let anyProviderSucceeded = false;

		const fetchWindowAcrossProviders = async (window: TemporalWindow): Promise<NormalizedStacItem[]> => {
			const collected: NormalizedStacItem[] = [];

			await Promise.all(
				uniqueProviders.map(async (provider) => {
					try {
						this.circuitBreaker.assertAvailable(provider);
						const items = await this.catalogAdapter.searchItems({
							provider,
							aoiGeoJson: caseEnvelope.aoiGeoJson,
							fromDate: window.from,
							toDate: window.to,
							maxGlobalCloudPct: body.maxGlobalCloudPct,
						});
						this.circuitBreaker.recordSuccess(provider);
						anyProviderSucceeded = true;
						collected.push(...items);
					} catch (err) {
						this.circuitBreaker.recordFailure(provider);
						const message =
							err instanceof Error
								? err.message
								: `Falha ao consultar o provedor '${provider}'.`;
						providerWarnings.set(provider, {
							provider,
							code: 'PROVIDER_UNAVAILABLE',
							message,
						});
					}
				}),
			);

			return collected;
		};

		const [t0RawItems, t1RawItems] = await Promise.all([
			fetchWindowAcrossProviders(body.t0Window),
			fetchWindowAcrossProviders(body.t1Window),
		]);

		if (!anyProviderSucceeded) {
			throw new DomainError(
				'ERR_UPSTREAM_STAC_UNAVAILABLE',
				'Todos os catálogos STAC consultados estão temporariamente indisponíveis.',
			);
		}

		const buildRankedCandidates = async (
			rawItems: NormalizedStacItem[],
		): Promise<SceneCandidate[]> => {
			// Limita a leitura COG SCL aos candidatos pré-filtrados mais promissores
			const grouped = groupItemsIntoPassCandidates(rawItems).slice(0, body.limitPerWindow * 2);

			const evaluated = await mapWithConcurrency(
				grouped,
				SCL_EVAL_CONCURRENCY,
				async (group): Promise<SceneCandidate | null> => {
					try {
						const sclTiles: SclTileInput[] = group.tiles.map((t) => ({
							href: t.sclHref,
							projEpsg: t.projEpsg,
							isInpeBdc: t.provider === 'inpe_bdc',
						}));

						const metrics = await this.sclEvaluator({
							aoiGeoJson: caseEnvelope.aoiGeoJson,
							utmSrid: caseEnvelope.utmSrid,
							sclTiles,
						});

						if (metrics.aoiCoveragePct <= 0) {
							return null;
						}

						const primaryTile = group.tiles[0]!;
						const avgGlobalCloud = Number(
							(
								group.tiles.reduce((acc, t) => acc + t.globalCloudPct, 0) / group.tiles.length
							).toFixed(2),
						);

						const previewToken = await signScenePreviewToken({
							caseId,
							provider: group.provider,
							collection: group.collection,
							itemId: primaryTile.id,
						});

						return {
							candidateKey: group.candidateKey,
							provider: group.provider,
							collection: group.collection,
							itemIds: group.tiles.map((t) => t.id),
							isMultiTile: group.tiles.length > 1,
							acquiredAt: primaryTile.acquiredAt,
							globalCloudPct: avgGlobalCloud,
							aoiCloudPct: metrics.aoiCloudPct,
							aoiCoveragePct: metrics.aoiCoveragePct,
							processingBaseline: primaryTile.processingBaseline,
							boaOffsetApplied: group.tiles.some((t) => t.boaOffsetApplied),
							previewUrl: `/api/v1/cases/${caseId}/scenes/preview?token=${encodeURIComponent(previewToken)}`,
						};
					} catch {
						// Se a leitura HTTP Range de uma cena específica falhar, descarta apenas aquela cena candidata
						return null;
					}
				},
			);

			const validCandidates = evaluated.filter((c): c is SceneCandidate => c !== null);

			// RF-12: Ordena da cena mais limpa dentro da AOI para a mais nublada
			validCandidates.sort((a, b) => {
				if (a.aoiCloudPct !== b.aoiCloudPct) {
					return a.aoiCloudPct - b.aoiCloudPct;
				}
				if (a.aoiCoveragePct !== b.aoiCoveragePct) {
					return b.aoiCoveragePct - a.aoiCoveragePct;
				}
				return b.acquiredAt.localeCompare(a.acquiredAt);
			});

			return validCandidates.slice(0, body.limitPerWindow);
		};

		const [t0Candidates, t1Candidates] = await Promise.all([
			buildRankedCandidates(t0RawItems),
			buildRankedCandidates(t1RawItems),
		]);

		return {
			caseId,
			t0Candidates,
			t1Candidates,
			providerWarnings: Array.from(providerWarnings.values()),
		};
	}

	async getScenePreview(rawParams: unknown, rawQuery: unknown): Promise<{
		contentType: string;
		buffer: Buffer;
	}> {
		const { caseId } = CaseIdParamsSchema.parse(rawParams);
		const { token } = ScenePreviewQuerySchema.parse(rawQuery);

		const claims = await verifyScenePreviewToken(token);
		if (claims.caseId !== caseId) {
			throw new DomainError(
				'ERR_STAC_ITEM_INVALID',
				'O token de pré-visualização não pertence ao caso informado.',
			);
		}

		const item = await this.catalogAdapter.getItem({
			provider: claims.provider,
			collection: claims.collection,
			itemId: claims.itemId,
		});

		if (!item.thumbnailHref) {
			throw new DomainError(
				'ERR_RESOURCE_NOT_FOUND',
				'Miniatura de pré-visualização indisponível para o item satelital selecionado.',
			);
		}

		return this.catalogAdapter.fetchAssetBytes(item.thumbnailHref);
	}
}

export default new SceneService();
