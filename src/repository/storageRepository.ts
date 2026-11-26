import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { RasterType } from '../config/db/schema/enums.js';
import { env } from '../config/env.js';
import { logger } from '../config/loggerConfig.js';
import { ensurePrivateBucket, getS3Client } from '../config/s3Config.js';
import { DomainError } from '../utils/helpers/domainError.js';

export interface PutPrivateObjectInput {
	key: string;
	body: Buffer | Uint8Array;
	contentType: string;
	sha256Hex?: string;
	metadata?: Record<string, string>;
}

export interface PutPrivateObjectResult {
	bucket: string;
	key: string;
	sizeBytes: number;
	sha256: string;
}

export interface PrivateObjectBytesResult {
	buffer: Buffer;
	contentType: string;
	contentLength: number;
}

export interface PrivateObjectStreamResult {
	stream: Readable;
	contentType: string;
	contentLength: number | undefined;
}

function mapS3Error(err: unknown, context: string, key: string): DomainError {
	if (err instanceof DomainError) {
		return err;
	}
	const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
		?.httpStatusCode;
	const errName = (err as { name?: string })?.name;

	if (httpStatus === 404 || errName === 'NoSuchKey' || errName === 'NotFound') {
		return new DomainError(
			'ERR_RESOURCE_NOT_FOUND',
			'Artefato ou evidência raster não encontrado no armazenamento privado.',
		);
	}

	logger.error({ context, key, errName, httpStatus, err }, 'Falha ao operar armazenamento S3');
	return new DomainError(
		'ERR_SERVICE_UNAVAILABLE',
		'Serviço de armazenamento privado temporariamente indisponível.',
	);
}

// Camada Repository ("Estoquista"): acesso exclusivo ao Object Storage S3 privado (ADR-09)
export class StorageRepository {
	buildRasterStorageKey(caseId: string, runId: string, assetType: RasterType): string {
		return `cases/${caseId}/runs/${runId}/rasters/${assetType}.png`;
	}

	async putPrivateObject(input: PutPrivateObjectInput): Promise<PutPrivateObjectResult> {
		const bucket = env.S3_BUCKET;
		const buffer = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);
		const sha256 = input.sha256Hex ?? createHash('sha256').update(buffer).digest('hex');

		try {
			await ensurePrivateBucket();
			const client = getS3Client();
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: input.key,
					Body: buffer,
					ContentType: input.contentType,
					ContentLength: buffer.byteLength,
					Metadata: {
						sha256,
						...input.metadata,
					},
				}),
			);

			return {
				bucket,
				key: input.key,
				sizeBytes: buffer.byteLength,
				sha256,
			};
		} catch (err) {
			throw mapS3Error(err, 'storageRepository.putPrivateObject', input.key);
		}
	}

	async getPrivateObjectBytes(
		key: string,
		bucket: string = env.S3_BUCKET,
	): Promise<PrivateObjectBytesResult> {
		try {
			const client = getS3Client();
			const response = await client.send(
				new GetObjectCommand({
					Bucket: bucket,
					Key: key,
				}),
			);

			if (!response.Body) {
				throw new DomainError(
					'ERR_RESOURCE_NOT_FOUND',
					'Corpo do objeto ausente no armazenamento privado.',
				);
			}

			const bytes = await response.Body.transformToByteArray();
			const buffer = Buffer.from(bytes);

			return {
				buffer,
				contentType: response.ContentType ?? 'application/octet-stream',
				contentLength: response.ContentLength ?? buffer.byteLength,
			};
		} catch (err) {
			throw mapS3Error(err, 'storageRepository.getPrivateObjectBytes', key);
		}
	}

	async getPrivateObjectStream(
		key: string,
		bucket: string = env.S3_BUCKET,
	): Promise<PrivateObjectStreamResult> {
		try {
			const client = getS3Client();
			const response = await client.send(
				new GetObjectCommand({
					Bucket: bucket,
					Key: key,
				}),
			);

			if (!response.Body) {
				throw new DomainError(
					'ERR_RESOURCE_NOT_FOUND',
					'Corpo do objeto ausente no armazenamento privado.',
				);
			}

			const stream =
				response.Body instanceof Readable
					? response.Body
					: Readable.fromWeb(response.Body.transformToWebStream() as never);

			return {
				stream,
				contentType: response.ContentType ?? 'application/octet-stream',
				contentLength: response.ContentLength,
			};
		} catch (err) {
			throw mapS3Error(err, 'storageRepository.getPrivateObjectStream', key);
		}
	}
}

export const storageRepository = new StorageRepository();
