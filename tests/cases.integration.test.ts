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

describe('Task API-04 — Gestão de Casos e Validação Espacial Zero Trust da AOI (Integração)', () => {
	let app: FastifyInstance;
	let analystToken: string;
	let adminToken: string;
	let auditorToken: string;

	beforeAll(async () => {
		await runMigrations();
		await ensurePrivateBucket();
		await runSeed();

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

		const [anaRes, admRes, audRes] = await Promise.all([
			app.inject({
				method: 'POST',
				url: '/api/v1/auth/login',
				remoteAddress: '10.20.1.1',
				payload: { email: 'analista@sicam.gov.br', password: 'Sicam@Analista2026!' },
			}),
			app.inject({
				method: 'POST',
				url: '/api/v1/auth/login',
				remoteAddress: '10.20.1.2',
				payload: { email: 'admin@sicam.gov.br', password: 'Sicam@Admin2026!' },
			}),
			app.inject({
				method: 'POST',
				url: '/api/v1/auth/login',
				remoteAddress: '10.20.1.3',
				payload: { email: 'auditor@sicam.gov.br', password: 'Sicam@Auditor2026!' },
			}),
		]);

		analystToken = anaRes.json().accessToken as string;
		adminToken = admRes.json().accessToken as string;
		auditorToken = audRes.json().accessToken as string;
	});

	afterAll(async () => {
		if (app) await app.close();
		await closeDb();
		await closeRedis();
		closeS3();
	});

	it('deve criar Caso válido em Vilhena/RO com cálculo oficial SIRGAS 2000 UTM (EPSG:31980) e protocolo sequencial', async () => {
		const createRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Monitoramento Setor Sul — Gleba 04',
				externalRef: 'PROC-2026-0891',
				description: 'Verificação multitemporal na região de Vilhena.',
				aoiGeoJson: {
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
				},
			},
		});

		expect(createRes.statusCode).toBe(201);
		const body = createRes.json();
		expect(body.protocolCode).toMatch(/^CI-\d{4}-\d{6}$/);
		expect(body.utmSrid).toBe(31980);
		expect(body.stateUf).toBe('RO');
		expect(body.primaryMunicipality).toEqual({
			ibgeCode: '1100304',
			name: 'Vilhena',
			ufCode: 'RO',
		});
		expect(body.aoiAreaHa).toBeGreaterThan(2900);
		expect(body.aoiAreaHa).toBeLessThan(3100);
		expect(body.aoiPerimeterM).toBeGreaterThan(21000);
		expect(body.intersectedMunicipalities[0]?.overlapPct).toBe(100);

		const caseId = body.id as string;

		// Admin e Auditor podem consultar detalhe e listagem (leitura permitida)
		const detailRes = await app.inject({
			method: 'GET',
			url: `/api/v1/cases/${caseId}`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(detailRes.statusCode).toBe(200);
		expect(detailRes.json()).toMatchObject({
			id: caseId,
			protocolCode: body.protocolCode,
			runs: [],
		});

		// Filtro espacial bbox + município na listagem (acionando índice GiST)
		const listInsideBbox = await app.inject({
			method: 'GET',
			url: '/api/v1/cases?bbox=-60.25,-12.75,-60.10,-12.60&municipalityIbge=1100304&status=no_runs',
			headers: { authorization: `Bearer ${adminToken}` },
		});
		expect(listInsideBbox.statusCode).toBe(200);
		expect(
			(listInsideBbox.json().items as Array<{ id: string }>).some((c) => c.id === caseId),
		).toBe(true);

		const listOutsideBbox = await app.inject({
			method: 'GET',
			url: '/api/v1/cases?bbox=-65.0,-10.0,-64.5,-9.5',
			headers: { authorization: `Bearer ${adminToken}` },
		});
		expect(listOutsideBbox.statusCode).toBe(200);
		expect(
			(listOutsideBbox.json().items as Array<{ id: string }>).some((c) => c.id === caseId),
		).toBe(false);

		// Auditoria registrou case_created
		const auditRes = await app.inject({
			method: 'GET',
			url: `/api/v1/audit-logs?entityId=${caseId}&action=case_created`,
			headers: { authorization: `Bearer ${auditorToken}` },
		});
		expect(auditRes.statusCode).toBe(200);
		expect(auditRes.json().items.length).toBe(1);
	});

	it('deve bloquear criação e mutação de Caso para perfis Admin e Auditor (RBAC Zero Trust)', async () => {
		const validPayload = {
			title: 'Tentativa Indevida',
			aoiGeoJson: {
				type: 'Polygon',
				coordinates: [
					[
						[-60.2, -12.7],
						[-60.18, -12.7],
						[-60.18, -12.68],
						[-60.2, -12.68],
						[-60.2, -12.7],
					],
				],
			},
		};

		for (const token of [adminToken, auditorToken]) {
			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/cases',
				headers: { authorization: `Bearer ${token}` },
				payload: validPayload,
			});
			expect(res.statusCode).toBe(403);
			expect(res.json().code).toBe('ERR_FORBIDDEN_ROLE');
		}
	});

	it('deve rejeitar geometrias inválidas, buracos, auto-interseção, >500 vértices, área fora de [0.5, 50000] ha e UF não coberta', async () => {
		// 1. Tipo diferente de Polygon -> 422 ERR_INVALID_GEOMETRY
		const multiPolyRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'MultiPolygon Inválido',
				aoiGeoJson: {
					type: 'MultiPolygon',
					coordinates: [],
				},
			},
		});
		expect(multiPolyRes.statusCode).toBe(422);
		expect(multiPolyRes.json().code).toBe('ERR_INVALID_GEOMETRY');

		// 2. Polígono com buraco (2 anéis) -> 422 ERR_INVALID_GEOMETRY
		const holeRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Polígono com Buraco',
				aoiGeoJson: {
					type: 'Polygon',
					coordinates: [
						[
							[-60.2, -12.7],
							[-60.15, -12.7],
							[-60.15, -12.65],
							[-60.2, -12.65],
							[-60.2, -12.7],
						],
						[
							[-60.18, -12.68],
							[-60.17, -12.68],
							[-60.17, -12.67],
							[-60.18, -12.67],
							[-60.18, -12.68],
						],
					],
				},
			},
		});
		expect(holeRes.statusCode).toBe(422);
		expect(holeRes.json().code).toBe('ERR_INVALID_GEOMETRY');

		// 3. Auto-interseção (gravata-borboleta / bowtie) -> 422 ERR_INVALID_GEOMETRY via ST_IsValid no PostGIS
		const bowtieRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Polígono Auto-Intersectante',
				aoiGeoJson: {
					type: 'Polygon',
					coordinates: [
						[
							[-60.2, -12.7],
							[-60.15, -12.65],
							[-60.2, -12.65],
							[-60.15, -12.7],
							[-60.2, -12.7],
						],
					],
				},
			},
		});
		expect(bowtieRes.statusCode).toBe(422);
		expect(bowtieRes.json().code).toBe('ERR_INVALID_GEOMETRY');

		// 4. Mais de 500 vértices (DoS geoespacial) -> 422 ERR_INVALID_GEOMETRY
		const circleRing: [number, number][] = [];
		const numVerts = 505;
		for (let i = 0; i < numVerts; i++) {
			const angle = (2 * Math.PI * i) / numVerts;
			circleRing.push([
				Number((-60.2 + 0.02 * Math.cos(angle)).toFixed(6)),
				Number((-12.7 + 0.02 * Math.sin(angle)).toFixed(6)),
			]);
		}
		circleRing.push(circleRing[0]!);

		const tooManyVertsRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Excesso de Vértices',
				aoiGeoJson: { type: 'Polygon', coordinates: [circleRing] },
			},
		});
		expect(tooManyVertsRes.statusCode).toBe(422);
		expect(tooManyVertsRes.json().code).toBe('ERR_INVALID_GEOMETRY');

		// 5. Área minúscula (< 0.5 ha: ~10m x 10m = 0.01 ha) -> 422 ERR_AOI_AREA_OUT_OF_BOUNDS
		const tinyAreaRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Área Minúscula',
				aoiGeoJson: {
					type: 'Polygon',
					coordinates: [
						[
							[-60.2, -12.7],
							[-60.1999, -12.7],
							[-60.1999, -12.6999],
							[-60.2, -12.6999],
							[-60.2, -12.7],
						],
					],
				},
			},
		});
		expect(tinyAreaRes.statusCode).toBe(422);
		expect(tinyAreaRes.json().code).toBe('ERR_AOI_AREA_OUT_OF_BOUNDS');

		// 6. Área gigante (> 50.000 ha: ~0.35° x 0.35° ≈ 147.000 ha) -> 422 ERR_AOI_AREA_OUT_OF_BOUNDS
		const hugeAreaRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Área Acima do Limite',
				aoiGeoJson: {
					type: 'Polygon',
					coordinates: [
						[
							[-60.4, -12.9],
							[-60.05, -12.9],
							[-60.05, -12.55],
							[-60.4, -12.55],
							[-60.4, -12.9],
						],
					],
				},
			},
		});
		expect(hugeAreaRes.statusCode).toBe(422);
		expect(hugeAreaRes.json().code).toBe('ERR_AOI_AREA_OUT_OF_BOUNDS');

		// 7. Polígono válido em UF não importada (ex: Mato Grosso / São Paulo -47.5, -22.5) -> 422 ERR_UF_NOT_COVERED
		const uncoveredUfRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'UF Não Coberta',
				aoiGeoJson: {
					type: 'Polygon',
					coordinates: [
						[
							[-47.5, -22.5],
							[-47.48, -22.5],
							[-47.48, -22.48],
							[-47.5, -22.48],
							[-47.5, -22.5],
						],
					],
				},
			},
		});
		expect(uncoveredUfRes.statusCode).toBe(422);
		expect(uncoveredUfRes.json().code).toBe('ERR_UF_NOT_COVERED');
	});

	it('deve permitir PATCH apenas em metadados textuais e garantir imutabilidade absoluta da AOI na API e no Banco', async () => {
		const createRes = await app.inject({
			method: 'POST',
			url: '/api/v1/cases',
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Caso Original Imutável',
				aoiGeoJson: {
					type: 'Polygon',
					coordinates: [
						[
							[-60.22, -12.72],
							[-60.19, -12.72],
							[-60.19, -12.69],
							[-60.22, -12.69],
							[-60.22, -12.72],
						],
					],
				},
			},
		});
		expect(createRes.statusCode).toBe(201);
		const created = createRes.json();

		// 1. Atualização textual legítima -> 200 OK
		const patchOk = await app.inject({
			method: 'PATCH',
			url: `/api/v1/cases/${created.id}`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Caso Atualizado — Gleba Revisada',
				externalRef: 'OFICIO-44/2026',
			},
		});
		expect(patchOk.statusCode).toBe(200);
		expect(patchOk.json()).toMatchObject({
			id: created.id,
			protocolCode: created.protocolCode,
			title: 'Caso Atualizado — Gleba Revisada',
			externalRef: 'OFICIO-44/2026',
			aoiAreaHa: created.aoiAreaHa,
		});

		// 2. Tentativa de alterar aoiGeoJson via PATCH -> rejeitada pelo Zod .strict() (400 ERR_VALIDATION_FAILED)
		const patchGeoAttempt = await app.inject({
			method: 'PATCH',
			url: `/api/v1/cases/${created.id}`,
			headers: { authorization: `Bearer ${analystToken}` },
			payload: {
				title: 'Tentativa Fraude AOI',
				aoiGeoJson: created.aoiGeoJson,
			},
		});
		expect(patchGeoAttempt.statusCode).toBe(400);
		expect(patchGeoAttempt.json().code).toBe('ERR_VALIDATION_FAILED');

		// 3. Defesa em profundidade no banco: trigger trg_analysis_cases_geo_guard bloqueia mutação SQL direta na AOI
		const pool = getPool();
		await expect(
			pool.query(
				`UPDATE analysis_cases
         SET aoi_geom = ST_SetSRID(ST_MakeEnvelope(-60.3, -12.8, -60.25, -12.75), 4674)
         WHERE id = $1`,
				[created.id],
			),
		).rejects.toThrow();
	});
});
