import { inflateRawSync } from 'node:zlib';
import { ZipArchive, type ArchiverError } from 'archiver';
import type { IntersectedMunicipalityInfo } from '../../../config/db/schema/cases.js';
import type { PaperFormat, StacProvider } from '../../../config/db/schema/enums.js';
import type { AlgorithmParams } from '../../../config/presets.js';
import { sha256Hex } from '../../helpers/crypto.js';
import type { ExportFeatureRecord } from './vectorExporters.js';

export interface ManifestFileEntry {
	path: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
}

export interface AuditManifestV1 {
	schemaVersion: '1.0.0';
	generatedAt: string;
	issuer: {
		id: string;
		fullName: string;
		registrationCode: string;
	};
	case: {
		caseId: string;
		protocolCode: string;
		externalRef: string | null;
		title: string;
		description: string | null;
		primaryMunicipalityIbge: string | null;
		primaryMunicipalityName: string | null;
		stateUf: string | null;
		intersectedMunicipalities: IntersectedMunicipalityInfo[];
		utmSrid: number;
		aoiAreaHa: number;
		aoiPerimeterM: number;
	};
	run: {
		runId: string;
		version: number;
		presetName: string;
		isCustomParams: boolean;
		algorithmParams: AlgorithmParams;
		engineVersion: string;
		seasonalityWarning: boolean;
		areaSummary: {
			validAnalyzedHa: number;
			cloudMaskedHa: number;
			deforestationHa: number;
			degradationHa: number;
			regrowthHa: number;
			stableHa: number;
		};
	};
	stacProvenance: {
		t0: {
			provider: StacProvider;
			collection: string;
			itemIds: string[];
			acquiredAt: string;
			aoiCloudPct: number;
			isMultiTile: boolean;
			processingBaseline: string | null;
			boaOffsetApplied: boolean;
		};
		t1: {
			provider: StacProvider;
			collection: string;
			itemIds: string[];
			acquiredAt: string;
			aoiCloudPct: number;
			isMultiTile: boolean;
			processingBaseline: string | null;
			boaOffsetApplied: boolean;
		};
	};
	cartography: {
		paperFormat: PaperFormat;
		cartographicScale: number;
		dpi: 300;
		observations: string | null;
	};
	curationHistory: Array<{
		id: string;
		featureSequence: number;
		label: string;
		featureClass: string;
		areaHa: number;
		reviewStatus: string;
		dismissalReason: string | null;
		reviewedBy: { id: string; fullName: string; registrationCode: string } | null;
		reviewedAt: string | null;
	}>;
	cryptographicCustody: {
		datasetFingerprintSha256: string;
		pdfSha256: string;
		files: ManifestFileEntry[];
	};
}

export interface DatasetFingerprintInput {
	caseId: string;
	protocolCode: string;
	runId: string;
	runVersion: number;
	utmSrid: number;
	engineVersion: string;
	presetName: string;
	isCustomParams: boolean;
	algorithmParams: AlgorithmParams;
	t0: {
		provider: StacProvider;
		collection: string;
		itemIds: string[];
		acquiredAt: Date;
	};
	t1: {
		provider: StacProvider;
		collection: string;
		itemIds: string[];
		acquiredAt: Date;
	};
	features: readonly ExportFeatureRecord[];
	analyticalFiles: readonly ManifestFileEntry[];
}

