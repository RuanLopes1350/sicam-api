import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../env.js';
import { logger } from '../loggerConfig.js';

const { Client } = pg;

export async function runMigrations(connectionString = env.DATABASE_MIGRATOR_URL): Promise<void> {
	const currentDir = path.dirname(fileURLToPath(import.meta.url));
	const migrationsDir = path.resolve(currentDir, '../../../drizzle/migrations');

	const client = new Client({ connectionString });
	await client.connect();

	try {
		await client.query(`
      CREATE TABLE IF NOT EXISTS _sicam_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

		const files = (await readdir(migrationsDir))
			.filter((f) => f.endsWith('.sql'))
			.sort((a, b) => a.localeCompare(b));

		for (const file of files) {
			const fullPath = path.join(migrationsDir, file);
			const sqlContent = await readFile(fullPath, 'utf8');
			const checksum = createHash('sha256').update(sqlContent).digest('hex');

			const existing = await client.query<{ checksum: string }>(
				'SELECT checksum FROM _sicam_migrations WHERE filename = $1',
				[file],
			);

			if (existing.rowCount && existing.rows[0]) {
				if (existing.rows[0].checksum !== checksum) {
					throw new Error(
						`Divergência de checksum na migration ${file}: esperado ${existing.rows[0].checksum}, encontrado ${checksum}`,
					);
				}
				continue;
			}

			logger.info({ migration: file }, 'Aplicando migration SQL...');
			await client.query('BEGIN');
			try {
				await client.query(sqlContent);
				await client.query(
					'INSERT INTO _sicam_migrations (filename, checksum) VALUES ($1, $2)',
					[file, checksum],
				);
				await client.query('COMMIT');
				logger.info({ migration: file }, 'Migration aplicada com sucesso.');
			} catch (err) {
				await client.query('ROLLBACK');
				throw err;
			}
		}
	} finally {
		await client.end();
	}
}

const isDirectRun =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
	runMigrations()
		.then(() => {
			logger.info('Todas as migrations SQL (0001..0012) foram sincronizadas.');
			process.exit(0);
		})
		.catch((err) => {
			logger.error({ err }, 'Falha ao aplicar migrations SQL.');
			process.exit(1);
		});
}
