import { z } from 'zod';
import { userRoleEnum } from '../../config/db/schema/enums.js';

export const LoginBodySchema = z
	.object({
		email: z.string().trim().toLowerCase().email().max(254),
		password: z.string().min(8).max(128),
	})
	.strict();

export const AuthenticatedUserSchema = z
	.object({
		id: z.string().uuid(),
		fullName: z.string(),
		registrationCode: z.string(),
		email: z.string().email(),
		role: z.enum(userRoleEnum.enumValues),
	})
	.strict();

export const AuthTokenResponseSchema = z
	.object({
		accessToken: z.string(),
		expiresInSeconds: z.number().int(),
		user: AuthenticatedUserSchema,
	})
	.strict();

export const LogoutResponseSchema = z
	.object({
		revoked: z.boolean(),
	})
	.strict();

export type LoginBody = z.infer<typeof LoginBodySchema>;