// Passo 1 da Custódia Criptográfica (Spec Seção 7.2): Hash canônico anterior ao PDF
export function computeDatasetFingerprintSha256(input: DatasetFingerprintInput): string {
	const canonicalParams = {
		ndviForestMin: input.algorithmParams.ndviForestMin,
		ndviClearedMax: input.algorithmParams.ndviClearedMax,
		deforestationDeltaMax: input.algorithmParams.deforestationDeltaMax,
		degradationDeltaMax: input.algorithmParams.degradationDeltaMax,
		regrowthStartMax: input.algorithmParams.regrowthStartMax,
		regrowthEndMin: input.algorithmParams.regrowthEndMin,
		regrowthDeltaMin: input.algorithmParams.regrowthDeltaMin,
		morphologicalKernel: input.algorithmParams.morphologicalKernel,
		minMappingUnitHa: input.algorithmParams.minMappingUnitHa,
	};

	const curationHistory = [...input.features]
		.sort((a, b) => a.featureSequence - b.featureSequence)
		.map((f) => ({
			id: f.id,
			featureSequence: f.featureSequence,
			featureClass: f.featureClass,
			areaHa: Number(f.areaHa.toFixed(4)),
			reviewStatus: f.reviewStatus,
			dismissalReason: f.dismissalReason,
			reviewedById: f.reviewedBy?.id ?? null,
			reviewedAt: f.reviewedAt ? f.reviewedAt.toISOString() : null,
		}));

	const analyticalFiles = [...input.analyticalFiles]
		.sort((a, b) => a.path.localeCompare(b.path))
		.map((file) => ({
			path: file.path,
			sha256: file.sha256,
			sizeBytes: file.sizeBytes,
		}));

	const canonicalPayload = {
		caseId: input.caseId,
		protocolCode: input.protocolCode,
		runId: input.runId,
		runVersion: input.runVersion,
		utmSrid: input.utmSrid,
		engineVersion: input.engineVersion,
		presetName: input.presetName,
		isCustomParams: input.isCustomParams,
		algorithmParams: canonicalParams,
		t0: {
			provider: input.t0.provider,
			collection: input.t0.collection,
			itemIds: [...input.t0.itemIds].sort(),
			acquiredAt: input.t0.acquiredAt.toISOString(),
		},
		t1: {
			provider: input.t1.provider,
			collection: input.t1.collection,
			itemIds: [...input.t1.itemIds].sort(),
			acquiredAt: input.t1.acquiredAt.toISOString(),
		},
		curationHistory,
		analyticalFiles,
	};

	return sha256Hex(JSON.stringify(canonicalPayload));
}

export interface BuildAuditManifestInput {
	generatedAt: Date;
	issuer: { id: string; fullName: string; registrationCode: string };
	caseInfo: {
		caseId: string;
		protocolCode: string;
		externalRef: string | null;
		title: string;
		description: string | null;
		primaryMunicipalityIbge: string | null;
		primaryMunicipalityName: string | null;
		stateUf: string | null;
		intersectedMunicipalities: IntersectedMunicipalityInfo[];
		utmSrid: number;
		aoiAreaHa: number;
		aoiPerimeterM: number;
	};
	runInfo: {
		runId: string;
		version: number;
		presetName: string;
		isCustomParams: boolean;
		algorithmParams: AlgorithmParams;
		engineVersion: string;
		seasonalityWarning: boolean;
		validAnalyzedHa: number;
		cloudMaskedHa: number;
		deforestationHa: number;
		degradationHa: number;
		regrowthHa: number;
		stableHa: number;
	};
	stacProvenance: AuditManifestV1['stacProvenance'];
	cartography: AuditManifestV1['cartography'];
	features: readonly ExportFeatureRecord[];
	datasetFingerprintSha256: string;
	pdfSha256: string;
	packageFiles: readonly ManifestFileEntry[];
}

// Passo 3 da Custódia (RF-28): Manifesto completo listando parâmetros, revisão e SHA-256 de cada arquivo
export function buildAuditManifestArtifact(input: BuildAuditManifestInput): {
	manifest: AuditManifestV1;
	buffer: Buffer;
	sha256: string;
	sizeBytes: number;
} {
	const curationHistory = [...input.features]
		.sort((a, b) => a.featureSequence - b.featureSequence)
		.map((f) => ({
			id: f.id,
			featureSequence: f.featureSequence,
			label: `P${f.featureSequence}`,
			featureClass: f.featureClass,
			areaHa: Number(f.areaHa.toFixed(4)),
			reviewStatus: f.reviewStatus,
			dismissalReason: f.dismissalReason,
			reviewedBy: f.reviewedBy,
			reviewedAt: f.reviewedAt ? f.reviewedAt.toISOString() : null,
		}));

	const manifest: AuditManifestV1 = {
		schemaVersion: '1.0.0',
		generatedAt: input.generatedAt.toISOString(),
		issuer: input.issuer,
		case: input.caseInfo,
		run: {
			runId: input.runInfo.runId,
			version: input.runInfo.version,
			presetName: input.runInfo.presetName,
			isCustomParams: input.runInfo.isCustomParams,
			algorithmParams: input.runInfo.algorithmParams,
			engineVersion: input.runInfo.engineVersion,
			seasonalityWarning: input.runInfo.seasonalityWarning,
			areaSummary: {
				validAnalyzedHa: input.runInfo.validAnalyzedHa,
				cloudMaskedHa: input.runInfo.cloudMaskedHa,
				deforestationHa: input.runInfo.deforestationHa,
				degradationHa: input.runInfo.degradationHa,
				regrowthHa: input.runInfo.regrowthHa,
				stableHa: input.runInfo.stableHa,
			},
		},
		stacProvenance: input.stacProvenance,
		cartography: input.cartography,
		curationHistory,
		cryptographicCustody: {
			datasetFingerprintSha256: input.datasetFingerprintSha256,
			pdfSha256: input.pdfSha256,
			files: [...input.packageFiles].sort((a, b) => a.path.localeCompare(b.path)),
		},
	};

	const buffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
	return {
		manifest,
		buffer,
		sha256: sha256Hex(buffer),
		sizeBytes: buffer.byteLength,
	};
}

