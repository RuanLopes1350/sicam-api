import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { type DbExecutor, getDb } from '../config/dbConfig.js';
import { exportPackages, rasterAssets } from '../config/db/schema/artifacts.js';
import { analysisCases } from '../config/db/schema/cases.js';
import type { PaperFormat, RunStatus } from '../config/db/schema/enums.js';
import { detectedFeatures } from '../config/db/schema/features.js';
import { analysisRuns } from '../config/db/schema/runs.js';
import { users } from '../config/db/schema/users.js';
import { parseDatabaseError } from '../utils/helpers/dbErrors.js';
import { DomainError } from '../utils/helpers/domainError.js';
import type { DetectedFeaturePolygonGeoJson } from '../utils/validation/runValidation.js';

export interface PersistExportPackageInput {
	runId: string;
	paperFormat: PaperFormat;
	cartographicScale: number;
	observations: string | null;
	storageBucket: string;
	pdfStorageKey: string;
	pdfSizeBytes: number;
	pdfSha256: string;
	zipStorageKey: string;
	zipSizeBytes: number;
	zipSha256: string;
	auditManifest: Record<string, unknown>;
	generatedBy: string;
	generatedAt: Date;
}

// Camada Repository ("Estoquista"): acesso exclusivo PostgreSQL/PostGIS para exportações, congelamento e custódia SHA-256
export class ExportRepository {
	async lockRunForExport(runId: string, tx: DbExecutor) {
		try {
			const res = await tx.execute(sql`
        SELECT
          r.id,
          r.case_id,
          r.status,
          EXISTS(SELECT 1 FROM export_packages ep WHERE ep.run_id = r.id) AS has_export
        FROM analysis_runs r
        WHERE r.id = ${runId}::uuid
        FOR UPDATE
      `);

			const row = res.rows[0] as
				| { id?: string; case_id?: string; status?: RunStatus; has_export?: boolean }
				| undefined;

			if (!row?.id || !row.case_id || !row.status) {
				return null;
			}

			return {
				id: row.id,
				caseId: row.case_id,
				status: row.status,
				hasExport: Boolean(row.has_export),
			};
		} catch (error) {
			throw parseDatabaseError(error, 'ExportRepository.lockRunForExport');
		}
	}

	async markRunExporting(runId: string, tx: DbExecutor): Promise<void> {
		try {
			await tx
				.update(analysisRuns)
				.set({
					status: 'exporting',
					errorCode: null,
					errorDetail: null,
				})
				.where(and(eq(analysisRuns.id, runId), eq(analysisRuns.status, 'ready_for_review')));
		} catch (error) {
			throw parseDatabaseError(error, 'ExportRepository.markRunExporting');
		}
	}

	async revertRunFromExportingToReview(
		runId: string,
		errorCode: string,
		errorDetail: string,
		db: DbExecutor = getDb(),
	): Promise<void> {
		try {
			await db
				.update(analysisRuns)
				.set({
					status: 'ready_for_review',
					errorCode,
					errorDetail: errorDetail.slice(0, 500),
				})
				.where(and(eq(analysisRuns.id, runId), eq(analysisRuns.status, 'exporting')));
		} catch (error) {
			throw parseDatabaseError(error, 'ExportRepository.revertRunFromExportingToReview');
		}
	}

