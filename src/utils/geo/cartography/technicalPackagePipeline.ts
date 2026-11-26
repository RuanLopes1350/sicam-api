import type { PaperFormat, RasterType } from '../../../config/db/schema/enums.js';
import cartographyRepository, {
	type CartographyRunBundle,
} from '../../../repository/cartographyRepository.js';
import exportRepository from '../../../repository/exportRepository.js';
import { storageRepository } from '../../../repository/storageRepository.js';
import { sha256Hex } from '../../helpers/crypto.js';
import { DomainError } from '../../helpers/domainError.js';
import { renderRunCartographicPlatePdf } from './cartographyPipeline.js';
import {
	type AuditManifestV1,
	buildAuditManifestArtifact,
	buildDeterministicZipBuffer,
	computeDatasetFingerprintSha256,
	type ManifestFileEntry,
} from './manifestAndZipBuilder.js';
import { buildAllVectorAndTabularArtifacts } from './vectorExporters.js';

const REQUIRED_RASTER_TYPES: readonly RasterType[] = [
	't0_rgb',
	't1_rgb',
	't0_false_color',
	't1_false_color',
	'delta_ndvi_mask',
];

export interface BuildRunTechnicalPackageParams {
	runId: string;
	paperFormat: PaperFormat;
	observations: string | null;
	issuer: {
		id: string;
		fullName: string;
		registrationCode: string;
	};
	emittedAt?: Date;
	onProgress?: (progressPct: number, step: string) => Promise<void>;
}

export interface BuiltTechnicalPackageResult {
	bundle: CartographyRunBundle;
	emittedAt: Date;
	paperFormat: PaperFormat;
	cartographicScale: number;
	datasetFingerprintSha256: string;
	pdfBuffer: Buffer;
	pdfSha256: string;
	pdfSizeBytes: number;
	zipBuffer: Buffer;
	zipSha256: string;
	zipSizeBytes: number;
	auditManifest: AuditManifestV1;
	blockedRequests: string[];
	fileCount: number;
}

