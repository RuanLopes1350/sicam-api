import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { getRedis } from '../config/redisConfig.js';
import fp from './fpHelper.js';

export interface SecurityPluginOptions {
	dryRun?: boolean;
	useMemoryRateLimit?: boolean;
}

// RNF-03 & RNF-04: Headers de segurança Helmet, CORS estrito, Cookies HttpOnly e Rate Limiting
export const securityPlugin = fp<SecurityPluginOptions>(async (app: FastifyInstance, opts) => {
	await app.register(fastifyHelmet, {
		global: true,
		frameguard: { action: 'deny' },
		noSniff: true,
		hsts: {
			maxAge: 31_536_000,
			includeSubDomains: true,
		},
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'none'"],
				frameAncestors: ["'none'"],
			},
		},
	});

	const allowedOrigins = env.FRONTEND_ORIGIN.split(',')
		.map((o) => o.trim())
		.filter(Boolean);

	await app.register(fastifyCors, {
		origin: allowedOrigins,
		credentials: true,
		methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
		allowedHeaders: [
			'Content-Type',
			'Authorization',
			'X-Request-Id',
			'Idempotency-Key',
			'Last-Event-ID',
			'Cache-Control',
		],
		exposedHeaders: ['X-Request-Id', 'X-Artifact-SHA256', 'Retry-After', 'Content-Disposition'],
	});

	await app.register(fastifyCookie);

	await app.register(fastifyMultipart, {
		limits: {
			fileSize: 100 * 1024 * 1024, // 100 MB (POST /integrity/verify)
			files: 1,
		},
	});

	await app.register(fastifyRateLimit, {
		global: true,
		max: 60,
		timeWindow: '1 minute',
		addHeadersOnExceeding: {
			'x-ratelimit-limit': true,
			'x-ratelimit-remaining': true,
			'x-ratelimit-reset': true,
		},
		addHeaders: {
			'x-ratelimit-limit': true,
			'x-ratelimit-remaining': true,
			'x-ratelimit-reset': true,
			'retry-after': true,
		},
		keyGenerator: (request) => {
			return request.authUser?.id ?? request.ip;
		},
		...(opts.dryRun || opts.useMemoryRateLimit ? {} : { redis: getRedis() }),
	});
});
