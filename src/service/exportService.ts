import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { withTransaction } from '../config/dbConfig.js';
import auditRepository from '../repository/auditRepository.js';
import exportRepository from '../repository/exportRepository.js';
import runEventsRepository, {
	type CartographyExportJobPayload,
} from '../repository/runEventsRepository.js';
import { storageRepository } from '../repository/storageRepository.js';
import { DomainError } from '../utils/helpers/domainError.js';
import type {
	AuthenticatedUser,
	RequestClientContext,
} from '../utils/helpers/requestGuard.js';
import { sanitizePlainText } from '../utils/helpers/sanitizer.js';
import {
	DownloadExportQuerySchema,
	ExportIdParamsSchema,
	RequestExportBodySchema,
	VerifyIntegrityJsonBodySchema,
} from '../utils/validation/exportValidation.js';
import { RunIdParamsSchema } from '../utils/validation/runValidation.js';

export interface MultipartFileStreamInput {
	filename: string;
	mimetype: string;
	file: Readable & { truncated?: boolean };
}

// Camada Service ("Segurança"): Zod estrito, Zero Trust em exportações, auditoria pré-download e verificação SHA-256
export class ExportService {
	private enqueueExportJobFn: (payload: CartographyExportJobPayload) => Promise<string>;

	constructor(deps?: {
		enqueueExportJobFn?: (payload: CartographyExportJobPayload) => Promise<string>;
	}) {
		this.enqueueExportJobFn =
			deps?.enqueueExportJobFn ??
			((payload) => runEventsRepository.enqueueCartographyExportJob(payload));
	}

	setAdaptersForTesting(deps: {
		enqueueExportJobFn?: (payload: CartographyExportJobPayload) => Promise<string>;
	}): void {
		if (deps.enqueueExportJobFn) {
			this.enqueueExportJobFn = deps.enqueueExportJobFn;
		}
	}

	async requestExport(
		rawParams: unknown,
		rawBody: unknown,
		actor: AuthenticatedUser,
		clientCtx: RequestClientContext,
	) {
		const { runId } = RunIdParamsSchema.parse(rawParams);
		const body = RequestExportBodySchema.parse(rawBody ?? {});

		const sanitizedObs =
			body.observations !== undefined && body.observations !== null
				? sanitizePlainText(body.observations)
				: '';
		const observations = sanitizedObs.length > 0 ? sanitizedObs : null;

		const txResult = await withTransaction(async (tx) => {
			const locked = await exportRepository.lockRunForExport(runId, tx);
			if (!locked) {
				throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Execução de análise não encontrada.');
			}

			if (locked.status === 'frozen' || locked.hasExport) {
				throw new DomainError(
					'ERR_RUN_FROZEN',
					'Esta execução já possui pacote técnico emitido e encontra-se congelada.',
				);
			}

			if (locked.status !== 'ready_for_review') {
				throw new DomainError(
					'ERR_RUN_NOT_REVIEWABLE',
					`Exportação disponível apenas no estado ready_for_review (estado atual: '${locked.status}').`,
				);
			}

			await exportRepository.markRunExporting(runId, tx);

			await auditRepository.insert(
				{
					actorUserId: actor.id,
					action: 'export_requested',
					entityType: 'analysis_run',
					entityId: runId,
					ipAddress: clientCtx.ipAddress,
					userAgent: clientCtx.userAgent,
					correlationId: clientCtx.correlationId,
					metadata: {
						caseId: locked.caseId,
						paperFormat: body.paperFormat,
						hasObservations: observations !== null,
					},
				},
				tx,
			);

			return { caseId: locked.caseId };
		});

		try {
			await this.enqueueExportJobFn({
				runId,
				caseId: txResult.caseId,
				paperFormat: body.paperFormat,
				observations,
				requestedByUserId: actor.id,
				correlationId: clientCtx.correlationId,
			});
		} catch (enqueueErr) {
			await exportRepository.revertRunFromExportingToReview(
				runId,
				'ERR_QUEUE_ENQUEUE_FAILED',
				'Falha ao enfileirar emissão do pacote cartográfico no Redis/BullMQ.',
			);
			throw enqueueErr instanceof DomainError
				? enqueueErr
				: new DomainError(
						'ERR_SERVICE_UNAVAILABLE',
						'Fila de renderização cartográfica temporariamente indisponível.',
					);
		}

		return {
			runId,
			status: 'exporting' as const,
			eventsUrl: `/api/v1/runs/${runId}/events`,
		};
	}

