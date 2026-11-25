import { buildApp } from './app.js';
import { closeDb } from './config/dbConfig.js';
import { env } from './config/env.js';
import { logger } from './config/loggerConfig.js';
import { closeRedis } from './config/redisConfig.js';
import { closeS3, ensurePrivateBucket } from './config/s3Config.js';

async function startServer(): Promise<void> {
	await ensurePrivateBucket();

	const app = await buildApp();

	const shutdown = async (signal: string) => {
		logger.info({ signal }, 'Iniciando desligamento gracioso do sicam-api...');
		try {
			await app.close();
			await Promise.all([closeDb(), closeRedis()]);
			closeS3();
			logger.info('Recursos encerrados com sucesso.');
			process.exit(0);
		} catch (err) {
			logger.error({ err }, 'Erro durante desligamento do servidor.');
			process.exit(1);
		}
	};

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));

	await app.listen({ host: env.HOST, port: env.PORT });
	logger.info(
		{ host: env.HOST, port: env.PORT, env: env.NODE_ENV },
		'Servidor HTTP sicam-api ativo e pronto.',
	);
}

startServer().catch((err) => {
	logger.fatal({ err }, 'Falha fatal ao inicializar sicam-api.');
	process.exit(1);
});
