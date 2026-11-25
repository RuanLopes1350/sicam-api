import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, withTransaction } from '../config/dbConfig.js';
import type { UserRole } from '../config/db/schema/enums.js';
import { logger } from '../config/loggerConfig.js';
import userRepository from '../repository/userRepository.js';
import auditService from '../service/auditService.js';
import { hashPassword } from '../utils/helpers/crypto.js';

interface SeedOperator {
	fullName: string;
	registrationCode: string;
	email: string;
	password: string;
	role: UserRole;
}

const DEFAULT_DEV_OPERATORS: SeedOperator[] = [
	{
		fullName: 'Administrador Institucional SICAM',
		registrationCode: 'ADM-0001',
		email: 'admin@sicam.gov.br',
		password: process.env.SEED_ADMIN_PASSWORD ?? 'Sicam@Admin2026!',
		role: 'admin',
	},
	{
		fullName: 'Analista Ambiental Sênior',
		registrationCode: 'ANA-0001',
		email: 'analista@sicam.gov.br',
		password: process.env.SEED_ANALYST_PASSWORD ?? 'Sicam@Analista2026!',
		role: 'analyst',
	},
	{
		fullName: 'Auditor Técnico Externo',
		registrationCode: 'AUD-0001',
		email: 'auditor@sicam.gov.br',
		password: process.env.SEED_AUDITOR_PASSWORD ?? 'Sicam@Auditor2026!',
		role: 'auditor',
	},
];

export async function runSeed(): Promise<void> {
	for (const op of DEFAULT_DEV_OPERATORS) {
		const existing = await userRepository.findByEmailWithHash(op.email);

		if (existing) {
			logger.info({ email: op.email, role: op.role }, 'Operador seed já existe — mantido.');
			continue;
		}

		const passwordHash = await hashPassword(op.password);
		await withTransaction(async (tx) => {
			const created = await userRepository.create(
				{
					fullName: op.fullName,
					registrationCode: op.registrationCode,
					email: op.email,
					passwordHash,
					role: op.role,
				},
				tx,
			);

			await auditService.record(
				{
					actorUserId: null,
					action: 'user_created',
					entityType: 'user',
					entityId: created.id,
					correlationId: randomUUID(),
					metadata: { source: 'db:seed', email: op.email, role: op.role },
				},
				tx,
			);
		});

		logger.info({ email: op.email, role: op.role }, 'Operador seed criado com Argon2id.');
	}
}

const isDirectRun =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
	runSeed()
		.then(async () => {
			await closeDb();
			logger.info('Seed inicial concluído com sucesso.');
			process.exit(0);
		})
		.catch(async (err) => {
			logger.error({ err }, 'Falha ao executar seed inicial.');
			await closeDb();
			process.exit(1);
		});
}