	async getRunExportMetadata(rawParams: unknown) {
		const { runId } = RunIdParamsSchema.parse(rawParams);
		const meta = await exportRepository.findExportMetadataByRunId(runId);
		if (!meta) {
			throw new DomainError(
				'ERR_RESOURCE_NOT_FOUND',
				'Pacote técnico ainda não emitido para a execução informada.',
			);
		}

		return {
			exportId: meta.exportId,
			runId: meta.runId,
			caseId: meta.caseId,
			protocolCode: meta.protocolCode,
			runVersion: meta.runVersion,
			paperFormat: meta.paperFormat,
			cartographicScale: meta.cartographicScale,
			observations: meta.observations,
			pdfSizeBytes: meta.pdfSizeBytes,
			pdfSha256: meta.pdfSha256,
			zipSizeBytes: meta.zipSizeBytes,
			zipSha256: meta.zipSha256,
			generatedAt: meta.generatedAt.toISOString(),
			issuer: {
				id: meta.issuerId,
				fullName: meta.issuerFullName,
				registrationCode: meta.issuerRegistrationCode,
			},
			downloads: {
				pdfUrl: `/api/v1/exports/${meta.exportId}/download?artifact=pdf`,
				zipUrl: `/api/v1/exports/${meta.exportId}/download?artifact=zip`,
			},
			auditManifest: meta.auditManifest,
		};
	}

	async downloadExportArtifact(
		rawParams: unknown,
		rawQuery: unknown,
		actor: AuthenticatedUser,
		clientCtx: RequestClientContext,
	) {
		const { exportId } = ExportIdParamsSchema.parse(rawParams);
		const { artifact } = DownloadExportQuerySchema.parse(rawQuery ?? {});

		const pkg = await exportRepository.findExportForDownloadById(exportId);
		if (!pkg) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Pacote técnico não encontrado.');
		}

		const isPdf = artifact === 'pdf';
		const storageKey = isPdf ? pkg.pdfStorageKey : pkg.zipStorageKey;
		const sha256 = isPdf ? pkg.pdfSha256 : pkg.zipSha256;
		const sizeBytes = isPdf ? pkg.pdfSizeBytes : pkg.zipSizeBytes;
		const contentType = isPdf ? 'application/pdf' : 'application/zip';
		const fileName = isPdf
			? `CARTA_IMAGEM_${pkg.protocolCode}_v${pkg.runVersion}.pdf`
			: `PACOTE_${pkg.protocolCode}_v${pkg.runVersion}.zip`;

		// OpenAPI Seção 3: Registrar export_downloaded obrigatoriamente ANTES de iniciar stream S3
		await auditRepository.insert({
			actorUserId: actor.id,
			action: 'export_downloaded',
			entityType: 'export_package',
			entityId: pkg.exportId,
			ipAddress: clientCtx.ipAddress,
			userAgent: clientCtx.userAgent,
			correlationId: clientCtx.correlationId,
			metadata: {
				runId: pkg.runId,
				caseId: pkg.caseId,
				protocolCode: pkg.protocolCode,
				runVersion: pkg.runVersion,
				artifact,
				sha256,
				fileName,
			},
		});

		const s3Object = await storageRepository.getPrivateObjectStream(storageKey, pkg.storageBucket);

