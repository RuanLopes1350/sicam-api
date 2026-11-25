import { z } from 'zod';
import {
	ANALYSIS_HARD_BOUNDS,
	ANALYSIS_PRESETS,
	type AlgorithmParams,
} from '../../../config/presets.js';
import { DomainError, type InvalidParamDetail } from '../../helpers/domainError.js';
import { classifySclPixel } from '../sclAnalyzer.js';
import type { CanonicalSceneBands } from './cogBandReader.js';

export const PIXEL_CLASS = {
	STABLE: 0,
	DEFORESTATION: 1,
	DEGRADATION: 2,
	REGROWTH: 3,
	CLOUD_OBSTRUCTED: 255,
} as const;

export type PixelClassCode = (typeof PIXEL_CLASS)[keyof typeof PIXEL_CLASS];

export const CustomAlgorithmParamsSchema = z
	.object({
		ndviForestMin: z.number().finite(),
		ndviClearedMax: z.number().finite(),
		deforestationDeltaMax: z.number().finite(),
		degradationDeltaMax: z.number().finite(),
		regrowthStartMax: z.number().finite(),
		regrowthEndMin: z.number().finite(),
		regrowthDeltaMin: z.number().finite(),
		morphologicalKernel: z.union([z.literal(0), z.literal(3)]),
		minMappingUnitHa: z.number().finite(),
	})
	.strict();

const NUMERIC_BOUND_KEYS = [
	'ndviForestMin',
	'ndviClearedMax',
	'deforestationDeltaMax',
	'degradationDeltaMax',
	'regrowthStartMax',
	'regrowthEndMin',
	'regrowthDeltaMin',
	'minMappingUnitHa',
] as const;

// Zero Trust (Matriz + OpenAPI Seção 3): Impõe hard bounds e invariantes espectrais
export function resolveAndValidateAlgorithmParams(
	presetName: string,
	customParams?: unknown,
): { params: AlgorithmParams; isCustomParams: boolean } {
	if (presetName === 'TECHNICAL_STANDARD' || presetName === 'CONSERVATIVE') {
		if (customParams !== null && customParams !== undefined) {
			throw new DomainError(
				'ERR_PARAMS_OUT_OF_BOUNDS',
				`customParams deve ser nulo quando o preset '${presetName}' é selecionado.`,
				{
					invalidParams: [{ field: 'customParams', reason: 'MUST_BE_NULL_FOR_PRESET' }],
				},
			);
		}
		return {
			params: { ...ANALYSIS_PRESETS[presetName] },
			isCustomParams: false,
		};
	}

	if (presetName !== 'CUSTOM') {
		throw new DomainError(
			'ERR_PARAMS_OUT_OF_BOUNDS',
			`Preset de análise inválido ('${presetName}'). Valores aceitos: TECHNICAL_STANDARD, CONSERVATIVE, CUSTOM.`,
			{
				invalidParams: [{ field: 'presetName', reason: 'INVALID_PRESET_NAME' }],
			},
		);
	}

	const parsed = CustomAlgorithmParamsSchema.safeParse(customParams);
	if (!parsed.success) {
		throw new DomainError(
			'ERR_PARAMS_OUT_OF_BOUNDS',
			'Parâmetros customizados obrigatórios ou malformados para presetName = CUSTOM.',
			{
				invalidParams: parsed.error.issues.map((issue) => ({
					field: `customParams.${issue.path.join('.')}`,
					reason: issue.code.toUpperCase(),
					meta: { message: issue.message },
				})),
			},
		);
	}

	const params = parsed.data;
	const violations: InvalidParamDetail[] = [];

	for (const key of NUMERIC_BOUND_KEYS) {
		const bound = ANALYSIS_HARD_BOUNDS[key];
		const value = params[key];
		if (value < bound.min || value > bound.max) {
			violations.push({
				field: `customParams.${key}`,
				reason: 'HARD_BOUND_EXCEEDED',
				meta: { value, min: bound.min, max: bound.max },
			});
		}
	}

	if (params.ndviForestMin <= params.ndviClearedMax) {
		violations.push({
			field: 'customParams.ndviForestMin',
			reason: 'INVARIANT_FOREST_ABOVE_CLEARED',
			meta: {
				ndviForestMin: params.ndviForestMin,
				ndviClearedMax: params.ndviClearedMax,
			},
		});
	}

	if (params.deforestationDeltaMax > params.degradationDeltaMax) {
		violations.push({
			field: 'customParams.deforestationDeltaMax',
			reason: 'INVARIANT_DEFORESTATION_DELTA_STRONGER_THAN_DEGRADATION',
			meta: {
				deforestationDeltaMax: params.deforestationDeltaMax,
				degradationDeltaMax: params.degradationDeltaMax,
			},
		});
	}

	if (params.regrowthEndMin <= params.regrowthStartMax) {
		violations.push({
			field: 'customParams.regrowthEndMin',
			reason: 'INVARIANT_REGROWTH_END_ABOVE_START',
			meta: {
				regrowthStartMax: params.regrowthStartMax,
				regrowthEndMin: params.regrowthEndMin,
			},
		});
	}

	if (violations.length > 0) {
		throw new DomainError(
			'ERR_PARAMS_OUT_OF_BOUNDS',
			'Os parâmetros espectrais customizados violam os limites técnicos do motor geo-core.',
			{ invalidParams: violations },
		);
	}

	return {
		params,
		isCustomParams: true,
	};
}

