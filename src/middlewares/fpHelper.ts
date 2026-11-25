import type { FastifyPluginAsync, FastifyPluginOptions } from 'fastify';

// Marca o plugin Fastify como não-encapsulado (skip-override) preservando a assinatura nativa do Fastify v5
export default function fp<Options extends FastifyPluginOptions = FastifyPluginOptions>(
	fn: FastifyPluginAsync<Options>,
): FastifyPluginAsync<Options> {
	(fn as unknown as Record<symbol | string, unknown>)[Symbol.for('skip-override')] = true;
	return fn;
}
