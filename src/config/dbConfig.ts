import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './db/schema/index.js';
import { env } from './env.js';

const { Pool } = pg;

let poolInstance: pg.Pool | null = null;
let dbInstance: NodePgDatabase<typeof schema> | null = null;

export type AppDb = NodePgDatabase<typeof schema>;
export type DbExecutor = Pick<AppDb, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export function getPool(): pg.Pool {
	if (!poolInstance) {
		poolInstance = new Pool({
			connectionString: env.DATABASE_URL,
			max: 15,
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 5_000,
		});
	}
	return poolInstance;
}

export function getDb(): AppDb {
	if (!dbInstance) {
		dbInstance = drizzle(getPool(), { schema });
	}
	return dbInstance;
}

export async function withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
	return getDb().transaction(async (tx) => fn(tx));
}

export async function checkDbReadiness(): Promise<boolean> {
	const pool = getPool();
	const res = await pool.query<{ postgis_ver: string }>('SELECT PostGIS_Version() AS postgis_ver');
	return Boolean(res.rows[0]?.postgis_ver);
}

export async function closeDb(): Promise<void> {
	if (poolInstance) {
		await poolInstance.end();
		poolInstance = null;
		dbInstance = null;
	}
}

export { schema };
