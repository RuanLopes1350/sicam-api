import type { PaperFormat } from '../../../config/db/schema/enums.js';

const GRAPHIC_SCALE_CANDIDATES_M = [
	100,
	200,
	400,
	500,
	1000,
	2000,
	4000,
	5000,
	10000,
	20000,
	40000,
	50000,
	100000,
] as const;

export interface GraphicScaleBarSpec {
	dTotalM: number;
	barLengthMm: number;
	segmentLengthMm: number;
	labels: [string, string, string, string];
}

export function formatScaleDistanceLabel(meters: number): string {
	if (meters >= 1000) {
		const km = meters / 1000;
		const formattedKm = Number.isInteger(km) ? String(km) : km.toLocaleString('pt-BR');
		return `${formattedKm} km`;
	}
	const formattedM = Number.isInteger(meters) ? String(meters) : meters.toLocaleString('pt-BR');
	return `${formattedM} m`;
}

// Spec Parte II — Seção 5.1: Barra de escala gráfica milimetricamente exata (largura física alvo ~40mm)
export function computeGraphicScaleBar(
	scaleDenominator: number,
	paperFormat: PaperFormat = 'A3',
): GraphicScaleBarSpec {
	const targetMm = paperFormat === 'A3' ? 40.0 : 32.0;
	const targetMeters = (targetMm / 1000) * scaleDenominator;

	let bestDTotal = GRAPHIC_SCALE_CANDIDATES_M[0] as number;
	let bestDiff = Number.POSITIVE_INFINITY;

	for (const candidate of GRAPHIC_SCALE_CANDIDATES_M) {
		const candidateMm = (candidate / scaleDenominator) * 1000;
		// Em A3 prioriza fortemente a faixa [35, 55] mm especificada na Seção 5.1
		const penalty =
			paperFormat === 'A3' && (candidateMm < 35 || candidateMm > 55) ? 1_000_000 : 0;
		const diff = Math.abs(candidate - targetMeters) + penalty;
		if (diff < bestDiff) {
			bestDiff = diff;
			bestDTotal = candidate;
		}
	}

	const barLengthMm = (bestDTotal / scaleDenominator) * 1000;
	const segmentLengthMm = barLengthMm / 4;

	return {
		dTotalM: bestDTotal,
		barLengthMm: Number(barLengthMm.toFixed(4)),
		segmentLengthMm: Number(segmentLengthMm.toFixed(4)),
		labels: [
			'0',
			formatScaleDistanceLabel(bestDTotal / 4),
			formatScaleDistanceLabel(bestDTotal / 2),
			formatScaleDistanceLabel(bestDTotal),
		],
	};
}

export function renderGraphicScaleBarSvg(spec: GraphicScaleBarSpec): string {
	const barH = 2.4;
	const seg = spec.segmentLengthMm;
	const totalW = spec.barLengthMm;
	const padX = 4.0;
	const viewW = totalW + padX * 2;
	const viewH = 10.5;
	const barY = 4.2;

	const tickXs = [0, seg, seg * 2, totalW];

	const rectSegments = [0, 1, 2, 3]
		.map((idx) => {
			const fill = idx % 2 === 0 ? '#0F172A' : '#FFFFFF';
			return `<rect x="${(padX + idx * seg).toFixed(3)}" y="${barY}" width="${seg.toFixed(3)}" height="${barH}" fill="${fill}" stroke="#0F172A" stroke-width="0.22" />`;
		})
		.join('');

	const labelEls = tickXs
		.map((tx, idx) => {
			const label = spec.labels[idx]!;
			const x = (padX + tx).toFixed(3);
			return `
        <line x1="${x}" y1="${(barY - 0.8).toFixed(2)}" x2="${x}" y2="${barY}" stroke="#0F172A" stroke-width="0.22" />
        <text x="${x}" y="2.7" text-anchor="middle" font-size="2.2" font-weight="600" fill="#0F172A">${label}</text>
      `;
		})
		.join('');

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW.toFixed(2)} ${viewH}" width="${viewW.toFixed(2)}mm" height="${viewH}mm" style="display:block;font-family:'Liberation Mono','DejaVu Sans Mono',monospace;">
    ${labelEls}
    ${rectSegments}
  </svg>`;
}

export function renderTrueNorthArrowSvg(heightMm = 14.5): string {
	const aspect = 12 / 18;
	const widthMm = (heightMm * aspect).toFixed(2);
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="${widthMm}mm" height="${heightMm}mm" style="display:block;font-family:'Liberation Sans','DejaVu Sans',sans-serif;">
    <text x="12" y="8.5" text-anchor="middle" font-size="8.5" font-weight="800" fill="#0F172A">N</text>
    <polygon points="12,11 19,33 12,27.5" fill="#0F172A" stroke="#0F172A" stroke-width="0.8" stroke-linejoin="round" />
    <polygon points="12,11 5,33 12,27.5" fill="#FFFFFF" stroke="#0F172A" stroke-width="0.8" stroke-linejoin="round" />
  </svg>`;
}