	async findIssuerById(userId: string, db: DbExecutor = getDb()) {
		try {
			const [row] = await db
				.select({
					id: users.id,
					fullName: users.fullName,
					registrationCode: users.registrationCode,
				})
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);
			return row ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'ExportRepository.findIssuerById');
		}
	}

	// Carrega complemento integral para CSV/KML/GeoJSON (incluindo feições dismissed_noise para auditoria no CSV)
	async findExportSupplementByRunId(runId: string, db: DbExecutor = getDb()) {
		try {
			const [header] = await db
				.select({
					runId: analysisRuns.id,
					aoiPerimeterM: analysisCases.aoiPerimeterM,
					description: analysisCases.description,
				})
				.from(analysisRuns)
				.innerJoin(analysisCases, eq(analysisRuns.caseId, analysisCases.id))
				.where(eq(analysisRuns.id, runId))
				.limit(1);

			if (!header) {
				return null;
			}

			const [featureRows, rasterRows] = await Promise.all([
				db
					.select({
						id: detectedFeatures.id,
						featureSequence: detectedFeatures.featureSequence,
						featureClass: detectedFeatures.featureClass,
						geomGeoJson: sql<DetectedFeaturePolygonGeoJson>`(ST_AsGeoJSON(${detectedFeatures.geom}, 7)::jsonb - 'crs')`,
						areaHa: detectedFeatures.areaHa,
						pixelCount: detectedFeatures.pixelCount,
						meanNdviT0: detectedFeatures.meanNdviT0,
						meanNdviT1: detectedFeatures.meanNdviT1,
						meanDeltaNdvi: detectedFeatures.meanDeltaNdvi,
						centroidLat: detectedFeatures.centroidLat,
						centroidLon: detectedFeatures.centroidLon,
						centroidUtmE: detectedFeatures.centroidUtmE,
						centroidUtmN: detectedFeatures.centroidUtmN,
						reviewStatus: detectedFeatures.reviewStatus,
						dismissalReason: detectedFeatures.dismissalReason,
						reviewedAt: detectedFeatures.reviewedAt,
						reviewerId: users.id,
						reviewerFullName: users.fullName,
						reviewerRegistrationCode: users.registrationCode,
					})
					.from(detectedFeatures)
					.leftJoin(users, eq(detectedFeatures.reviewedBy, users.id))
					.where(eq(detectedFeatures.runId, runId))
					.orderBy(asc(detectedFeatures.featureSequence)),
				db.select().from(rasterAssets).where(eq(rasterAssets.runId, runId)),
			]);

			return {
				aoiPerimeterM: Number(header.aoiPerimeterM),
				description: header.description,
				allFeatures: featureRows.map((row) => ({
					id: row.id,
					featureSequence: row.featureSequence,
					featureClass: row.featureClass,
					geomGeoJson: row.geomGeoJson,
					areaHa: Number(row.areaHa),
					pixelCount: row.pixelCount,
					meanNdviT0: Number(row.meanNdviT0),
					meanNdviT1: Number(row.meanNdviT1),
					meanDeltaNdvi: Number(row.meanDeltaNdvi),
					centroidLat: Number(row.centroidLat),
					centroidLon: Number(row.centroidLon),
					centroidUtmE: Number(row.centroidUtmE),
					centroidUtmN: Number(row.centroidUtmN),
					reviewStatus: row.reviewStatus,
					dismissalReason: row.dismissalReason,
					reviewedBy: row.reviewerId
						? {
								id: row.reviewerId,
								fullName: row.reviewerFullName ?? '',
								registrationCode: row.reviewerRegistrationCode ?? '',
							}
						: null,
					reviewedAt: row.reviewedAt,
				})),
				rasters: rasterRows,
			};
		} catch (error) {
			throw parseDatabaseError(error, 'ExportRepository.findExportSupplementByRunId');
		}
	}

	// Spec Seção 7.2 Passo 4 & RN-05: Insere pacote em export_packages e congela analysis_runs atomicamente
	async persistExportAndFreezeRunInTransaction(
		input: PersistExportPackageInput,
		tx: DbExecutor,
	): Promise<{ id: string; generatedAt: Date }> {
		try {
			const locked = await this.lockRunForExport(input.runId, tx);
			if (!locked) {
				throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
			}

			if (locked.status === 'frozen' || locked.hasExport) {
				throw new DomainError(
					'ERR_RUN_FROZEN',
					'Esta execução já possui pacote técnico emitido e encontra-se congelada.',
				);
			}

			if (locked.status !== 'exporting' && locked.status !== 'ready_for_review') {
				throw new DomainError(
					'ERR_RUN_NOT_REVIEWABLE',
					`Não é possível congelar execução no estado '${locked.status}'.`,
				);
			}

			const [inserted] = await tx
				.insert(exportPackages)
				.values({
					runId: input.runId,
					paperFormat: input.paperFormat,
					cartographicScale: input.cartographicScale,
					observations: input.observations,
					storageBucket: input.storageBucket,
					pdfStorageKey: input.pdfStorageKey,
					pdfSizeBytes: input.pdfSizeBytes,
					pdfSha256: input.pdfSha256,
					zipStorageKey: input.zipStorageKey,
					zipSizeBytes: input.zipSizeBytes,
					zipSha256: input.zipSha256,
					auditManifest: input.auditManifest,
					generatedBy: input.generatedBy,
					generatedAt: input.generatedAt,
				})
				.returning({
					id: exportPackages.id,
					generatedAt: exportPackages.generatedAt,
				});

			const updatedRuns = await tx
				.update(analysisRuns)
				.set({
					status: 'frozen',
					errorCode: null,
					errorDetail: null,
				})
				.where(
					and(
						eq(analysisRuns.id, input.runId),
						inArray(analysisRuns.status, ['exporting', 'ready_for_review']),
					),
				)
				.returning({ id: analysisRuns.id });

			if (!inserted || updatedRuns.length === 0) {
				throw new DomainError(
					'ERR_RUN_FROZEN',
					'Concorrência detectada ao tentar congelar execução.',
				);
			}

			return inserted;
		} catch (error) {
			throw parseDatabaseError(error, 'ExportRepository.persistExportAndFreezeRunInTransaction');
		}
	}

	async findExportMetadataByRunId(runId: string, db: DbExecutor = getDb()) {
		try {
			const [row] = await db
				.select({
					exportId: exportPackages.id,
					runId: exportPackages.runId,
					caseId: analysisRuns.caseId,
					protocolCode: analysisCases.protocolCode,
					runVersion: analysisRuns.version,
					paperFormat: exportPackages.paperFormat,
					cartographicScale: exportPackages.cartographicScale,
					observations: exportPackages.observations,
					pdfSizeBytes: exportPackages.pdfSizeBytes,
					pdfSha256: exportPackages.pdfSha256,
					zipSizeBytes: exportPackages.zipSizeBytes,
					zipSha256: exportPackages.zipSha256,
					generatedAt: exportPackages.generatedAt,
					auditManifest: exportPackages.auditManifest,
					issuerId: users.id,
					issuerFullName: users.fullName,
					issuerRegistrationCode: users.registrationCode,
				})
				.from(exportPackages)
				.innerJoin(analysisRuns, eq(exportPackages.runId, analysisRuns.id))
				.innerJoin(analysisCases, eq(analysisRuns.caseId, analysisCases.id))
				.innerJoin(users, eq(exportPackages.generatedBy, users.id))
				.where(eq(exportPackages.runId, runId))
				.limit(1);

			return row ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'ExportRepository.findExportMetadataByRunId');
		}
	}

	async findExportForDownloadById(exportId: string, db: DbExecutor = getDb()) {
		try {
			const [row] = await db
				.select({
					exportId: exportPackages.id,
					runId: exportPackages.runId,
					caseId: analysisRuns.caseId,
					protocolCode: analysisCases.protocolCode,
					runVersion: analysisRuns.version,
					storageBucket: exportPackages.storageBucket,
					pdfStorageKey: exportPackages.pdfStorageKey,
					pdfSizeBytes: exportPackages.pdfSizeBytes,
					pdfSha256: exportPackages.pdfSha256,
					zipStorageKey: exportPackages.zipStorageKey,
					zipSizeBytes: exportPackages.zipSizeBytes,
					zipSha256: exportPackages.zipSha256,
				})
				.from(exportPackages)
				.innerJoin(analysisRuns, eq(exportPackages.runId, analysisRuns.id))
				.innerJoin(analysisCases, eq(analysisRuns.caseId, analysisCases.id))
				.where(eq(exportPackages.id, exportId))
				.limit(1);

			return row ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'ExportRepository.findExportForDownloadById');
		}
	}

	// Modelagem Física Seção 8.3: Verificação de integridade via constraints UNIQUE pdf_sha256 / zip_sha256
	async verifyArtifactBySha256(sha256Lower: string, db: DbExecutor = getDb()) {
		try {
			const [row] = await db
				.select({
					exportId: exportPackages.id,
					protocolCode: analysisCases.protocolCode,
					title: analysisCases.title,
					primaryMunicipalityName: analysisCases.primaryMunicipalityName,
					stateUf: analysisCases.stateUf,
					runVersion: analysisRuns.version,
					t0AcquiredAt: analysisRuns.t0AcquiredAt,
					t1AcquiredAt: analysisRuns.t1AcquiredAt,
					deforestationHa: analysisRuns.deforestationHa,
					regrowthHa: analysisRuns.regrowthHa,
					cartographicScale: exportPackages.cartographicScale,
					paperFormat: exportPackages.paperFormat,
					generatedAt: exportPackages.generatedAt,
					issuerFullName: users.fullName,
					issuerRegistrationCode: users.registrationCode,
					matchedArtifact: sql<'PDF_CARTA_IMAGEM' | 'ZIP_PACOTE_TECNICO'>`
            CASE
              WHEN ${exportPackages.pdfSha256} = ${sha256Lower} THEN 'PDF_CARTA_IMAGEM'
              ELSE 'ZIP_PACOTE_TECNICO'
            END
          `,
				})
				.from(exportPackages)
				.innerJoin(analysisRuns, eq(exportPackages.runId, analysisRuns.id))
				.innerJoin(analysisCases, eq(analysisRuns.caseId, analysisCases.id))
				.innerJoin(users, eq(exportPackages.generatedBy, users.id))
				.where(
					or(
						eq(exportPackages.pdfSha256, sha256Lower),
						eq(exportPackages.zipSha256, sha256Lower),
					),
				)
				.limit(1);

			return row ?? null;
		} catch (error) {
			throw parseDatabaseError(error, 'ExportRepository.verifyArtifactBySha256');
		}
	}
}

export default new ExportRepository();
