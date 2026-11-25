import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../config/loggerConfig.js';
import territoryService from '../service/territoryService.js';

function parseUfArg(argv: string[]): string {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg) continue;
		if (arg.startsWith('--uf=')) {
			return arg.slice('--uf='.length);
		}
		if (arg === '--uf' && argv[i + 1]) {
			return argv[i + 1] ?? 'RO';
		}
	}
	return 'RO';
}

const isDirectRun =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
	const uf = parseUfArg(process.argv.slice(2));
	territoryService
		.importIbgeStateFromApi(uf)
		.then(() => process.exit(0))
		.catch((err) => {
			logger.error({ err, uf }, 'Falha ao importar malha territorial do IBGE.');
			process.exit(1);
		});
}
