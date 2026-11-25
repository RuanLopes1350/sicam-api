import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { closeDb, getPool } from '../src/config/dbConfig.js';
import { runMigrations } from '../src/config/db/migrate.js';
import { env } from '../src/config/env.js';
import { closeRedis } from '../src/config/redisConfig.js';
import { closeS3, ensurePrivateBucket } from '../src/config/s3Config.js';
import { runSeed } from '../src/seeds/index.js';

function extractCookieValue(setCookieHeader: string | string[] | undefined, cookieName: string): string | undefined {
	if (!setCookieHeader) return undefined;
	const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
	for (const item of list) {
		const [pair] = item.split(';');
		if (pair?.startsWith(`${cookieName}=`)) {
			return decodeURIComponent(pair.slice(`${cookieName}=`.length));
		}
	}
	return undefined;
}

describe('Fase 1 — Infra PostGIS/Redis/S3 + Migrations + Auth/RBAC/Audit (Integração)', () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		await runMigrations();
		await ensurePrivateBucket();
		await runSeed();

		// Insere fixture determinístico de Rondônia (RO) + Vilhena em EPSG:4674 para validar PostGIS e rotas territoriais
		const client = new pg.Client({ connectionString: env.DATABASE_URL });
		await client.connect();
		try {
			const roPoly = JSON.stringify({
				type: 'MultiPolygon',
				coordinates: [
					[
						[
							[-66.8, -13.7],
							[-59.7, -13.7],
							[-59.7, -7.9],
							[-66.8, -7.9],
							[-66.8, -13.7],
						],
					],
				],
			});
			const vilhenaPoly = JSON.stringify({
				type: 'MultiPolygon',
				coordinates: [
					[
						[
							[-60.45, -12.95],
							[-59.95, -12.95],
							[-59.95, -12.45],
							[-60.45, -12.45],
							[-60.45, -12.95],
						],
					],
				],
			});

			await client.query(
				`
        INSERT INTO ibge_states (uf_code, ibge_state_id, name, geom_4674, geom_simplified_4674, dataset_version)
        VALUES (
          'RO', 11, 'Rondônia',
          ST_SetSRID(ST_GeomFromGeoJSON($1), 4674),
          ST_SetSRID(ST_GeomFromGeoJSON($1), 4674),
          'IBGE_BR_UF_2024'
        )
        ON CONFLICT (uf_code) DO NOTHING;
        `,
				[roPoly],
			);

			await client.query(
				`
        INSERT INTO ibge_municipalities (ibge_code, uf_code, name, geom_4674, geom_simplified_4674, dataset_version)
        VALUES (
          '1100304', 'RO', 'Vilhena',
          ST_SetSRID(ST_GeomFromGeoJSON($1), 4674),
          ST_SetSRID(ST_GeomFromGeoJSON($1), 4674),
          'IBGE_BR_MUN_2024'
        )
        ON CONFLICT (ibge_code) DO NOTHING;
        `,
				[vilhenaPoly],
			);
		} finally {
			await client.end();
		}

		app = await buildApp({ silentLogs: true, useMemoryRateLimit: true });
		await app.ready();
	});

	afterAll(async () => {
		if (app) await app.close();
		await closeDb();
		await closeRedis();
		closeS3();
	});

	it('deve validar funções geodésicas SIRGAS 2000 (EPSG:31980 para RO) e imutabilidade no banco', async () => {
		const pool = getPool();

		// Quadrante em Vilhena/RO (-60.20..-60.15, -12.70..-12.65) -> Zona 20S = EPSG:31980
		const geoRes = await pool.query<{ srid: number; area_ha: string }>(
			`
      SELECT
        fn_get_sirgas_utm_srid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4674)) AS srid,
        fn_calc_area_ha_sirgas(ST_SetSRID(ST_GeomFromGeoJSON($1), 4674)) AS area_ha
      `,
			[
				JSON.stringify({
					type: 'Polygon',
					coordinates: [
						[
							[-60.2, -12.7],
							[-60.15, -12.7],
							[-60.15, -12.65],
							[-60.2, -12.65],
							[-60.2, -12.7],
						],
					],
				}),
			],
		);

		expect(geoRes.rows[0]?.srid).toBe(31980);
		expect(Number(geoRes.rows[0]?.area_ha)).toBeGreaterThan(2900);
		expect(Number(geoRes.rows[0]?.area_ha)).toBeLessThan(3100);

		// app_runtime deve ser bloqueado ao tentar DELETE ou UPDATE em audit_logs (Least Privilege + Trigger)
		await expect(pool.query('DELETE FROM audit_logs')).rejects.toThrow();
	});

	it('deve responder 200 OK em /health/live e /health/ready com PostGIS, Redis e S3 prontos', async () => {
		const liveRes = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
		expect(liveRes.statusCode).toBe(200);
		expect(liveRes.headers['x-request-id']).toBeDefined();

		const readyRes = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
		expect(readyRes.statusCode).toBe(200);
		expect(readyRes.json()).toMatchObject({
			status: 'ready',
			checks: { postgis: true, redis: true, s3: true },
		});
	});

	it('deve rejeitar campos desconhecidos com 400 RFC 9457 ProblemDetails (Zod .strict)', async () => {
		const reqId = randomUUID();
		const res = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			headers: { 'x-request-id': reqId },
			payload: {
				email: 'analista@sicam.gov.br',
				password: 'Sicam@Analista2026!',
				maliciousExtraField: true,
			},
		});

		expect(res.statusCode).toBe(400);
		expect(res.headers['content-type']).toContain('application/problem+json');
		expect(res.json()).toMatchObject({
			status: 400,
			code: 'ERR_VALIDATION_FAILED',
			correlationId: reqId,
		});
	});

	it('deve autenticar, rotacionar refresh token e revogar família inteira em caso de reuso (Zero Trust)', async () => {
		// 1. Login como Analista
		const loginRes = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			payload: {
				email: 'analista@sicam.gov.br',
				password: 'Sicam@Analista2026!',
			},
		});

		expect(loginRes.statusCode).toBe(200);
		const loginBody = loginRes.json() as { accessToken: string; expiresInSeconds: number };
		expect(loginBody.expiresInSeconds).toBe(900);

		const token1 = extractCookieValue(loginRes.headers['set-cookie'], 'refresh_token');
		expect(token1).toBeDefined();

		// 2. Consulta /system/capabilities e /territories/municipalities autenticado
		const capRes = await app.inject({
			method: 'GET',
			url: '/api/v1/system/capabilities',
			headers: { authorization: `Bearer ${loginBody.accessToken}` },
		});
		expect(capRes.statusCode).toBe(200);
		expect(capRes.json().aoi.loadedUfs).toEqual(
			expect.arrayContaining([expect.objectContaining({ ufCode: 'RO', name: 'Rondônia' })]),
		);

		const munRes = await app.inject({
			method: 'GET',
			url: '/api/v1/territories/municipalities?uf=RO&q=Vilhena',
			headers: { authorization: `Bearer ${loginBody.accessToken}` },
		});
		expect(munRes.statusCode).toBe(200);
		expect(munRes.json().items[0]).toMatchObject({
			ibgeCode: '1100304',
			name: 'Vilhena',
			ufCode: 'RO',
		});

		// 3. Rotaciona Refresh Token (token1 -> token2)
		const refresh1 = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/refresh',
			cookies: { refresh_token: token1! },
		});
		expect(refresh1.statusCode).toBe(200);
		const token2 = extractCookieValue(refresh1.headers['set-cookie'], 'refresh_token');
		expect(token2).toBeDefined();
		expect(token2).not.toBe(token1);

		// 4. Ataque de reuso com token1 já rotacionado -> deve disparar 401 ERR_TOKEN_REUSE_DETECTED e revogar token2!
		const reuseAttempt = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/refresh',
			cookies: { refresh_token: token1! },
		});
		expect(reuseAttempt.statusCode).toBe(401);
		expect(reuseAttempt.json().code).toBe('ERR_TOKEN_REUSE_DETECTED');

		const token2AfterReuse = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/refresh',
			cookies: { refresh_token: token2! },
		});
		expect(token2AfterReuse.statusCode).toBe(401);
	});

	it('deve impor RBAC estrito, rate limit por IP e revogar sessão imediatamente ao desativar operador (RF-02, RF-03, RNF-04)', async () => {
		// Login Analista -> bloqueado em /users e /audit-logs
		const anaLogin = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.10.1.10',
			payload: { email: 'analista@sicam.gov.br', password: 'Sicam@Analista2026!' },
		});
		const anaToken = anaLogin.json().accessToken as string;

		const forbiddenUsers = await app.inject({
			method: 'GET',
			url: '/api/v1/users',
			headers: { authorization: `Bearer ${anaToken}` },
		});
		expect(forbiddenUsers.statusCode).toBe(403);
		expect(forbiddenUsers.json().code).toBe('ERR_FORBIDDEN_ROLE');

		const forbiddenAudit = await app.inject({
			method: 'GET',
			url: '/api/v1/audit-logs',
			headers: { authorization: `Bearer ${anaToken}` },
		});
		expect(forbiddenAudit.statusCode).toBe(403);

		// Login Admin -> cria operador temporário, operador faz login, Admin desativa e JWT cai na hora
		const admLogin = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.10.1.20',
			payload: { email: 'admin@sicam.gov.br', password: 'Sicam@Admin2026!' },
		});
		const admToken = admLogin.json().accessToken as string;

		const uniqueSuffix = randomUUID().slice(0, 8);
		const createRes = await app.inject({
			method: 'POST',
			url: '/api/v1/users',
			headers: { authorization: `Bearer ${admToken}` },
			payload: {
				fullName: 'Operador Temporário Teste',
				registrationCode: `TMP-${uniqueSuffix}`,
				email: `temp.${uniqueSuffix}@sicam.gov.br`,
				password: 'TempPassword@2026!',
				role: 'analyst',
			},
		});
		expect(createRes.statusCode).toBe(201);
		const tempUserId = createRes.json().id as string;

		const tempLogin = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.10.1.30',
			payload: {
				email: `temp.${uniqueSuffix}@sicam.gov.br`,
				password: 'TempPassword@2026!',
			},
		});
		expect(tempLogin.statusCode).toBe(200);
		const tempAccessToken = tempLogin.json().accessToken as string;
		const tempRefreshCookie = extractCookieValue(tempLogin.headers['set-cookie'], 'refresh_token')!;

		// Desativa o operador
		const deactivateRes = await app.inject({
			method: 'PATCH',
			url: `/api/v1/users/${tempUserId}`,
			headers: { authorization: `Bearer ${admToken}` },
			payload: { active: false },
		});
		expect(deactivateRes.statusCode).toBe(200);
		expect(deactivateRes.json().active).toBe(false);

		// Access token ainda dentro dos 15min deve ser rejeitado imediatamente pela checagem Zero Trust no banco
		const meAfterDeactivate = await app.inject({
			method: 'GET',
			url: '/api/v1/auth/me',
			headers: { authorization: `Bearer ${tempAccessToken}` },
		});
		expect(meAfterDeactivate.statusCode).toBe(401);

		// Refresh token também deve ter sido revogado no banco
		const refreshAfterDeactivate = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/refresh',
			cookies: { refresh_token: tempRefreshCookie },
		});
		expect(refreshAfterDeactivate.statusCode).toBe(401);

		// Auditor consulta trilha de auditoria e confirma registro append-only
		const audLogin = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.10.1.40',
			payload: { email: 'auditor@sicam.gov.br', password: 'Sicam@Auditor2026!' },
		});
		expect(audLogin.statusCode).toBe(200);
		const audToken = audLogin.json().accessToken as string;

		const auditRes = await app.inject({
			method: 'GET',
			url: `/api/v1/audit-logs?entityId=${tempUserId}&limit=10`,
			headers: { authorization: `Bearer ${audToken}` },
		});
		expect(auditRes.statusCode).toBe(200);
		const actions = (auditRes.json().items as Array<{ action: string }>).map((i) => i.action);
		expect(actions).toEqual(expect.arrayContaining(['user_created', 'user_deactivated']));

		// Rate limit estrito em /auth/login (5 tentativas/min por IP -> 6ª tentativa = 429 ERR_RATE_LIMIT_EXCEEDED)
		for (let i = 0; i < 5; i++) {
			await app.inject({
				method: 'POST',
				url: '/api/v1/auth/login',
				remoteAddress: '10.99.99.99',
				payload: { email: 'naoexiste@sicam.gov.br', password: 'WrongPassword123!' },
			});
		}
		const rateLimited = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.99.99.99',
			payload: { email: 'naoexiste@sicam.gov.br', password: 'WrongPassword123!' },
		});
		expect(rateLimited.statusCode).toBe(429);
		expect(rateLimited.json().code).toBe('ERR_RATE_LIMIT_EXCEEDED');
	});

	it('deve validar fronteira Controller (campos obrigatórios) e Service (Zod estrito)', async () => {
		const admLogin = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.10.2.50',
			payload: { email: 'admin@sicam.gov.br', password: 'Sicam@Admin2026!' },
		});
		expect(admLogin.statusCode).toBe(200);
		const admToken = admLogin.json().accessToken as string;

		// 1. Controller ("porteiro"): rejeita campo obrigatório ausente (registrationCode) antes de chegar ao Service
		const missingFieldRes = await app.inject({
			method: 'POST',
			url: '/api/v1/users',
			headers: { authorization: `Bearer ${admToken}` },
			payload: {
				fullName: 'Sem Matrícula',
				email: 'sem.matricula@sicam.gov.br',
				password: 'SenhaForte@2026!',
				role: 'analyst',
			},
		});
		expect(missingFieldRes.statusCode).toBe(400);
		expect(missingFieldRes.headers['content-type']).toContain('application/problem+json');
		expect(missingFieldRes.json()).toMatchObject({
			code: 'ERR_VALIDATION_FAILED',
			invalidParams: [
				expect.objectContaining({
					field: 'registrationCode',
					reason: 'REQUIRED_FIELD_MISSING',
				}),
			],
		});

		// 2. Service ("segurança" + Zod .strict()): rejeita senha curta (< 12 chars) e propriedades extras
		const shortPasswordRes = await app.inject({
			method: 'POST',
			url: '/api/v1/users',
			headers: { authorization: `Bearer ${admToken}` },
			payload: {
				fullName: 'Senha Curta',
				registrationCode: 'TMP-SHORT',
				email: 'senha.curta@sicam.gov.br',
				password: 'Curta123!',
				role: 'analyst',
			},
		});
		expect(shortPasswordRes.statusCode).toBe(400);
		expect(shortPasswordRes.headers['content-type']).toContain('application/problem+json');
		expect(shortPasswordRes.json()).toMatchObject({
			code: 'ERR_VALIDATION_FAILED',
			invalidParams: [
				expect.objectContaining({
					field: 'password',
					reason: 'TOO_SMALL',
				}),
			],
		});

		const extraFieldRes = await app.inject({
			method: 'POST',
			url: '/api/v1/users',
			headers: { authorization: `Bearer ${admToken}` },
			payload: {
				fullName: 'Campo Extra',
				registrationCode: 'TMP-EXTRA',
				email: 'extra.field@sicam.gov.br',
				password: 'SenhaValida@2026!',
				role: 'analyst',
				unexpectedFlag: true,
			},
		});
		expect(extraFieldRes.statusCode).toBe(400);
		expect(extraFieldRes.json().code).toBe('ERR_VALIDATION_FAILED');
	});
});
