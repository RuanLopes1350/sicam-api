import { z } from 'zod';
import { paperFormatEnum, runStatusEnum } from '../../config/db/schema/enums.js';
import { CaseOperatorSummarySchema } from './caseValidation.js';

const SHA256_HEX_REGEX = /^[a-fA-F0-9]{64}$/;

export const ExportIdParamsSchema = z
	.object({
		exportId: z.string().uuid(),
	})
	.strict();

// Header padronizado OpenAPI para disparo idempotente de exportação
export const RequestExportHeadersSchema = z.object({
	'idempotency-key': z.string().uuid(),
});

export const RequestExportBodySchema = z
	.object({
		paperFormat: z.enum(paperFormatEnum.enumValues).default('A3'),
		observations: z.string().trim().max(600).nullable().optional(),
		t0WaybackReleaseNum: z.number().int().positive().nullable().optional(),
		t1WaybackReleaseNum: z.number().int().positive().nullable().optional(),
	})
	.strict();

export const RequestExportAcceptedResponseSchema = z
	.object({
		runId: z.string().uuid(),
		status: z.enum(runStatusEnum.enumValues),
		eventsUrl: z.string(),
	})
	.strict();

export const ExportPackageMetadataResponseSchema = z
	.object({
		exportId: z.string().uuid(),
		runId: z.string().uuid(),
		caseId: z.string().uuid(),
		protocolCode: z.string(),
		runVersion: z.number().int().min(1),
		paperFormat: z.enum(paperFormatEnum.enumValues),
		cartographicScale: z.number().int().positive(),
		observations: z.string().nullable(),
		pdfSizeBytes: z.number().int().positive(),
		pdfSha256: z.string().length(64),
		zipSizeBytes: z.number().int().positive(),
		zipSha256: z.string().length(64),
		generatedAt: z.string().datetime(),
		issuer: CaseOperatorSummarySchema,
		downloads: z
			.object({
				pdfUrl: z.string(),
				zipUrl: z.string(),
			})
			.strict(),
		auditManifest: z.record(z.string(), z.unknown()),
	})
	.strict();

export const DownloadExportQuerySchema = z
	.object({
		artifact: z.enum(['zip', 'pdf']).default('zip'),
	})
	.strict();

export const VerifyIntegrityJsonBodySchema = z
	.object({
		sha256: z
			.string()
			.trim()
			.regex(SHA256_HEX_REGEX, 'sha256 deve conter exatamente 64 caracteres hexadecimais.')
			.transform((val) => val.toLowerCase()),
	})
	.strict();

export const VerifyIntegrityOpenApiBodySchema = z
	.union([
		VerifyIntegrityJsonBodySchema,
		z
			.object({
				file: z.any().describe('Arquivo binário .pdf ou .zip (até 100 MB) em multipart/form-data'),
			})
			.strict(),
	])
	.optional();

export const VerifyIntegrityIssuerSchema = z
	.object({
		fullName: z.string(),
		registrationCode: z.string(),
	})
	.strict();

export const VerifyIntegrityRecordSchema = z
	.object({
		exportId: z.string().uuid(),
		protocolCode: z.string(),
		title: z.string(),
		municipality: z.string(),
		runVersion: z.number().int().min(1),
		t0AcquiredAt: z.string().datetime(),
		t1AcquiredAt: z.string().datetime(),
		deforestationHa: z.number(),
		regrowthHa: z.number(),
		cartographicScale: z.number().int().positive(),
		paperFormat: z.enum(paperFormatEnum.enumValues),
		generatedAt: z.string().datetime(),
		issuer: VerifyIntegrityIssuerSchema,
	})
	.strict();

export const VerifyIntegrityResponseSchema = z
	.object({
		verified: z.boolean(),
		matchedArtifact: z.enum(['PDF_CARTA_IMAGEM', 'ZIP_PACOTE_TECNICO']).nullable(),
		sha256: z.string().length(64),
		record: VerifyIntegrityRecordSchema.nullable(),
	})
	.strict();

export type RequestExportBody = z.infer<typeof RequestExportBodySchema>;
export type DownloadExportQuery = z.infer<typeof DownloadExportQuerySchema>;
export type VerifyIntegrityJsonBody = z.infer<typeof VerifyIntegrityJsonBodySchema>;
export type VerifyIntegrityResponse = z.infer<typeof VerifyIntegrityResponseSchema>;
