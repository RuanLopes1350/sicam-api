import { z } from 'zod';
import { env } from '../../config/env.js';
import { DomainError, ERROR_CATALOG, type ErrorCode, type InvalidParamDetail } from './domainError.js';

export const InvalidParamSchema = z
	.object({
		field: z.string(),
		reason: z.string(),
		meta: z.record(z.unknown()).optional(),
	})
	.strict();

// RNF-02 & Contrato OpenAPI 3.1 Seção 1.2: RFC 9457 Problem Details for HTTP APIs
export const ProblemDetailsSchema = z
	.object({
		type: z.string().url(),
		title: z.string(),
		status: z.number().int(),
		code: z.string(),
		detail: z.string(),
		instance: z.string(),
		correlationId: z.string().uuid(),
		invalidParams: z.array(InvalidParamSchema).optional(),
	})
	.strict();

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export function buildProblemDetails(params: {
	code: ErrorCode;
	detail: string;
	instance: string;
	correlationId: string;
	statusOverride?: number;
	titleOverride?: string;
	invalidParams?: InvalidParamDetail[];
}): ProblemDetails {
	const catalog = ERROR_CATALOG[params.code];
	const baseUri = env.API_PROBLEM_BASE_URI.replace(/\/+$/, '');

	return {
		type: `${baseUri}/${catalog.slug}`,
		title: params.titleOverride ?? catalog.title,
		status: params.statusOverride ?? catalog.status,
		code: params.code,
		detail: params.detail,
		instance: params.instance,
		correlationId: params.correlationId,
		...(params.invalidParams && params.invalidParams.length > 0
			? { invalidParams: params.invalidParams }
			: {}),
	};
}

export function domainErrorToProblem(
	err: DomainError,
	instance: string,
	correlationId: string,
): ProblemDetails {
	return buildProblemDetails({
		code: err.errorCode,
		detail: err.message,
		instance,
		correlationId,
		statusOverride: err.statusCode,
		titleOverride: err.title,
		invalidParams: err.invalidParams,
	});
}
