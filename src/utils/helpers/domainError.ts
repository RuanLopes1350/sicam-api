// Catálogo fechado de códigos de erro de domínio (Contrato OpenAPI 3.1 — Seção 1.2)
export const ERROR_CATALOG = {
	ERR_VALIDATION_FAILED: {
		status: 400,
		slug: 'validation-failed',
		title: 'Falha de validação do payload',
	},
	ERR_UNAUTHORIZED: {
		status: 401,
		slug: 'unauthorized',
		title: 'Autenticação inválida ou ausente',
	},
	ERR_TOKEN_REUSE_DETECTED: {
		status: 401,
		slug: 'token-reuse-detected',
		title: 'Reutilização de token detectada — sessão revogada',
	},
	ERR_FORBIDDEN_ROLE: {
		status: 403,
		slug: 'forbidden-role',
		title: 'Permissão insuficiente para a operação solicitada',
	},
	ERR_RESOURCE_NOT_FOUND: {
		status: 404,
		slug: 'resource-not-found',
		title: 'Recurso não encontrado',
	},
	ERR_RUN_NOT_REVIEWABLE: {
		status: 409,
		slug: 'run-not-reviewable',
		title: 'Execução fora do estado de revisão',
	},
	ERR_RUN_FROZEN: {
		status: 409,
		slug: 'run-frozen',
		title: 'Execução congelada ou imutável',
	},
	ERR_CONCURRENT_JOBS_LIMIT: {
		status: 409,
		slug: 'concurrent-jobs-limit',
		title: 'Limite de execuções simultâneas atingido',
	},
	ERR_IDEMPOTENCY_CONFLICT: {
		status: 409,
		slug: 'idempotency-conflict',
		title: 'Conflito de chave de idempotência',
	},
	ERR_RESOURCE_CONFLICT: {
		status: 409,
		slug: 'resource-conflict',
		title: 'Conflito com registro existente',
	},
	ERR_INVALID_GEOMETRY: {
		status: 422,
		slug: 'invalid-geometry',
		title: 'Geometria da área de interesse inválida',
	},
	ERR_AOI_AREA_OUT_OF_BOUNDS: {
		status: 422,
		slug: 'aoi-area-out-of-bounds',
		title: 'Área de interesse fora dos limites operacionais',
	},
	ERR_UF_NOT_COVERED: {
		status: 422,
		slug: 'uf-not-covered',
		title: 'Unidade Federativa fora da cobertura geográfica ativa',
	},
	ERR_STAC_ITEM_INVALID: {
		status: 422,
		slug: 'stac-item-invalid',
		title: 'Item satelital STAC inválido ou fora da AOI',
	},
	ERR_TEMPORAL_ORDER_INVALID: {
		status: 422,
		slug: 'temporal-order-invalid',
		title: 'Ordem temporal das cenas inválida',
	},
	ERR_PARAMS_OUT_OF_BOUNDS: {
		status: 422,
		slug: 'params-out-of-bounds',
		title: 'Parâmetros do algoritmo fora dos limites técnicos',
	},
	ERR_RATE_LIMIT_EXCEEDED: {
		status: 429,
		slug: 'rate-limit-exceeded',
		title: 'Limite de requisições excedido',
	},
	ERR_UPSTREAM_STAC_UNAVAILABLE: {
		status: 502,
		slug: 'upstream-stac-unavailable',
		title: 'Provedores satelitais STAC temporariamente indisponíveis',
	},
	ERR_SERVICE_UNAVAILABLE: {
		status: 503,
		slug: 'service-unavailable',
		title: 'Serviço ou dependência indisponível',
	},
	ERR_INTERNAL_SERVER_ERROR: {
		status: 500,
		slug: 'internal-server-error',
		title: 'Erro interno no processamento da requisição',
	},
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface InvalidParamDetail {
	field: string;
	reason: string;
	meta?: Record<string, unknown>;
}

export class DomainError extends Error {
	public readonly statusCode: number;
	public readonly errorCode: ErrorCode;
	public readonly title: string;
	public readonly slug: string;
	public readonly invalidParams?: InvalidParamDetail[];

	constructor(
		errorCode: ErrorCode,
		detail: string,
		options?: {
			statusCode?: number;
			title?: string;
			invalidParams?: InvalidParamDetail[];
		},
	) {
		super(detail);
		this.name = 'DomainError';
		const meta = ERROR_CATALOG[errorCode];
		this.errorCode = errorCode;
		this.statusCode = options?.statusCode ?? meta.status;
		this.title = options?.title ?? meta.title;
		this.slug = meta.slug;
		this.invalidParams = options?.invalidParams;
	}
}