export interface ZipInputEntry {
	path: string;
	buffer: Buffer;
}

// Empacotamento .zip determinístico em memória via archiver com timestamp e ordem fixos (Spec Seção 7.2 Passo 3)
export async function buildDeterministicZipBuffer(
	entries: readonly ZipInputEntry[],
	emittedAt: Date,
): Promise<{ zipBuffer: Buffer; zipSha256: string; zipSizeBytes: number }> {
	const sortedEntries = [...entries].sort((a, b) => a.path.localeCompare(b.path));

	const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
		const archive = new ZipArchive({ zlib: { level: 9 } });
		const chunks: Buffer[] = [];

		archive.on('data', (chunk: Buffer | Uint8Array) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		archive.on('end', () => {
			resolve(Buffer.concat(chunks));
		});
		archive.on('warning', (err: ArchiverError) => {
			if (err.code !== 'ENOENT') {
				reject(err);
			}
		});
		archive.on('error', (err: ArchiverError) => {
			reject(err);
		});

		for (const entry of sortedEntries) {
			archive.append(entry.buffer, {
				name: entry.path,
				date: emittedAt,
				mode: 0o100644,
			});
		}

		void archive.finalize().catch(reject);
	});

	return {
		zipBuffer,
		zipSha256: sha256Hex(zipBuffer),
		zipSizeBytes: zipBuffer.byteLength,
	};
}

export interface ExtractedZipEntry {
	buffer: Buffer;
	sha256: string;
	sizeBytes: number;
}

// Leitor/extrator ZIP puro (Store = 0, Deflate = 8) para validação automatizada do manifesto e assinaturas
export function extractZipEntriesFromBuffer(zipBuffer: Buffer): Map<string, ExtractedZipEntry> {
	if (zipBuffer.byteLength < 22) {
		throw new Error('Buffer ZIP inválido: tamanho inferior ao mínimo estrutural.');
	}

	const searchMin = Math.max(0, zipBuffer.byteLength - 65_557);
	let eocdOffset = -1;
	for (let offset = zipBuffer.byteLength - 22; offset >= searchMin; offset--) {
		if (zipBuffer.readUInt32LE(offset) === 0x06054b50) {
			eocdOffset = offset;
			break;
		}
	}

	if (eocdOffset < 0) {
		throw new Error('Assinatura EOCD (0x06054b50) não encontrada no arquivo ZIP.');
	}

	const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
	const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
	if (centralDirOffset === 0xffffffff) {
		throw new Error('ZIP64 não suportado para pacotes técnicos.');
	}

	const extracted = new Map<string, ExtractedZipEntry>();
	let cursor = centralDirOffset;

	for (let i = 0; i < totalEntries; i++) {
		if (zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
			throw new Error(`Cabeçalho Central Directory inválido no índice ${i}.`);
		}

		const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
		const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
		const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24);
		const fileNameLen = zipBuffer.readUInt16LE(cursor + 28);
		const extraLen = zipBuffer.readUInt16LE(cursor + 30);
		const commentLen = zipBuffer.readUInt16LE(cursor + 32);
		const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);

		const fileName = zipBuffer.toString('utf8', cursor + 46, cursor + 46 + fileNameLen);
		cursor += 46 + fileNameLen + extraLen + commentLen;

		if (fileName.endsWith('/')) {
			continue;
		}

		if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
			throw new Error(`Cabeçalho Local inválido para entrada '${fileName}'.`);
		}

		const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
		const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
		const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
		const compressedSlice = zipBuffer.subarray(dataStart, dataStart + compressedSize);

		let buffer: Buffer;
		if (compressionMethod === 0) {
			buffer = Buffer.from(compressedSlice);
		} else if (compressionMethod === 8) {
			buffer = inflateRawSync(compressedSlice);
		} else {
			throw new Error(
				`Método de compressão ZIP não suportado (${compressionMethod}) em '${fileName}'.`,
			);
		}

		if (buffer.byteLength !== uncompressedSize) {
			throw new Error(
				`Tamanho descompactado divergente em '${fileName}' (${buffer.byteLength} != ${uncompressedSize}).`,
			);
		}

		extracted.set(fileName, {
			buffer,
			sha256: sha256Hex(buffer),
			sizeBytes: buffer.byteLength,
		});
	}

	return extracted;
}
