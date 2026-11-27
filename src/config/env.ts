import 'dotenv/config';
import { generateKeyPairSync } from 'node:crypto';
import { z } from 'zod';

const booleanFromEnv = z
	.union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
	.transform((val) => val === true || val === 'true' || val === '1');

const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	HOST: z.string().default('0.0.0.0'),
	PORT: z.coerce.number().int().min(1).max(65535).default(3333),
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
	API_PROBLEM_BASE_URI: z.string().url().default('https://api.sicam.local/problems'),
	FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
	ENABLE_OPENAPI_ROUTE: booleanFromEnv.default(true),

	DATABASE_URL: z
		.string()
		.min(1)
		.default('postgresql://app_runtime:runtime_dev_secret@localhost:5432/sicam'),
	DATABASE_MIGRATOR_URL: z
		.string()
		.min(1)
		.default('postgresql://app_migrator:migrator_dev_secret@localhost:5432/sicam'),

	REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

	S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
	S3_REGION: z.string().min(1).default('us-east-1'),
	S3_ACCESS_KEY_ID: z.string().min(1).default('sicam_s3_admin'),
	S3_SECRET_ACCESS_KEY: z.string().min(1).default('sicam_s3_dev_secret_key'),
	S3_BUCKET: z.string().min(1).default('sicam-artifacts'),
	S3_FORCE_PATH_STYLE: booleanFromEnv.default(true),

	JWT_ED25519_PRIVATE_KEY_B64: z.string().optional().default(''),
	JWT_ED25519_PUBLIC_KEY_B64: z.string().optional().default(''),
	JWT_ISSUER: z.string().min(1).default('sicam-api'),
	JWT_AUDIENCE: z.string().min(1).default('sicam-web'),
	ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
	REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
	COOKIE_SECURE: booleanFromEnv.default(false),

	MIN_AOI_AREA_HA: z.coerce.number().positive().default(0.5),
	MAX_AOI_AREA_HA: z.coerce.number().positive().default(50000),
	MAX_AOI_VERTICES: z.coerce.number().int().min(4).max(500).default(500),
	MAX_ACTIVE_RUNS_PER_USER: z.coerce.number().int().min(1).max(10).default(2),
	ENFORCE_IMPORTED_UF_COVERAGE: booleanFromEnv.default(true),
	ENABLE_WAYBACK_HIRES: booleanFromEnv.default(true),
	GEO_MAX_PIXELS_GUARD: z.coerce.number().int().positive().default(8_000_000),
	ENGINE_VERSION: z.string().min(1).default('1.0.0'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
	console.error('Configuração de ambiente inválida:', parsed.error.flatten().fieldErrors);
	process.exit(1);
}

const rawEnv = parsed.data;

function resolveJwtKeyPairPem(
	nodeEnv: string,
	privB64: string,
	pubB64: string,
): { privateKeyPem: string; publicKeyPem: string } {
	if (privB64.trim() && pubB64.trim()) {
		return {
			privateKeyPem: Buffer.from(privB64.trim(), 'base64').toString('utf8'),
			publicKeyPem: Buffer.from(pubB64.trim(), 'base64').toString('utf8'),
		};
	}

	if (nodeEnv === 'production') {
		throw new Error(
			'Em produção, JWT_ED25519_PRIVATE_KEY_B64 e JWT_ED25519_PUBLIC_KEY_B64 são obrigatórios (RNF-01).',
		);
	}

	const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	});

	return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

const jwtKeys = resolveJwtKeyPairPem(
	rawEnv.NODE_ENV,
	rawEnv.JWT_ED25519_PRIVATE_KEY_B64,
	rawEnv.JWT_ED25519_PUBLIC_KEY_B64,
);

export const env = {
	...rawEnv,
	COOKIE_SECURE: rawEnv.NODE_ENV === 'production' ? true : rawEnv.COOKIE_SECURE,
	ENABLE_OPENAPI_ROUTE: rawEnv.NODE_ENV === 'production' ? false : rawEnv.ENABLE_OPENAPI_ROUTE,
	JWT_PRIVATE_KEY_PEM: jwtKeys.privateKeyPem,
	JWT_PUBLIC_KEY_PEM: jwtKeys.publicKeyPem,
} as const;
