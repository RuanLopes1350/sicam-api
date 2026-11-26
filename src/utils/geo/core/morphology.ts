import { DomainError } from '../../helpers/domainError.js';
import { PIXEL_CLASS } from './ndviClassifier.js';

function assertMaskDimensions(
	mask: Uint8Array,
	width: number,
	height: number,
	label: string,
): void {
	if (width <= 0 || height <= 0 || mask.length !== width * height) {
		throw new DomainError(
			'ERR_INTERNAL_SERVER_ERROR',
			`Dimensões inválidas para a máscara '${label}' (${mask.length} vs ${width}x${height}).`,
		);
	}
}

// Spec Parte I — Seção 5.1: Domínio permitido para dilatação (AOI=1 e sem nuvem/sombra/NoData)
export function buildAllowedDomainMask(aoiMask: Uint8Array, classMap: Uint8Array): Uint8Array {
	if (aoiMask.length !== classMap.length) {
		throw new DomainError(
			'ERR_INTERNAL_SERVER_ERROR',
			'Dimensões inconsistentes entre aoiMask e classMap ao construir domínio morfológico.',
		);
	}

	const allowed = new Uint8Array(aoiMask.length);
	for (let i = 0; i < aoiMask.length; i++) {
		if (aoiMask[i] === 1 && classMap[i] !== PIXEL_CLASS.CLOUD_OBSTRUCTED) {
			allowed[i] = 1;
		}
	}
	return allowed;
}

// Spec Parte I — Seção 5.1 (Passo 1): Erosão 3x3 com elemento estruturante em cruz (+)
export function erodeCross3x3(binaryMask: Uint8Array, width: number, height: number): Uint8Array {
	assertMaskDimensions(binaryMask, width, height, 'binaryMask');
	const eroded = new Uint8Array(binaryMask.length);

	if (width < 3 || height < 3) {
		return eroded;
	}

	for (let r = 1; r < height - 1; r++) {
		const rowOffset = r * width;
		for (let c = 1; c < width - 1; c++) {
			const idx = rowOffset + c;
			if (
				binaryMask[idx] === 1 &&
				binaryMask[idx - width] === 1 &&
				binaryMask[idx + width] === 1 &&
				binaryMask[idx - 1] === 1 &&
				binaryMask[idx + 1] === 1
			) {
				eroded[idx] = 1;
			}
		}
	}

	return eroded;
}

// Spec Parte I — Seção 5.1 (Passo 2): Dilatação 3x3 em cruz restringida a AOI válida e livre de nuvem
export function dilateCross3x3(
	erodedMask: Uint8Array,
	width: number,
	height: number,
	allowedDomainMask: Uint8Array,
): Uint8Array {
	assertMaskDimensions(erodedMask, width, height, 'erodedMask');
	assertMaskDimensions(allowedDomainMask, width, height, 'allowedDomainMask');

	const dilated = new Uint8Array(erodedMask.length);

	for (let r = 0; r < height; r++) {
		const rowOffset = r * width;
		for (let c = 0; c < width; c++) {
			const idx = rowOffset + c;
			if (erodedMask[idx] !== 1) {
				continue;
			}

			if (allowedDomainMask[idx] === 1) {
				dilated[idx] = 1;
			}
			if (r > 0 && allowedDomainMask[idx - width] === 1) {
				dilated[idx - width] = 1;
			}
			if (r + 1 < height && allowedDomainMask[idx + width] === 1) {
				dilated[idx + width] = 1;
			}
			if (c > 0 && allowedDomainMask[idx - 1] === 1) {
				dilated[idx - 1] = 1;
			}
			if (c + 1 < width && allowedDomainMask[idx + 1] === 1) {
				dilated[idx + 1] = 1;
			}
		}
	}

	return dilated;
}

// Spec Parte I — Seção 5.1: Abertura Morfológica 3x3 (+) ou bypass quando kernelSize === 0
export function applyMorphologicalOpeningCross3x3(params: {
	binaryMask: Uint8Array;
	width: number;
	height: number;
	allowedDomainMask: Uint8Array;
	kernelSize: 0 | 3;
}): Uint8Array {
	const { binaryMask, width, height, allowedDomainMask, kernelSize } = params;
	assertMaskDimensions(binaryMask, width, height, 'binaryMask');
	assertMaskDimensions(allowedDomainMask, width, height, 'allowedDomainMask');

	if (kernelSize === 0) {
		const out = new Uint8Array(binaryMask.length);
		for (let i = 0; i < binaryMask.length; i++) {
			if (binaryMask[i] === 1 && allowedDomainMask[i] === 1) {
				out[i] = 1;
			}
		}
		return out;
	}

	const eroded = erodeCross3x3(binaryMask, width, height);
	return dilateCross3x3(eroded, width, height, allowedDomainMask);
}
