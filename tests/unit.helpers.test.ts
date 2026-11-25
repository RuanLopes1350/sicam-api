import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	generateRefreshTokenSecret,
	hashPassword,
	sha256Hex,
	signAccessToken,
	verifyAccessToken,
	verifyPassword,
} from '../src/utils/helpers/crypto.js';
import { checkSeasonalityWarning } from '../src/utils/helpers/dateUtils.js';
import { DomainError } from '../src/utils/helpers/domainError.js';
import { domainErrorToProblem } from '../src/utils/helpers/problemDetails.js';
import { escapeHtml, sanitizePlainText } from '../src/utils/helpers/sanitizer.js';

describe('Utilitários Core & Zero Trust (Unit)', () => {
	it('deve escapar HTML estritamente sem corromper texto seguro (RNF-05)', () => {
		const raw = `<script>alert("xss" & 'inject')</script>`;
		expect(escapeHtml(raw)).toBe(
			'&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;inject&#39;)&lt;/script&gt;',
		);
		expect(sanitizePlainText('  Gleba\u0000 04 \n Sul  ')).toBe('Gleba 04 \n Sul');
	});

	it('deve detectar alerta de sazonalidade cíclica acima de 60 dias (RF-14)', () => {
		// Mesma época em anos distintos (agosto vs agosto) -> 5 dias cíclicos -> sem alerta
		expect(
			checkSeasonalityWarning(
				new Date('2024-08-14T14:27:19Z'),
				new Date('2026-08-19T14:27:25Z'),
			),
		).toBe(false);

		// Virada de ano (28 dez vs 05 jan) -> 8 dias cíclicos -> sem alerta
		expect(
			checkSeasonalityWarning(
				new Date('2024-12-28T12:00:00Z'),
				new Date('2026-01-05T12:00:00Z'),
			),
		).toBe(false);

		// Período chuvoso vs estiagem (fevereiro vs agosto) -> ~180 dias -> alerta!
		expect(
			checkSeasonalityWarning(
				new Date('2024-02-10T12:00:00Z'),
				new Date('2026-08-15T12:00:00Z'),
			),
		).toBe(true);
	});

	it('deve gerar hash Argon2id e assinar/validar JWT EdDSA (RNF-01)', async () => {
		const hash = await hashPassword('SenhaForte@2026!');
		expect(hash.startsWith('$argon2id$')).toBe(true);
		expect(await verifyPassword(hash, 'SenhaForte@2026!')).toBe(true);
		expect(await verifyPassword(hash, 'SenhaErrada@2026!')).toBe(false);

		const userId = randomUUID();
		const token = await signAccessToken({
			sub: userId,
			role: 'analyst',
			registrationCode: 'MAT-1042',
		});

		const claims = await verifyAccessToken(token);
		expect(claims).toEqual({
			sub: userId,
			role: 'analyst',
			registrationCode: 'MAT-1042',
		});

		const refresh = generateRefreshTokenSecret();
		expect(sha256Hex(refresh.rawToken)).toBe(refresh.tokenHash);
	});

	it('deve formatar ProblemDetails estritamente no padrão RFC 9457 (RNF-02)', () => {
		const corrId = randomUUID();
		const err = new DomainError(
			'ERR_AOI_AREA_OUT_OF_BOUNDS',
			'A área excede 50000 ha.',
			{
				invalidParams: [
					{
						field: 'aoiGeoJson',
						reason: 'MAX_AREA_EXCEEDED',
						meta: { calculatedHa: 62450.12, maxAllowedHa: 50000 },
					},
				],
			},
		);

		const problem = domainErrorToProblem(err, '/api/v1/cases', corrId);
		expect(problem).toEqual({
			type: 'https://api.sicam.local/problems/aoi-area-out-of-bounds',
			title: 'Área de interesse fora dos limites operacionais',
			status: 422,
			code: 'ERR_AOI_AREA_OUT_OF_BOUNDS',
			detail: 'A área excede 50000 ha.',
			instance: '/api/v1/cases',
			correlationId: corrId,
			invalidParams: [
				{
					field: 'aoiGeoJson',
					reason: 'MAX_AREA_EXCEEDED',
					meta: { calculatedHa: 62450.12, maxAllowedHa: 50000 },
				},
			],
		});
	});
});
