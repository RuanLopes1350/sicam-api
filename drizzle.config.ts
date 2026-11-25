import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/config/db/schema/index.ts',
	out: './drizzle/migrations',
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.DATABASE_MIGRATOR_URL ?? 'postgresql://app_migrator:migrator_dev_secret@localhost:5432/sicam',
	},
});
