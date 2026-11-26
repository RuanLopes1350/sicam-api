import type { FeatureClass, StacProvider } from '../../../config/db/schema/enums.js';
import type { AlgorithmParams } from '../../../config/presets.js';
import type { SafeFetchOptions } from '../../helpers/antiSsrfHttp.js';
import type { AoiPolygonGeoJson } from '../../validation/caseValidation.js';
import type { StacItemRaw } from '../stacClient.js';
import {
	buildCanonicalAoiMask,
	type CanonicalGrid,
	createCanonicalGrid,
} from './canonicalGrid.js';
import { type CanonicalSceneBands, readCanonicalSceneBands } from './cogBandReader.js';
import {
	type ConnectedComponentsResult,
	extractApprovedComponents8Conn,
} from './connectedComponents.js';
import {
	applyMorphologicalOpeningCross3x3,
	buildAllowedDomainMask,
} from './morphology.js';
import {
	classifyMultitemporalNdvi,
	type NdviClassificationResult,
	PIXEL_CLASS,
	type PixelClassCode,
} from './ndviClassifier.js';
import {
	renderCanonicalEvidenceRasters,
	type RenderEvidenceRastersResult,
} from './rasterRenderer.js';
import {
	vectorizeAllComponents,
	type VectorizedFeaturePolygon,
} from './vectorizer.js';

export const GEO_CORE_ENGINE_VERSION = 'sicam-geo-core/1.0.0';

