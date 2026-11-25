import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { StacProvider } from '../../config/db/schema/enums.js';
import { STAC_WHITELISTED_HOSTS } from '../../config/presets.js';
import { DomainError } from './domainError.js';

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type FetchFn = typeof globalThis.fetch;

const DEFAULT_DNS_LOOKUP: DnsLookupFn = (hostname) => dnsLookup(hostname, { all: true });
const DNS_CACHE_TTL_MS = 60_000;
const dnsVerifiedCache = new Map<string, number>();

// RN-02: Bloqueio estrito de IPs privados, loopback, link-local (169.254.169.254), CGNAT e multicast
export function isPrivateOrReservedIp(ipRaw: string): boolean {
	const ip = ipRaw.trim().toLowerCase();
	const version = isIP(ip);

	if (version === 4) {
		const parts = ip.split('.').map((n) => Number(n));
		if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
			return true;
		}
		const [a, b, c] = parts as [number, number, number, number];

		if (a === 0) return true; // 0.0.0.0/8
		if (a === 10) return true; // 10.0.0.0/8
		if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
		if (a === 127) return true; // 127.0.0.0/8 (Loopback)
		if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-Local / Cloud Metadata)
		if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
		if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF / TEST-NET-1
		if (a === 192 && b === 168) return true; // 192.168.0.0/16
		if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
		if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
		if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
		if (a >= 224) return true; // 224.0.0.0/4 Multicast & 240.0.0.0/4 Reservado

		return false;
	}

	if (version === 6) {
		if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') {
			return true;
		}
		// IPv4-mapped IPv6 (ex: ::ffff:127.0.0.1 ou ::ffff:7f00:1)
		if (ip.startsWith('::ffff:')) {
			const tail = ip.slice('::ffff:'.length);
			if (isIP(tail) === 4) {
				return isPrivateOrReservedIp(tail);
			}
			const hexParts = tail.split(':');
			if (hexParts.length === 2) {
				const hi = Number.parseInt(hexParts[0]!, 16);
				const lo = Number.parseInt(hexParts[1]!, 16);
				if (Number.isFinite(hi) && Number.isFinite(lo)) {
					const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
					return isPrivateOrReservedIp(v4);
				}
			}
			return true;
		}

		if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 Unique Local
		if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
			return true; // fe80::/10 Link-Local
		}
		if (ip.startsWith('ff')) return true; // ff00::/8 Multicast
		if (ip.startsWith('2001:db8:')) return true; // Documentação

		return false;
	}

	return true;
}

// ADR-05 & Spec Seção 2.2: Valida protocolo https, porta 443 e hostname na whitelist estática
export function assertSafeWhitelistedUrl(
	rawUrl: string,
	allowedHosts: ReadonlySet<string> = STAC_WHITELISTED_HOSTS,
): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new DomainError('ERR_STAC_ITEM_INVALID', 'URL de asset STAC sintaticamente inválida.');
	}

	if (parsed.protocol !== 'https:') {
		throw new DomainError(
			'ERR_STAC_ITEM_INVALID',
			`Protocolo não permitido na fronteira Anti-SSRF ('${parsed.protocol}'). Exigido 'https:'.`,
		);
	}

	if (parsed.username !== '' || parsed.password !== '') {
		throw new DomainError(
			'ERR_STAC_ITEM_INVALID',
			'Credenciais embutidas na URL são proibidas pela política Anti-SSRF.',
		);
	}

	if (parsed.port !== '' && parsed.port !== '443') {
		throw new DomainError(
			'ERR_STAC_ITEM_INVALID',
			`Porta não padrão ('${parsed.port}') bloqueada pela política Anti-SSRF.`,
		);
	}

	const host = parsed.hostname.toLowerCase();
	if (isIP(host) !== 0) {
		throw new DomainError(
			'ERR_STAC_ITEM_INVALID',
			'Endereços IP literais não são permitidos em requisições STAC/COG.',
		);
	}

	if (!allowedHosts.has(host)) {
		throw new DomainError(
			'ERR_STAC_ITEM_INVALID',
			`Domínio '${host}' não consta na whitelist oficial de provedores satelitais.`,
		);
	}

	return parsed;
}

export async function verifyHostnamePublicDns(
	hostname: string,
	lookupFn: DnsLookupFn = DEFAULT_DNS_LOOKUP,
): Promise<void> {
	const normalized = hostname.toLowerCase();
	if (lookupFn === DEFAULT_DNS_LOOKUP) {
		const cachedUntil = dnsVerifiedCache.get(normalized);
		if (cachedUntil && cachedUntil > Date.now()) {
			return;
		}
	}

	let records: Array<{ address: string; family: number }>;
	try {
		records = await lookupFn(normalized);
	} catch {
		throw new DomainError(
			'ERR_UPSTREAM_STAC_UNAVAILABLE',
			`Não foi possível resolver DNS para o provedor satelital '${normalized}'.`,
		);
	}

	if (records.length === 0) {
		throw new DomainError(
			'ERR_UPSTREAM_STAC_UNAVAILABLE',
			`Nenhum registro DNS retornado para '${normalized}'.`,
		);
	}

	for (const rec of records) {
		if (isPrivateOrReservedIp(rec.address)) {
			throw new DomainError(
				'ERR_STAC_ITEM_INVALID',
				`Bloqueio Anti-SSRF: o domínio '${normalized}' resolveu para endereço IP privado ou reservado.`,
			);
		}
	}

	if (lookupFn === DEFAULT_DNS_LOOKUP) {
		dnsVerifiedCache.set(normalized, Date.now() + DNS_CACHE_TTL_MS);
	}
}

