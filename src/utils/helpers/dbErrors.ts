import pg from 'pg';
import { logger } from '../../config/loggerConfig.js';
import { DomainError } from './domainError.js';

const { DatabaseError: PgDatabaseError } = pg;

// Converte erros do PostgreSQL/PostGIS/Triggers PL/pgSQL em DomainError seguros (Zero Trust: zero vazamento de SQL/tabelas)
export function parseDatabaseError(error: unknown, context: string): DomainError {
	if (error instanceof DomainError) {
		return error;
	}

	const candidates = [error, (error as { cause?: unknown })?.cause];

	for (const candidate of candidates) {
		if (candidate instanceof PgDatabaseError) {
			const pgCode = candidate.code;
			logger.warn(
				{
					context,
					pgCode,
					constraint: candidate.constraint,
				},
				'Erro de integridade/trigger retornado pelo PostgreSQL',
			);

			if (pgCode === '42501') {
				if (candidate.message.includes('ready_for_review') || candidate.message.includes('Revisão bloqueada')) {
					return new DomainError(
						'ERR_RUN_NOT_REVIEWABLE',
						'A execução informada não está disponível para revisão ou exportação.',
					);
				}
				return new DomainError(
					'ERR_RUN_FROZEN',
					'Operação bloqueada pela política de imutabilidade e cadeia de custódia.',
				);
			}

			if (pgCode === '22023') {
				return new DomainError(
					'ERR_INVALID_GEOMETRY',
					'A geometria da AOI de um caso criado é imutável ou inválida.',
				);
			}

			if (pgCode === '23505') {
				return new DomainError(
					'ERR_RESOURCE_CONFLICT',
					'Já existe um registro cadastrado com o identificador ou código único informado.',
				);
			}

			if (pgCode === '23503') {
				return new DomainError(
					'ERR_RESOURCE_NOT_FOUND',
					'O recurso relacionado informado não foi encontrado.',
				);
			}

			if (pgCode === '23514' || pgCode === '23502' || pgCode === '22001' || pgCode === '22003') {
				return new DomainError(
					'ERR_VALIDATION_FAILED',
					'Os valores informados violam as restrições de integridade do domínio.',
				);
			}

			return new DomainError(
				'ERR_INTERNAL_SERVER_ERROR',
				'Ocorreu um erro interno ao processar a persistência de dados.',
			);
		}
	}

	logger.error({ context, err: error }, 'Erro inesperado na camada de banco de dados');
	return new DomainError(
		'ERR_INTERNAL_SERVER_ERROR',
		'Ocorreu um erro interno ao processar a operação.',
	);
}