export interface FilteredClassDistribution {
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

export interface PostClassificationResult {
	filteredClassMap: Uint8Array;
	filteredMetrics: FilteredClassDistribution;
	componentsByClass: Record<FeatureClass, ConnectedComponentsResult>;
	features: VectorizedFeaturePolygon[];
	rasterEvidences: RenderEvidenceRastersResult;
}

export interface GeoCorePipelineResult {
	engineVersion: string;
	grid: CanonicalGrid;
	aoiMask: Uint8Array;
	t0: CanonicalSceneBands;
	t1: CanonicalSceneBands;
	rawClassification: NdviClassificationResult;
	postClassification: PostClassificationResult;
}

function buildClassBinaryMask(classMap: Uint8Array, classCode: PixelClassCode): Uint8Array {
	const mask = new Uint8Array(classMap.length);
	for (let i = 0; i < classMap.length; i++) {
		if (classMap[i] === classCode) {
			mask[i] = 1;
		}
	}
	return mask;
}

// Spec Parte I — Seções 5 e 6: Morfologia 3x3, CCL 8-vizinhos + MMU, Vetorização e 5 PNGs PNG lossless
export async function executePostClassificationPipeline(params: {
	grid: CanonicalGrid;
	aoiMask: Uint8Array;
	t0: Pick<CanonicalSceneBands, 'blue' | 'green' | 'red' | 'nir' | 'scl'>;
	t1: Pick<CanonicalSceneBands, 'blue' | 'green' | 'red' | 'nir' | 'scl'>;
	rawClassification: NdviClassificationResult;
	algorithmParams: AlgorithmParams;
	simplifyToleranceM?: number;
	onStage?: (stage: 'vectorizing', detail: string) => Promise<void> | void;
}): Promise<PostClassificationResult> {
	const {
		grid,
		aoiMask,
		t0,
		t1,
		rawClassification,
		algorithmParams,
		simplifyToleranceM = 5.0,
		onStage,
	} = params;

	const allowedDomainMask = buildAllowedDomainMask(aoiMask, rawClassification.classMap);

	const processClass = (
		classCode: PixelClassCode,
		featureClass: FeatureClass,
	): ConnectedComponentsResult => {
		const rawBin = buildClassBinaryMask(rawClassification.classMap, classCode);
		const opened = applyMorphologicalOpeningCross3x3({
			binaryMask: rawBin,
			width: grid.width,
			height: grid.height,
			allowedDomainMask,
			kernelSize: algorithmParams.morphologicalKernel,
		});
		return extractApprovedComponents8Conn({
			binaryMask: opened,
			width: grid.width,
			height: grid.height,
			featureClass,
			minMappingUnitHa: algorithmParams.minMappingUnitHa,
			ndviT0: rawClassification.ndviT0,
			ndviT1: rawClassification.ndviT1,
			deltaNdvi: rawClassification.deltaNdvi,
		});
	};

	const deforestationCcl = processClass(PIXEL_CLASS.DEFORESTATION, 'deforestation');
	const degradationCcl = processClass(PIXEL_CLASS.DEGRADATION, 'degradation');
	const regrowthCcl = processClass(PIXEL_CLASS.REGROWTH, 'regrowth');

	const filteredClassMap = new Uint8Array(grid.pixelCount);
	let aoiTotalPixels = 0;
	let validAnalyzedPixels = 0;
	let cloudMaskedPixels = 0;
	let deforestationPixels = 0;
	let degradationPixels = 0;
	let regrowthPixels = 0;
	let stablePixels = 0;

	for (let i = 0; i < grid.pixelCount; i++) {
		if (aoiMask[i] !== 1) {
			continue;
		}
		aoiTotalPixels++;

		if (rawClassification.classMap[i] === PIXEL_CLASS.CLOUD_OBSTRUCTED) {
			filteredClassMap[i] = PIXEL_CLASS.CLOUD_OBSTRUCTED;
			cloudMaskedPixels++;
			continue;
		}

		validAnalyzedPixels++;
		if (deforestationCcl.approvedMask[i] === 1) {
			filteredClassMap[i] = PIXEL_CLASS.DEFORESTATION;
			deforestationPixels++;
		} else if (degradationCcl.approvedMask[i] === 1) {
			filteredClassMap[i] = PIXEL_CLASS.DEGRADATION;
			degradationPixels++;
		} else if (regrowthCcl.approvedMask[i] === 1) {
			filteredClassMap[i] = PIXEL_CLASS.REGROWTH;
			regrowthPixels++;
		} else {
			filteredClassMap[i] = PIXEL_CLASS.STABLE;
			stablePixels++;
		}
	}

	const cloudObstructionPct =
		aoiTotalPixels > 0 ? Number(((cloudMaskedPixels / aoiTotalPixels) * 100).toFixed(2)) : 100;

	const filteredMetrics: FilteredClassDistribution = {
		aoiTotalPixels,
		validAnalyzedPixels,
		cloudMaskedPixels,
		deforestationPixels,
		degradationPixels,
		regrowthPixels,
		stablePixels,
		cloudObstructionPct,
		visibilityCompromisedWarning: cloudObstructionPct > 50,
		approxValidAnalyzedHa: Number((validAnalyzedPixels * 0.01).toFixed(4)),
		approxCloudMaskedHa: Number((cloudMaskedPixels * 0.01).toFixed(4)),
		approxDeforestationHa: Number((deforestationPixels * 0.01).toFixed(4)),
		approxDegradationHa: Number((degradationPixels * 0.01).toFixed(4)),
		approxRegrowthHa: Number((regrowthPixels * 0.01).toFixed(4)),
		approxStableHa: Number((stablePixels * 0.01).toFixed(4)),
	};

	if (onStage) {
		await onStage('vectorizing', 'Vetorizando polígonos e renderizando evidências raster PNG.');
	}

	const features = vectorizeAllComponents(
		[...deforestationCcl.components, ...degradationCcl.components, ...regrowthCcl.components],
		grid,
		simplifyToleranceM,
	);

	const rasterEvidences = await renderCanonicalEvidenceRasters({
		grid,
		t0,
		t1,
		filteredClassMap,
	});

	return {
		filteredClassMap,
		filteredMetrics,
		componentsByClass: {
			deforestation: deforestationCcl,
			degradation: degradationCcl,
			regrowth: regrowthCcl,
		},
		features,
		rasterEvidences,
	};
}

// Orquestrador completo do motor geo-core (Partes 1 + 2)
export async function runGeoCoreAnalysisPipeline(params: {
	aoiGeoJson: AoiPolygonGeoJson;
	utmSrid: number;
	t0Provider: StacProvider;
	t0Items: ReadonlyArray<StacItemRaw>;
	t1Provider: StacProvider;
	t1Items: ReadonlyArray<StacItemRaw>;
	algorithmParams: AlgorithmParams;
	maxPixelsGuard?: number;
	simplifyToleranceM?: number;
	safeFetchOptions?: SafeFetchOptions;
	onStage?: (
		stage: 'fetching_bands' | 'processing_ndvi' | 'vectorizing',
		detail: string,
	) => Promise<void> | void;
}): Promise<GeoCorePipelineResult> {
	const grid = createCanonicalGrid(params.aoiGeoJson, params.utmSrid, params.maxPixelsGuard);
	const aoiMask = buildCanonicalAoiMask(grid);

	if (params.onStage) {
		await params.onStage(
			'fetching_bands',
			`Lendo blocos COG de T0 e T1 na grade canônica (${grid.width}x${grid.height}).`,
		);
	}

	const [t0, t1] = await Promise.all([
		readCanonicalSceneBands({
			grid,
			provider: params.t0Provider,
			items: params.t0Items,
			safeFetchOptions: params.safeFetchOptions,
		}),
		readCanonicalSceneBands({
			grid,
			provider: params.t1Provider,
			items: params.t1Items,
			safeFetchOptions: params.safeFetchOptions,
		}),
	]);

	if (params.onStage) {
		await params.onStage('processing_ndvi', 'Calculando NDVI multitemporal e matriz de mudança.');
	}

	const rawClassification = classifyMultitemporalNdvi({
		t0,
		t1,
		aoiMask,
		algorithmParams: params.algorithmParams,
	});

	const postClassification = await executePostClassificationPipeline({
		grid,
		aoiMask,
		t0,
		t1,
		rawClassification,
		algorithmParams: params.algorithmParams,
		simplifyToleranceM: params.simplifyToleranceM,
		onStage: params.onStage,
	});

	return {
		engineVersion: GEO_CORE_ENGINE_VERSION,
		grid,
		aoiMask,
		t0,
		t1,
		rawClassification,
		postClassification,
	};
}
