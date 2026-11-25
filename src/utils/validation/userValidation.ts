import { z } from 'zod';
import { userRoleEnum } from '../../config/db/schema/enums.js';

export const UserRecordSchema = z
	.object({
		id: z.string().uuid(),
		fullName: z.string(),
		registrationCode: z.string(),
		email: z.string().email(),
		role: z.enum(userRoleEnum.enumValues),
		active: z.boolean(),
		lastLoginAt: z.string().datetime().nullable(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.strict();

export const ListUsersQuerySchema = z
	.object({
		role: z.enum(userRoleEnum.enumValues).optional(),
		active: z
			.enum(['true', 'false'])
			.transform((v) => v === 'true')
			.optional(),
	})
	.strict();

export const ListUsersResponseSchema = z
	.object({
		items: z.array(UserRecordSchema),
	})
	.strict();

// OpenAPI Seção 3 (Módulo 2): Política mínima de 12 caracteres no cadastro de operadores
export const CreateUserBodySchema = z
	.object({
		fullName: z.string().trim().min(3).max(160),
		registrationCode: z.string().trim().min(2).max(40),
		email: z.string().trim().toLowerCase().email().max(254),
		password: z.string().min(12).max(128),
		role: z.enum(userRoleEnum.enumValues),
	})
	.strict();

export const UpdateUserParamsSchema = z
	.object({
		userId: z.string().uuid(),
	})
	.strict();

export const UpdateUserBodySchema = z
	.object({
		fullName: z.string().trim().min(3).max(160).optional(),
		role: z.enum(userRoleEnum.enumValues).optional(),
		active: z.boolean().optional(),
	})
	.strict()
	.refine((obj) => Object.keys(obj).length > 0, {
		message: 'Informe ao menos um campo para atualização (fullName, role ou active).',
	});

export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>;
export type UpdateUserParams = z.infer<typeof UpdateUserParamsSchema>;
export type UpdateUserBody = z.infer<typeof UpdateUserBodySchema>;