export interface NdviClassificationMetrics {
	aoiTotalPixels: number;
	validAnalyzedPixels: number;
	cloudMaskedPixels: number;
	deforestationPixels: number;
	degradationPixels: number;
	regrowthPixels: number;
	stablePixels: number;
	cloudObstructionPct: number;
	visibilityCompromisedWarning: boolean;
	approxValidAnalyzedHa: number;
	approxCloudMaskedHa: number;
	approxDeforestationHa: number;
	approxDegradationHa: number;
	approxRegrowthHa: number;
	approxStableHa: number;
}

export interface NdviClassificationResult {
	ndviT0: Float32Array;
	ndviT1: Float32Array;
	deltaNdvi: Float32Array;
	classMap: Uint8Array;
	metrics: NdviClassificationMetrics;
}

// Spec Parte I — Seções 4.2 e 4.3 + RN-03 + RN-04: Matriz de classificação ΔNDVI sobre pixels válidos na AOI
export function classifyMultitemporalNdvi(params: {
	t0: Pick<CanonicalSceneBands, 'red' | 'nir' | 'scl'>;
	t1: Pick<CanonicalSceneBands, 'red' | 'nir' | 'scl'>;
	aoiMask: Uint8Array;
	algorithmParams: AlgorithmParams;
}): NdviClassificationResult {
	const { t0, t1, aoiMask, algorithmParams } = params;
	const length = aoiMask.length;

	if (
		t0.red.length !== length ||
		t0.nir.length !== length ||
		t0.scl.length !== length ||
		t1.red.length !== length ||
		t1.nir.length !== length ||
		t1.scl.length !== length
	) {
		throw new DomainError(
			'ERR_INTERNAL_SERVER_ERROR',
			'Dimensões inconsistentes entre os buffers espectrais e a máscara da AOI.',
		);
	}

	const ndviT0 = new Float32Array(length).fill(Number.NaN);
	const ndviT1 = new Float32Array(length).fill(Number.NaN);
	const deltaNdvi = new Float32Array(length).fill(Number.NaN);
	const classMap = new Uint8Array(length); // 0 fora da AOI / estável

	let aoiTotalPixels = 0;
	let validAnalyzedPixels = 0;
	let cloudMaskedPixels = 0;
	let deforestationPixels = 0;
	let degradationPixels = 0;
	let regrowthPixels = 0;
	let stablePixels = 0;

	const {
		ndviForestMin,
		ndviClearedMax,
		deforestationDeltaMax,
		degradationDeltaMax,
		regrowthStartMax,
		regrowthEndMin,
		regrowthDeltaMin,
	} = algorithmParams;

	for (let i = 0; i < length; i++) {
		if (aoiMask[i] !== 1) {
			continue;
		}

		aoiTotalPixels++;

		const scl0 = t0.scl[i]!;
		const scl1 = t1.scl[i]!;
		const red0 = t0.red[i]!;
		const nir0 = t0.nir[i]!;
		const red1 = t1.red[i]!;
		const nir1 = t1.nir[i]!;

		const isSclValid =
			classifySclPixel(scl0) === 'clean' && classifySclPixel(scl1) === 'clean';
		const isReflectanceValid =
			!Number.isNaN(red0) && !Number.isNaN(nir0) && !Number.isNaN(red1) && !Number.isNaN(nir1);

		// RN-04: Pixels obstruídos por nuvem/sombra ou NoData em T0 ou T1 jamais são contabilizados como estáveis
		if (!isSclValid || !isReflectanceValid) {
			classMap[i] = PIXEL_CLASS.CLOUD_OBSTRUCTED;
			cloudMaskedPixels++;
			continue;
		}

		const vNdvi0 = (nir0 - red0) / (nir0 + red0 + 1e-6);
		const vNdvi1 = (nir1 - red1) / (nir1 + red1 + 1e-6);
		const vDelta = vNdvi1 - vNdvi0;

		ndviT0[i] = vNdvi0;
		ndviT1[i] = vNdvi1;
		deltaNdvi[i] = vDelta;
		validAnalyzedPixels++;

		// RN-03: Trava de classificação por transição de estado
		if (vNdvi0 >= ndviForestMin && vNdvi1 <= ndviClearedMax && vDelta <= deforestationDeltaMax) {
			classMap[i] = PIXEL_CLASS.DEFORESTATION;
			deforestationPixels++;
		} else if (vNdvi0 >= ndviForestMin && vNdvi1 > ndviClearedMax && vDelta <= degradationDeltaMax) {
			classMap[i] = PIXEL_CLASS.DEGRADATION;
			degradationPixels++;
		} else if (vNdvi0 <= regrowthStartMax && vNdvi1 >= regrowthEndMin && vDelta >= regrowthDeltaMin) {
			classMap[i] = PIXEL_CLASS.REGROWTH;
			regrowthPixels++;
		} else {
			classMap[i] = PIXEL_CLASS.STABLE;
			stablePixels++;
		}
	}

	const cloudObstructionPct =
		aoiTotalPixels > 0 ? Number(((cloudMaskedPixels / aoiTotalPixels) * 100).toFixed(2)) : 100;

	return {
		ndviT0,
		ndviT1,
		deltaNdvi,
		classMap,
		metrics: {
			aoiTotalPixels,
			validAnalyzedPixels,
			cloudMaskedPixels,
			deforestationPixels,
			degradationPixels,
			regrowthPixels,
			stablePixels,
			cloudObstructionPct,
			// RN-04: Selo explícito de visibilidade comprometida se obstrução > 50%
			visibilityCompromisedWarning: cloudObstructionPct > 50,
			approxValidAnalyzedHa: Number((validAnalyzedPixels * 0.01).toFixed(4)),
			approxCloudMaskedHa: Number((cloudMaskedPixels * 0.01).toFixed(4)),
			approxDeforestationHa: Number((deforestationPixels * 0.01).toFixed(4)),
			approxDegradationHa: Number((degradationPixels * 0.01).toFixed(4)),
			approxRegrowthHa: Number((regrowthPixels * 0.01).toFixed(4)),
			approxStableHa: Number((stablePixels * 0.01).toFixed(4)),
		},
	};
}
