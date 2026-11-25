import fastifySwagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import {
	jsonSchemaTransform,
	serializerCompiler,
	type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { env } from './config/env.js';
import { loggerOptions } from './config/loggerConfig.js';
import { correlationIdPlugin } from './middlewares/correlationId.js';
import { errorHandlerPlugin } from './middlewares/errorHandler.js';
import { authPlugin } from './middlewares/requireAuth.js';
import { securityPlugin } from './middlewares/security.js';
import { auditRoutes } from './routes/auditRoutes.js';
import { authRoutes } from './routes/authRoutes.js';
import { caseRoutes } from './routes/caseRoutes.js';
import { sceneRoutes } from './routes/sceneRoutes.js';
import { systemRoutes } from './routes/systemRoutes.js';
import { territoryRoutes } from './routes/territoryRoutes.js';
import { userRoutes } from './routes/userRoutes.js';

export interface BuildAppOptions {
	dryRun?: boolean;
	useMemoryRateLimit?: boolean;
	silentLogs?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
	const app = Fastify({
		logger: options.silentLogs ? false : loggerOptions,
		trustProxy: true,
	}).withTypeProvider<ZodTypeProvider>();

	// Desacoplamento explícito de camadas:
	// @fastify/swagger usa os schemas Zod das rotas para gerar OpenAPI 3.1, enquanto
	// o Controller ("porteiro") valida presença/RBAC e o Service ("segurança") valida estritamente com Zod.parse().
	app.setValidatorCompiler(() => () => true);
	app.setSerializerCompiler(serializerCompiler);

	// ADR-01 & ADR-12 & OpenAPI Seção 5.1: Especificação OpenAPI 3.1.0 incluindo eventos SSE
	await app.register(fastifySwagger, {
		openapi: {
			openapi: '3.1.0',
			info: {
				title: 'SICAM API — Sistema de Carta-Imagem e Análise Multitemporal',
				description:
					'Contrato oficial REST e Streaming SSE (Zero Trust / SIRGAS 2000 EPSG:4674) para emissão auditável de cartas-imagem ambientais.',
				version: '1.0.0',
			},
			servers: [
				{
					url: 'http://localhost:3333',
					description: 'Ambiente Local de Desenvolvimento',
				},
			],
			components: {
				securitySchemes: {
					bearerAuth: {
						type: 'http',
						scheme: 'bearer',
						bearerFormat: 'JWT (EdDSA)',
						description: 'Access Token JWT assimétrico (Ed25519 / EdDSA) com validade de 15 minutos.',
					},
				},
				schemas: {
					SseSnapshotEvent: {
						type: 'object',
						additionalProperties: false,
						required: ['runId', 'status', 'progressPct', 'step', 'updatedAt'],
						properties: {
							runId: { type: 'string', format: 'uuid' },
							status: {
								type: 'string',
								enum: [
									'queued',
									'fetching_bands',
									'processing_ndvi',
									'vectorizing',
									'ready_for_review',
									'exporting',
									'frozen',
									'failed',
								],
							},
							progressPct: { type: 'integer', minimum: 0, maximum: 100 },
							step: { type: 'string' },
							updatedAt: { type: 'string', format: 'date-time' },
						},
					},
					SseProgressEvent: {
						type: 'object',
						additionalProperties: false,
						required: ['runId', 'status', 'step', 'progressPct', 'timestamp'],
						properties: {
							runId: { type: 'string', format: 'uuid' },
							status: { type: 'string' },
							step: { type: 'string' },
							progressPct: { type: 'integer', minimum: 0, maximum: 100 },
							message: { type: 'string' },
							timestamp: { type: 'string', format: 'date-time' },
						},
					},
					SseRunReadyForReviewEvent: {
						type: 'object',
						additionalProperties: false,
						required: ['runId', 'status', 'summary'],
						properties: {
							runId: { type: 'string', format: 'uuid' },
							status: { type: 'string', const: 'ready_for_review' },
							summary: {
								type: 'object',
								additionalProperties: false,
								required: [
									'deforestationHa',
									'degradationHa',
									'regrowthHa',
									'cloudMaskedHa',
									'featureCount',
								],
								properties: {
									deforestationHa: { type: 'number' },
									degradationHa: { type: 'number' },
									regrowthHa: { type: 'number' },
									cloudMaskedHa: { type: 'number' },
									featureCount: { type: 'integer' },
								},
							},
						},
					},
					SseExportFrozenEvent: {
						type: 'object',
						additionalProperties: false,
						required: [
							'runId',
							'status',
							'exportId',
							'cartographicScale',
							'pdfSha256',
							'zipSha256',
						],
						properties: {
							runId: { type: 'string', format: 'uuid' },
							status: { type: 'string', const: 'frozen' },
							exportId: { type: 'string', format: 'uuid' },
							cartographicScale: { type: 'integer' },
							pdfSha256: { type: 'string', minLength: 64, maxLength: 64 },
							zipSha256: { type: 'string', minLength: 64, maxLength: 64 },
						},
					},
					SseTerminalFailureEvent: {
						type: 'object',
						additionalProperties: false,
						required: ['runId', 'status', 'errorCode', 'message'],
						properties: {
							runId: { type: 'string', format: 'uuid' },
							status: { type: 'string', enum: ['failed', 'ready_for_review'] },
							errorCode: { type: 'string' },
							message: { type: 'string' },
						},
					},
				},
			},
		},
		transform: jsonSchemaTransform,
	});

	await app.register(correlationIdPlugin);
	await app.register(securityPlugin, {
		dryRun: options.dryRun,
		useMemoryRateLimit: options.useMemoryRateLimit,
	});
	await app.register(errorHandlerPlugin);
	await app.register(authPlugin);

	// Prefixo versionado obrigatório (RNF-13)
	await app.register(
		async (v1) => {
			await v1.register(systemRoutes);
			await v1.register(authRoutes);
			await v1.register(userRoutes);
			await v1.register(territoryRoutes);
			await v1.register(caseRoutes);
			await v1.register(sceneRoutes);
			await v1.register(auditRoutes);
		},
		{ prefix: '/api/v1' },
	);

	// Rota de especificação OpenAPI habilitada apenas fora de produção (Seção 5.1)
	if (env.ENABLE_OPENAPI_ROUTE) {
		app.get('/docs/openapi.json', { config: { rateLimit: false } }, async () => {
			return app.swagger();
		});
	}

	return app;
}
