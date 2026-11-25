import {
	CreateBucketCommand,
	HeadBucketCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { env } from './env.js';

let s3Instance: S3Client | null = null;
let bucketInitialized = false;

// ADR-09: Bucket S3 auto-hospedado 100% privado com S3_ENDPOINT e forcePathStyle
export function getS3Client(): S3Client {
	if (!s3Instance) {
		s3Instance = new S3Client({
			endpoint: env.S3_ENDPOINT,
			region: env.S3_REGION,
			forcePathStyle: env.S3_FORCE_PATH_STYLE,
			credentials: {
				accessKeyId: env.S3_ACCESS_KEY_ID,
				secretAccessKey: env.S3_SECRET_ACCESS_KEY,
			},
		});
	}
	return s3Instance;
}

export async function ensurePrivateBucket(): Promise<void> {
	const client = getS3Client();
	try {
		await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
		bucketInitialized = true;
	} catch (err: unknown) {
		const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
			?.httpStatusCode;
		const name = (err as { name?: string })?.name;
		if (statusCode === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
			await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
			bucketInitialized = true;
			return;
		}
		throw err;
	}
}

export async function checkS3Readiness(): Promise<boolean> {
	if (!bucketInitialized) {
		await ensurePrivateBucket();
		return true;
	}
	await getS3Client().send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
	return true;
}

export function closeS3(): void {
	if (s3Instance) {
		s3Instance.destroy();
		s3Instance = null;
		bucketInitialized = false;
	}
}
