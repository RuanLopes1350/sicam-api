import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { logger } from '../config/loggerConfig.js';

// OpenAPI Seção 5.1: Exporta openapi/openapi.v1.json em modo dry-run sem conectar ao banco ou Redis
async function exportOpenApiSpec(): Promise<void> {
	const app = await buildApp({ dryRun: true, silentLogs: true });
	await app.ready();

	const spec = app.swagger();
	const currentDir = path.dirname(fileURLToPath(import.meta.url));
	const outDir = path.resolve(currentDir, '../../openapi');
	const outFile = path.join(outDir, 'openapi.v1.json');

	await mkdir(outDir, { recursive: true });
	await writeFile(outFile, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
	await app.close();

	logger.info(
		{ outFile, openapiVersion: (spec as { openapi?: string }).openapi ?? '3.1.0' },
		'Contrato OpenAPI 3.1 exportado com sucesso.',
	);
}

exportOpenApiSpec().catch((err) => {
	logger.error({ err }, 'Falha ao exportar contrato OpenAPI 3.1.');
	process.exit(1);
});
