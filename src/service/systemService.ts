import type { FastifyBaseLogger } from 'fastify';
import { checkDbReadiness } from '../config/dbConfig.js';
import { env } from '../config/env.js';
import {
	ANALYSIS_HARD_BOUNDS,
	ANALYSIS_PRESETS,
	DEFAULT_PAPER_FORMAT,
	SUPPORTED_PAPER_FORMATS,
} from '../config/presets.js';
import { checkRedisReadiness } from '../config/redisConfig.js';
import { checkS3Readiness } from '../config/s3Config.js';
import territoryRepository from '../repository/territoryRepository.js';

class SystemService {
	getLiveStatus() {
		return {
			status: 'ok' as const,
			timestamp: new Date().toISOString(),
		};
	}

	async getReadinessStatus(log: FastifyBaseLogger) {
		const [pgOk, redisOk, s3Ok] = await Promise.all([
			checkDbReadiness().catch((err) => {
				log.error({ err }, 'Falha no healthcheck PostGIS');
				return false;
			}),
			checkRedisReadiness().catch((err) => {
				log.error({ err }, 'Falha no healthcheck Redis');
				return false;
			}),
			checkS3Readiness().catch((err) => {
				log.error({ err }, 'Falha no healthcheck S3');
				return false;
			}),
		]);

		const allReady = pgOk && redisOk && s3Ok;
		return {
			allReady,
			payload: {
				status: allReady ? ('ready' as const) : ('degraded' as const),
				checks: {
					postgis: pgOk,
					redis: redisOk,
					s3: s3Ok,
				},
				timestamp: new Date().toISOString(),
			},
		};
	}

	async getCapabilities() {
		const states = await territoryRepository.findLoadedUfSummaries();

		return {
			aoi: {
				minAreaHa: env.MIN_AOI_AREA_HA,
				maxAreaHa: env.MAX_AOI_AREA_HA,
				maxVertices: env.MAX_AOI_VERTICES,
				enforceLoadedUfs: env.ENFORCE_IMPORTED_UF_COVERAGE,
				loadedUfs: states,
			},
			analysis: {
				maxActiveRunsPerUser: env.MAX_ACTIVE_RUNS_PER_USER,
				presets: {
					TECHNICAL_STANDARD: { ...ANALYSIS_PRESETS.TECHNICAL_STANDARD },
					CONSERVATIVE: { ...ANALYSIS_PRESETS.CONSERVATIVE },
				},
				hardBounds: {
					ndviForestMin: { ...ANALYSIS_HARD_BOUNDS.ndviForestMin },
					ndviClearedMax: { ...ANALYSIS_HARD_BOUNDS.ndviClearedMax },
					deforestationDeltaMax: { ...ANALYSIS_HARD_BOUNDS.deforestationDeltaMax },
					degradationDeltaMax: { ...ANALYSIS_HARD_BOUNDS.degradationDeltaMax },
					regrowthStartMax: { ...ANALYSIS_HARD_BOUNDS.regrowthStartMax },
					regrowthEndMin: { ...ANALYSIS_HARD_BOUNDS.regrowthEndMin },
					regrowthDeltaMin: { ...ANALYSIS_HARD_BOUNDS.regrowthDeltaMin },
					morphologicalKernel: [0, 3] as [0, 3],
					minMappingUnitHa: { ...ANALYSIS_HARD_BOUNDS.minMappingUnitHa },
				},
			},
			export: {
				supportedPaperFormats: [...SUPPORTED_PAPER_FORMATS],
				defaultPaperFormat: DEFAULT_PAPER_FORMAT,
			},
		};
	}
}

export default new SystemService();
