import { createHash, randomBytes } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type KeyLike } from 'jose';
import type { UserRole } from '../../config/db/schema/enums.js';
import { env } from '../../config/env.js';

const ARGON2_OPTIONS = {
	algorithm: Algorithm.Argon2id,
	memoryCost: 19456, // 19 MiB (recomendação OWASP)
	timeCost: 2,
	parallelism: 1,
};

let dummyPasswordHashPromise: Promise<string> | null = null;
let privateKeyPromise: Promise<KeyLike> | null = null;
let publicKeyPromise: Promise<KeyLike> | null = null;

// RNF-01: Hash Argon2id exclusivo para senhas
export async function hashPassword(plainPassword: string): Promise<string> {
	return hash(plainPassword, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, plainPassword: string): Promise<boolean> {
	try {
		return await verify(passwordHash, plainPassword);
	} catch {
		return false;
	}
}

// Proteção contra enumeração por timing em e-mails inexistentes no login
export async function verifyDummyPassword(plainPassword: string): Promise<void> {
	if (!dummyPasswordHashPromise) {
		dummyPasswordHashPromise = hashPassword('sicam-anti-enumeration-constant-time-guard');
	}
	const dummyHash = await dummyPasswordHashPromise;
	await verifyPassword(dummyHash, plainPassword);
}

export function sha256Hex(input: string | Buffer): string {
	return createHash('sha256').update(input).digest('hex');
}

export function generateRefreshTokenSecret(): { rawToken: string; tokenHash: string } {
	const rawToken = randomBytes(48).toString('base64url');
	return {
		rawToken,
		tokenHash: sha256Hex(rawToken),
	};
}

export interface AccessTokenClaims {
	sub: string;
	role: UserRole;
	registrationCode: string;
}

async function getPrivateKey(): Promise<KeyLike> {
	if (!privateKeyPromise) {
		privateKeyPromise = importPKCS8(env.JWT_PRIVATE_KEY_PEM, 'EdDSA');
	}
	return privateKeyPromise;
}

async function getPublicKey(): Promise<KeyLike> {
	if (!publicKeyPromise) {
		publicKeyPromise = importSPKI(env.JWT_PUBLIC_KEY_PEM, 'EdDSA');
	}
	return publicKeyPromise;
}

// RNF-01: JWT assimétrico EdDSA (Ed25519) com expiração máxima de 15 minutos
export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
	const privateKey = await getPrivateKey();
	return new SignJWT({
		role: claims.role,
		registrationCode: claims.registrationCode,
	})
		.setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
		.setSubject(claims.sub)
		.setIssuer(env.JWT_ISSUER)
		.setAudience(env.JWT_AUDIENCE)
		.setIssuedAt()
		.setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
		.sign(privateKey);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
	const publicKey = await getPublicKey();
	const { payload } = await jwtVerify(token, publicKey, {
		algorithms: ['EdDSA'],
		issuer: env.JWT_ISSUER,
		audience: env.JWT_AUDIENCE,
	});

	if (
		typeof payload.sub !== 'string' ||
		typeof payload.role !== 'string' ||
		typeof payload.registrationCode !== 'string'
	) {
		throw new Error('Claims obrigatórias ausentes no token JWT.');
	}

	return {
		sub: payload.sub,
		role: payload.role as UserRole,
		registrationCode: payload.registrationCode,
	};
}