// Orquestrador Completo API-10 (Spec Parte II Seção 7.2): Custódia SHA-256 sem dependência circular + PDF 300 DPI + ZIP determinístico
export async function buildRunTechnicalPackage(
	params: BuildRunTechnicalPackageParams,
): Promise<BuiltTechnicalPackageResult> {
	const emittedAt = params.emittedAt ?? new Date();

	const [bundle, supplement] = await Promise.all([
		cartographyRepository.findCartographyRunBundle(params.runId),
		exportRepository.findExportSupplementByRunId(params.runId),
	]);

	if (!bundle || !supplement) {
		throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
	}

	const rasterBuffers: Partial<Record<RasterType, Buffer>> = {};
	const rasterFileEntries: Array<{
		path: string;
		mimeType: string;
		buffer: Buffer;
		sha256: string;
		sizeBytes: number;
	}> = [];

	const missingTypes = REQUIRED_RASTER_TYPES.filter((type) => !bundle.rastersByType[type]);
	if (missingTypes.length > 0) {
		throw new DomainError(
			'ERR_RUN_NOT_REVIEWABLE',
			`Evidências raster obrigatórias ausentes para emissão do pacote técnico (${missingTypes.join(', ')}).`,
		);
	}

	const downloadedRasters = await Promise.all(
		REQUIRED_RASTER_TYPES.map(async (assetType) => {
			const meta = bundle.rastersByType[assetType]!;
			const obj = await storageRepository.getPrivateObjectBytes(meta.storageKey, meta.storageBucket);
			const actualSha = sha256Hex(obj.buffer);
			if (actualSha !== meta.sha256) {
				throw new DomainError(
					'ERR_INTERNAL_SERVER_ERROR',
					`Divergência de integridade SHA-256 detectada no raster '${assetType}' armazenado.`,
				);
			}
			return { assetType, buffer: obj.buffer, sha256: actualSha };
		}),
	);

	for (const item of downloadedRasters) {
		rasterBuffers[item.assetType] = item.buffer;
		rasterFileEntries.push({
			path: `04_rasters_evidencia/${item.assetType}.png`,
			mimeType: 'image/png',
			buffer: item.buffer,
			sha256: item.sha256,
			sizeBytes: item.buffer.byteLength,
		});
	}

	if (params.onProgress) {
		await params.onProgress(45, 'Gerando relatório CSV e camadas vetoriais GeoJSON/KML');
	}

	const vectorTabularArtifacts = buildAllVectorAndTabularArtifacts(
		{
			caseId: bundle.caseId,
			protocolCode: bundle.protocolCode,
			externalRef: bundle.externalRef,
			title: bundle.title,
			primaryMunicipalityName: bundle.primaryMunicipalityName,
			stateUf: bundle.stateUf,
			aoiAreaHa: bundle.aoiAreaHa,
			aoiPerimeterM: supplement.aoiPerimeterM,
			utmSrid: bundle.utmSrid,
			aoiGeoJson: bundle.aoiGeoJson,
			runId: bundle.runId,
			version: bundle.version,
			t0AcquiredAt: bundle.t0AcquiredAt,
			t1AcquiredAt: bundle.t1AcquiredAt,
			engineVersion: bundle.engineVersion,
			presetName: bundle.presetName,
		},
		supplement.allFeatures,
	);

	const analyticalManifestEntries: ManifestFileEntry[] = [
		...vectorTabularArtifacts.map((a) => ({
			path: a.path,
			mimeType: a.mimeType,
			sizeBytes: a.buffer.byteLength,
			sha256: sha256Hex(a.buffer),
		})),
		...rasterFileEntries.map((r) => ({
			path: r.path,
			mimeType: r.mimeType,
			sizeBytes: r.sizeBytes,
			sha256: r.sha256,
		})),
	];

	const datasetFingerprintSha256 = computeDatasetFingerprintSha256({
		caseId: bundle.caseId,
		protocolCode: bundle.protocolCode,
		runId: bundle.runId,
		runVersion: bundle.version,
		utmSrid: bundle.utmSrid,
		engineVersion: bundle.engineVersion,
		presetName: bundle.presetName,
		isCustomParams: bundle.isCustomParams,
		algorithmParams: bundle.algorithmParams,
		t0: {
			provider: bundle.t0Provider,
			collection: bundle.t0Collection,
			itemIds: bundle.t0ItemIds,
			acquiredAt: bundle.t0AcquiredAt,
		},
		t1: {
			provider: bundle.t1Provider,
			collection: bundle.t1Collection,
			itemIds: bundle.t1ItemIds,
			acquiredAt: bundle.t1AcquiredAt,
		},
		features: supplement.allFeatures,
		analyticalFiles: analyticalManifestEntries,
	});

	if (params.onProgress) {
		await params.onProgress(65, 'Renderizando Carta-Imagem 300 DPI no Chromium Offline');
	}

	const renderedPdf = await renderRunCartographicPlatePdf({
		runId: params.runId,
		paperFormat: params.paperFormat,
		issuer: {
			fullName: params.issuer.fullName,
			registrationCode: params.issuer.registrationCode,
		},
		observations: params.observations,
		datasetFingerprintSha256,
		emittedAt,
		preloadedBundle: bundle,
		preloadedRasterBuffers: rasterBuffers,
	});

	const pdfEntry: ManifestFileEntry = {
		path: '01_carta_imagem_comparativa.pdf',
		mimeType: 'application/pdf',
		sizeBytes: renderedPdf.pdfSizeBytes,
		sha256: renderedPdf.pdfSha256,
	};

	const all15PackageFiles: ManifestFileEntry[] = [pdfEntry, ...analyticalManifestEntries];

	const manifestArtifact = buildAuditManifestArtifact({
		generatedAt: emittedAt,
		issuer: params.issuer,
		caseInfo: {
			caseId: bundle.caseId,
			protocolCode: bundle.protocolCode,
			externalRef: bundle.externalRef,
			title: bundle.title,
			description: supplement.description,
			primaryMunicipalityIbge: bundle.primaryMunicipalityIbge,
			primaryMunicipalityName: bundle.primaryMunicipalityName,
			stateUf: bundle.stateUf,
			intersectedMunicipalities: bundle.intersectedMunicipalities,
			utmSrid: bundle.utmSrid,
			aoiAreaHa: bundle.aoiAreaHa,
			aoiPerimeterM: supplement.aoiPerimeterM,
		},
		runInfo: {
			runId: bundle.runId,
			version: bundle.version,
			presetName: bundle.presetName,
			isCustomParams: bundle.isCustomParams,
			algorithmParams: bundle.algorithmParams,
			engineVersion: bundle.engineVersion,
			seasonalityWarning: bundle.seasonalityWarning,
			validAnalyzedHa: bundle.validAnalyzedHa,
			cloudMaskedHa: bundle.cloudMaskedHa,
			deforestationHa: bundle.deforestationHa,
			degradationHa: bundle.degradationHa,
			regrowthHa: bundle.regrowthHa,
			stableHa: bundle.stableHa,
		},
		stacProvenance: {
			t0: {
				provider: bundle.t0Provider,
				collection: bundle.t0Collection,
				itemIds: bundle.t0ItemIds,
				acquiredAt: bundle.t0AcquiredAt.toISOString(),
				aoiCloudPct: bundle.t0CloudPctAoi,
				isMultiTile: bundle.t0StacMetadata.isMultiTile,
				processingBaseline: bundle.t0StacMetadata.processingBaseline,
				boaOffsetApplied: bundle.t0StacMetadata.boaOffsetApplied,
			},
			t1: {
				provider: bundle.t1Provider,
				collection: bundle.t1Collection,
				itemIds: bundle.t1ItemIds,
				acquiredAt: bundle.t1AcquiredAt.toISOString(),
				aoiCloudPct: bundle.t1CloudPctAoi,
				isMultiTile: bundle.t1StacMetadata.isMultiTile,
				processingBaseline: bundle.t1StacMetadata.processingBaseline,
				boaOffsetApplied: bundle.t1StacMetadata.boaOffsetApplied,
			},
		},
		cartography: {
			paperFormat: params.paperFormat,
			cartographicScale: renderedPdf.cartographicScale,
			dpi: 300,
			observations: params.observations,
		},
		features: supplement.allFeatures,
		datasetFingerprintSha256,
		pdfSha256: renderedPdf.pdfSha256,
		packageFiles: all15PackageFiles,
	});

	if (params.onProgress) {
		await params.onProgress(88, 'Empacotando arquivo técnico .zip e selando hashes SHA-256');
	}

	const zipEntries = [
		{ path: '01_carta_imagem_comparativa.pdf', buffer: renderedPdf.pdfBuffer },
		...vectorTabularArtifacts.map((a) => ({ path: a.path, buffer: a.buffer })),
		...rasterFileEntries.map((r) => ({ path: r.path, buffer: r.buffer })),
		{ path: '05_manifesto_auditoria.json', buffer: manifestArtifact.buffer },
	];

	const { zipBuffer, zipSha256, zipSizeBytes } = await buildDeterministicZipBuffer(
		zipEntries,
		emittedAt,
	);

	return {
		bundle,
		emittedAt,
		paperFormat: params.paperFormat,
		cartographicScale: renderedPdf.cartographicScale,
		datasetFingerprintSha256,
		pdfBuffer: renderedPdf.pdfBuffer,
		pdfSha256: renderedPdf.pdfSha256,
		pdfSizeBytes: renderedPdf.pdfSizeBytes,
		zipBuffer,
		zipSha256,
		zipSizeBytes,
		auditManifest: manifestArtifact.manifest,
		blockedRequests: renderedPdf.blockedRequests,
		fileCount: zipEntries.length,
	};
}