export interface SafeFetchOptions {
	timeoutMs?: number;
	maxAttempts?: number;
	baseBackoffMs?: number;
	maxRedirects?: number;
	allowedHosts?: ReadonlySet<string>;
	lookupFn?: DnsLookupFn;
	fetchFn?: FetchFn;
}

const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECT_HTTP_STATUS = new Set([301, 302, 303, 307, 308]);

// Cliente HTTP com proteção Anti-SSRF em redirects + timeout explícito + retry exponencial (RN-02, RNF-11)
export async function safeExternalFetch(
	rawUrl: string,
	init: RequestInit = {},
	options: SafeFetchOptions = {},
): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? 25_000;
	const maxAttempts = options.maxAttempts ?? 3;
	const baseBackoffMs = options.baseBackoffMs ?? 400;
	const maxRedirects = options.maxRedirects ?? 3;
	const allowedHosts = options.allowedHosts ?? STAC_WHITELISTED_HOSTS;
	const lookupFn = options.lookupFn ?? DEFAULT_DNS_LOOKUP;
	const fetchImpl = options.fetchFn ?? globalThis.fetch;

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			let currentUrl = assertSafeWhitelistedUrl(rawUrl, allowedHosts);
			await verifyHostnamePublicDns(currentUrl.hostname, lookupFn);

			let currentMethod = init.method ?? 'GET';
			let currentBody = init.body;

			for (let hop = 0; hop <= maxRedirects; hop++) {
				const signal = init.signal
					? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
					: AbortSignal.timeout(timeoutMs);

				const response = await fetchImpl(currentUrl.toString(), {
					...init,
					method: currentMethod,
					body: currentBody,
					redirect: 'manual',
					signal,
				});

				if (REDIRECT_HTTP_STATUS.has(response.status)) {
					if (hop === maxRedirects) {
						throw new DomainError(
							'ERR_STAC_ITEM_INVALID',
							'Excesso de redirecionamentos HTTP em requisição STAC/COG.',
						);
					}

					const location = response.headers.get('location');
					if (!location) {
						throw new DomainError(
							'ERR_UPSTREAM_STAC_UNAVAILABLE',
							'Resposta de redirecionamento sem cabeçalho Location do provedor STAC.',
						);
					}

					const resolvedNext = new URL(location, currentUrl).toString();
					currentUrl = assertSafeWhitelistedUrl(resolvedNext, allowedHosts);
					await verifyHostnamePublicDns(currentUrl.hostname, lookupFn);

					if (response.status === 303) {
						currentMethod = 'GET';
						currentBody = undefined;
					}
					continue;
				}

				if (RETRYABLE_HTTP_STATUS.has(response.status) && attempt < maxAttempts) {
					lastError = new Error(`HTTP ${response.status} retornado por ${currentUrl.hostname}`);
					break;
				}

				return response;
			}
		} catch (err) {
			if (err instanceof DomainError) {
				throw err;
			}
			lastError = err;
		}

		if (attempt < maxAttempts) {
			const delay = baseBackoffMs * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	const reason = lastError instanceof Error ? lastError.message : 'Falha de comunicação upstream';
	throw new DomainError(
		'ERR_UPSTREAM_STAC_UNAVAILABLE',
		`Falha persistente ao consultar provedor satelital após ${maxAttempts} tentativa(s): ${reason}`,
	);
}

interface BreakerState {
	consecutiveFailures: number;
	openUntilMs: number;
}

// RNF-11: Circuit Breaker por provedor STAC evitando cascata de lentidão quando um catálogo cai
export class StacCircuitBreaker {
	private readonly states = new Map<StacProvider, BreakerState>();
	private readonly failureThreshold: number;
	private readonly openDurationMs: number;

	constructor(opts?: { failureThreshold?: number; openDurationMs?: number }) {
		this.failureThreshold = opts?.failureThreshold ?? 4;
		this.openDurationMs = opts?.openDurationMs ?? 30_000;
	}

	isOpen(provider: StacProvider): boolean {
		const st = this.states.get(provider);
		if (!st) return false;
		if (st.openUntilMs > Date.now()) {
			return true;
		}
		return false;
	}

	assertAvailable(provider: StacProvider): void {
		if (this.isOpen(provider)) {
			throw new DomainError(
				'ERR_UPSTREAM_STAC_UNAVAILABLE',
				`Circuit breaker aberto temporariamente para o provedor '${provider}'.`,
			);
		}
	}

	recordSuccess(provider: StacProvider): void {
		this.states.delete(provider);
	}

	recordFailure(provider: StacProvider): void {
		const prev = this.states.get(provider) ?? { consecutiveFailures: 0, openUntilMs: 0 };
		const consecutiveFailures = prev.consecutiveFailures + 1;
		const openUntilMs =
			consecutiveFailures >= this.failureThreshold ? Date.now() + this.openDurationMs : 0;
		this.states.set(provider, { consecutiveFailures, openUntilMs });
	}

	reset(): void {
		this.states.clear();
	}
}
