import { closeDb } from './config/dbConfig.js';
import { logger } from './config/loggerConfig.js';
import { closeRedis } from './config/redisConfig.js';
import { closeS3, ensurePrivateBucket } from './config/s3Config.js';
import { closeCartographyBrowser } from './utils/geo/cartography/pdfRenderer.js';
import { startCartographyExportWorker } from './workers/cartographyExportWorker.js';
import { startGeoAnalysisWorker } from './workers/geoAnalysisWorker.js';

async function startWorkers(): Promise<void> {
	await ensurePrivateBucket();

	const geoWorker = startGeoAnalysisWorker({ concurrency: 2 });
	const exportWorker = startCartographyExportWorker({ concurrency: 1 });

	const shutdown = async (signal: string) => {
		logger.info({ signal }, 'Iniciando desligamento gracioso do sicam-worker...');
		try {
			await Promise.all([geoWorker.close(), exportWorker.close()]);
			await Promise.all([closeCartographyBrowser(), closeDb(), closeRedis()]);
			closeS3();
			logger.info('Worker encerrado com sucesso.');
			process.exit(0);
		} catch (err) {
			logger.error({ err }, 'Erro ao encerrar sicam-worker.');
			process.exit(1);
		}
	};

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));

	logger.info(
		'Worker dedicado sicam-api (filas geo-analysis e cartography-export) ativo e aguardando jobs.',
	);
}

startWorkers().catch((err) => {
	logger.fatal({ err }, 'Falha fatal ao inicializar sicam-worker.');
	process.exit(1);
});