		return {
			stream: s3Object.stream,
			contentType,
			sizeBytes,
			sha256,
			fileName,
		};
	}

	private async lookupAndAuditIntegrityHash(params: {
		sha256Lower: string;
		verificationMode: 'json_hash' | 'multipart_stream';
		fileName?: string;
		byteLength?: number;
		actor: AuthenticatedUser;
		clientCtx: RequestClientContext;
	}) {
		const matched = await exportRepository.verifyArtifactBySha256(params.sha256Lower);

		const municipalityLabel = matched
			? matched.primaryMunicipalityName && matched.stateUf
				? `${matched.primaryMunicipalityName} — ${matched.stateUf.trim()}`
				: (matched.primaryMunicipalityName ?? matched.stateUf?.trim() ?? 'N/A')
			: null;

		const response = matched
			? {
					verified: true,
					matchedArtifact: matched.matchedArtifact,
					sha256: params.sha256Lower,
					record: {
						exportId: matched.exportId,
						protocolCode: matched.protocolCode,
						title: matched.title,
						municipality: municipalityLabel!,
						runVersion: matched.runVersion,
						t0AcquiredAt: matched.t0AcquiredAt.toISOString(),
						t1AcquiredAt: matched.t1AcquiredAt.toISOString(),
						deforestationHa: Number(matched.deforestationHa ?? 0),
						regrowthHa: Number(matched.regrowthHa ?? 0),
						cartographicScale: matched.cartographicScale,
						paperFormat: matched.paperFormat,
						generatedAt: matched.generatedAt.toISOString(),
						issuer: {
							fullName: matched.issuerFullName,
							registrationCode: matched.issuerRegistrationCode,
						},
					},
				}
			: {
					verified: false,
					matchedArtifact: null,
					sha256: params.sha256Lower,
					record: null,
				};

		await auditRepository.insert({
			actorUserId: params.actor.id,
			action: 'integrity_verified',
			entityType: 'export_package',
			entityId: matched ? matched.exportId : null,
			ipAddress: params.clientCtx.ipAddress,
			userAgent: params.clientCtx.userAgent,
			correlationId: params.clientCtx.correlationId,
			metadata: {
				verificationMode: params.verificationMode,
				sha256: params.sha256Lower,
				verified: response.verified,
				matchedArtifact: response.matchedArtifact,
				...(params.fileName ? { fileName: params.fileName } : {}),
				...(params.byteLength !== undefined ? { byteLength: params.byteLength } : {}),
			},
		});

		return response;
	}

	async verifyIntegrityByJson(
		rawBody: unknown,
		actor: AuthenticatedUser,
		clientCtx: RequestClientContext,
	) {
		const { sha256 } = VerifyIntegrityJsonBodySchema.parse(rawBody);
		return this.lookupAndAuditIntegrityHash({
			sha256Lower: sha256,
			verificationMode: 'json_hash',
			actor,
			clientCtx,
		});
	}

	// OpenAPI Seção 3 & RF-32: Hashing em streaming sem gravar arquivo em disco (limite 100 MB)
	async verifyIntegrityByStream(
		fileInput: MultipartFileStreamInput,
		actor: AuthenticatedUser,
		clientCtx: RequestClientContext,
	) {
		const hash = createHash('sha256');
		let byteLength = 0;

		for await (const chunk of fileInput.file) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			byteLength += buf.byteLength;
			hash.update(buf);
		}

		if (fileInput.file.truncated) {
			throw new DomainError(
				'ERR_VALIDATION_FAILED',
				'O arquivo enviado excede o teto operacional permitido de 100 MB.',
				{
					statusCode: 413,
					title: 'Payload excede o limite permitido',
					invalidParams: [{ field: 'file', reason: 'FILE_TOO_LARGE_100MB' }],
				},
			);
		}

		if (byteLength === 0) {
			throw new DomainError(
				'ERR_VALIDATION_FAILED',
				'O arquivo enviado está vazio (0 bytes).',
				{
					invalidParams: [{ field: 'file', reason: 'EMPTY_FILE_UPLOAD' }],
				},
			);
		}

		const sha256Lower = hash.digest('hex');

		return this.lookupAndAuditIntegrityHash({
			sha256Lower,
			verificationMode: 'multipart_stream',
			fileName: fileInput.filename,
			byteLength,
			actor,
			clientCtx,
		});
	}
}

export default new ExportService();
