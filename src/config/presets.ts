export interface AlgorithmParams {
	ndviForestMin: number;
	ndviClearedMax: number;
	deforestationDeltaMax: number;
	degradationDeltaMax: number;
	regrowthStartMax: number;
	regrowthEndMin: number;
	regrowthDeltaMin: number;
	morphologicalKernel: 0 | 3;
	minMappingUnitHa: number;
}

export const ANALYSIS_PRESETS: Record<'TECHNICAL_STANDARD' | 'CONSERVATIVE', AlgorithmParams> = {
	TECHNICAL_STANDARD: {
		ndviForestMin: 0.62,
		ndviClearedMax: 0.42,
		deforestationDeltaMax: -0.25,
		degradationDeltaMax: -0.15,
		regrowthStartMax: 0.45,
		regrowthEndMin: 0.60,
		regrowthDeltaMin: 0.25,
		morphologicalKernel: 3,
		minMappingUnitHa: 0.25,
	},
	CONSERVATIVE: {
		ndviForestMin: 0.68,
		ndviClearedMax: 0.35,
		deforestationDeltaMax: -0.32,
		degradationDeltaMax: -0.20,
		regrowthStartMax: 0.40,
		regrowthEndMin: 0.65,
		regrowthDeltaMin: 0.30,
		morphologicalKernel: 3,
		minMappingUnitHa: 0.50,
	},
} as const;

export const ANALYSIS_HARD_BOUNDS = {
	ndviForestMin: { min: 0.45, max: 0.85 },
	ndviClearedMax: { min: 0.15, max: 0.55 },
	deforestationDeltaMax: { min: -0.60, max: -0.15 },
	degradationDeltaMax: { min: -0.40, max: -0.10 },
	regrowthStartMax: { min: 0.20, max: 0.55 },
	regrowthEndMin: { min: 0.50, max: 0.80 },
	regrowthDeltaMin: { min: 0.15, max: 0.60 },
	morphologicalKernel: [0, 3] as const,
	minMappingUnitHa: { min: 0.10, max: 10.0 },
} as const;

export const SUPPORTED_PAPER_FORMATS = ['A4', 'A3'] as const;
export const DEFAULT_PAPER_FORMAT = 'A3' as const;

// RN-02: Lista estática e imutável de domínios permitidos para STAC e COG (Anti-SSRF)
export const STAC_WHITELISTED_HOSTS = new Set<string>([
	'earth-search.aws.element84.com',
	'sentinel-cogs.s3.us-west-2.amazonaws.com',
	'data.inpe.br',
	'bdc.dpi.inpe.br',
]);
