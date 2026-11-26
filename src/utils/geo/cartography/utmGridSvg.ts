import type { FeatureClass } from '../../../config/db/schema/enums.js';
import { projectCoords } from '../projRegistry.js';
import type { AoiPolygonGeoJson } from '../../validation/caseValidation.js';
import type { DetectedFeaturePolygonGeoJson } from '../../validation/runValidation.js';
import {
	formatUtmMetersLabel,
	type LockedCartographicFrame,
	utmToPanelMm,
} from './scaleAndLayout.js';

export const UTM_GRID_STEPS_M = [
	100,
	200,
	250,
	500,
	1000,
	2000,
	2500,
	5000,
	10000,
	20000,
	25000,
	50000,
] as const;

export interface UtmGridTickLine {
	meters: number;
	label: string;
	posMm: number;
	showLabel: boolean;
}

export interface ComputedUtmGrid {
	stepM: number;
	eLines: UtmGridTickLine[];
	nLines: UtmGridTickLine[];
}

export interface CartographicVectorFeatureInput {
	featureSequence: number;
	featureClass: FeatureClass;
	geomGeoJson: DetectedFeaturePolygonGeoJson;
	centroidUtmE: number;
	centroidUtmN: number;
}

const CORNER_ANTI_COLLISION_MM = 10.0;
const MAX_FEATURE_LABELS_ON_PLATE = 15;

// Spec Parte II — Seção 3.1: Seleciona menor múltiplo limpo com 4 <= floor(W_mapa / delta) <= 6
export function selectUtmGridStepM(mapWidthM: number): number {
	for (const step of UTM_GRID_STEPS_M) {
		const count = Math.floor(mapWidthM / step);
		if (count >= 4 && count <= 6) {
			return step;
		}
	}

	let bestStep: number = UTM_GRID_STEPS_M[0];
	let bestDistanceToFive = Number.POSITIVE_INFINITY;
	for (const step of UTM_GRID_STEPS_M) {
		const ratio = mapWidthM / step;
		const dist = Math.abs(ratio - 5.0);
		if (dist < bestDistanceToFive) {
			bestDistanceToFive = dist;
			bestStep = step;
		}
	}
	return bestStep;
}

// Spec Parte II — Seção 3.2: Posições das linhas UTM e trava anti-colisão nos cantos (< 10,0 mm)
export function computeUtmGridLines(frame: LockedCartographicFrame): ComputedUtmGrid {
	const stepM = selectUtmGridStepM(frame.mapWidthM);
	const [eMapMin, nMapMin, eMapMax, nMapMax] = frame.mapBboxUtm;
	const { gridGutterMm, mapInnerWidthMm, mapInnerHeightMm } = frame.layout;

	const eLines: UtmGridTickLine[] = [];
	const eFirst = Math.ceil(eMapMin / stepM) * stepM;
	for (let e = eFirst; e <= eMapMax + 1e-6; e += stepM) {
		const xMm = gridGutterMm + ((e - eMapMin) / frame.mapWidthM) * mapInnerWidthMm;
		if (xMm < gridGutterMm - 1e-4 || xMm > gridGutterMm + mapInnerWidthMm + 1e-4) {
			continue;
		}
		const distFromLeft = xMm - gridGutterMm;
		const distFromRight = gridGutterMm + mapInnerWidthMm - xMm;
		const showLabel =
			distFromLeft >= CORNER_ANTI_COLLISION_MM && distFromRight >= CORNER_ANTI_COLLISION_MM;
		eLines.push({
			meters: e,
			label: formatUtmMetersLabel(e, 'E'),
			posMm: Number(xMm.toFixed(3)),
			showLabel,
		});
	}

	const nLines: UtmGridTickLine[] = [];
	const nFirst = Math.ceil(nMapMin / stepM) * stepM;
	for (let n = nFirst; n <= nMapMax + 1e-6; n += stepM) {
		const yMm = gridGutterMm + ((nMapMax - n) / frame.mapHeightM) * mapInnerHeightMm;
		if (yMm < gridGutterMm - 1e-4 || yMm > gridGutterMm + mapInnerHeightMm + 1e-4) {
			continue;
		}
		const distFromTop = yMm - gridGutterMm;
		const distFromBottom = gridGutterMm + mapInnerHeightMm - yMm;
		const showLabel =
			distFromTop >= CORNER_ANTI_COLLISION_MM && distFromBottom >= CORNER_ANTI_COLLISION_MM;
		nLines.push({
			meters: n,
			label: formatUtmMetersLabel(n, 'N'),
			posMm: Number(yMm.toFixed(3)),
			showLabel,
		});
	}

	return { stepM, eLines, nLines };
}

function ringsGeoJsonToSvgPath(
	rings4674: ReadonlyArray<ReadonlyArray<[number, number]>>,
	utmSrid: number,
	frame: LockedCartographicFrame,
): string {
	const utmCrs = `EPSG:${utmSrid}`;
	const parts: string[] = [];

	for (const ring of rings4674) {
		if (ring.length < 3) continue;
		const cmds: string[] = [];
		for (let i = 0; i < ring.length; i++) {
			const [lon, lat] = ring[i]!;
			const [e, n] = projectCoords('EPSG:4674', utmCrs, lon, lat);
			const [xMm, yMm] = utmToPanelMm(e, n, frame);
			cmds.push(`${i === 0 ? 'M' : 'L'}${xMm.toFixed(2)} ${yMm.toFixed(2)}`);
		}
		cmds.push('Z');
		parts.push(cmds.join(' '));
	}

	return parts.join(' ');
}

function featureStyleAttributes(
	featureClass: FeatureClass,
	panelId: string,
): { fill: string; stroke: string; strokeWidthMm: string } {
	switch (featureClass) {
		case 'deforestation':
			return {
				fill: `url(#pat-def-${panelId})`,
				stroke: '#B71C1C',
				strokeWidthMm: '0.35',
			};
		case 'degradation':
			return {
				fill: `url(#pat-deg-${panelId})`,
				stroke: '#E65100',
				strokeWidthMm: '0.30',
			};
		case 'regrowth':
			return {
				fill: `url(#pat-reg-${panelId})`,
				stroke: '#00E676',
				strokeWidthMm: '0.30',
			};
	}
}

// Spec Parte II — Seções 3 e 4: Renderiza quadro completo T0 ou T1 em SVG milimétrico vetorial
export function renderMapPanelSvg(params: {
	panelKey: 't0' | 't1';
	frame: LockedCartographicFrame;
	utmSrid: number;
	rgbDataUri: string;
	cloudOverlayDataUri?: string | null;
	aoiGeoJson: AoiPolygonGeoJson;
	features: ReadonlyArray<CartographicVectorFeatureInput>;
}): string {
	const { panelKey, frame, utmSrid, rgbDataUri, cloudOverlayDataUri, aoiGeoJson, features } = params;
	const {
		panelOuterWidthMm: outerW,
		panelOuterHeightMm: outerH,
		gridGutterMm: gutter,
		mapInnerWidthMm: innerW,
		mapInnerHeightMm: innerH,
		gridFontPt,
	} = frame.layout;

	const grid = computeUtmGridLines(frame);
	const clipId = `clip-map-${panelKey}`;
	const gridFontMm = ((gridFontPt * 25.4) / 72).toFixed(2);
	const labelFontMm = ((6.0 * 25.4) / 72).toFixed(2);

	const aoiPath = ringsGeoJsonToSvgPath(aoiGeoJson.coordinates, utmSrid, frame);

	// T1 renderiza vetores das feições ativas + até 15 rótulos P1..P15; T0 preserva apenas o perímetro da AOI
	const featuresSvg =
		panelKey === 't1'
			? features
					.map((feat) => {
						const pathD = ringsGeoJsonToSvgPath(feat.geomGeoJson.coordinates, utmSrid, frame);
						if (!pathD) return '';
						const st = featureStyleAttributes(feat.featureClass, panelKey);
						return `<path d="${pathD}" fill="${st.fill}" fill-rule="evenodd" stroke="${st.stroke}" stroke-width="${st.strokeWidthMm}" stroke-linejoin="round" />`;
					})
					.join('\n')
			: '';

	const labelsSvg =
		panelKey === 't1'
			? features
					.slice(0, MAX_FEATURE_LABELS_ON_PLATE)
					.map((feat) => {
						const [lx, ly] = utmToPanelMm(feat.centroidUtmE, feat.centroidUtmN, frame);
						return `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-size="${labelFontMm}" font-weight="700" fill="#FFFFFF" stroke="#000000" stroke-width="0.5" paint-order="stroke fill">P${feat.featureSequence}</text>`;
					})
					.join('\n')
			: '';

	const crosshairsSvg = grid.eLines
		.map((el) =>
			grid.nLines
				.map((nl) => {
					const half = 1.5;
					const x = el.posMm.toFixed(2);
					const y = nl.posMm.toFixed(2);
					return `
            <line x1="${(el.posMm - half).toFixed(2)}" y1="${y}" x2="${(el.posMm + half).toFixed(2)}" y2="${y}" stroke="#0F172A" stroke-width="0.38" stroke-opacity="0.45" />
            <line x1="${x}" y1="${(nl.posMm - half).toFixed(2)}" x2="${x}" y2="${(nl.posMm + half).toFixed(2)}" stroke="#0F172A" stroke-width="0.38" stroke-opacity="0.45" />
            <line x1="${(el.posMm - half).toFixed(2)}" y1="${y}" x2="${(el.posMm + half).toFixed(2)}" y2="${y}" stroke="#FFFFFF" stroke-width="0.20" stroke-opacity="0.75" />
            <line x1="${x}" y1="${(nl.posMm - half).toFixed(2)}" x2="${x}" y2="${(nl.posMm + half).toFixed(2)}" stroke="#FFFFFF" stroke-width="0.20" stroke-opacity="0.75" />
          `;
				})
				.join(''),
		)
		.join('');

	const tickLen = 2.0;
	const bottomY = gutter + innerH;
	const rightX = gutter + innerW;

	const eastTicksAndLabelsSvg = grid.eLines
		.map((el) => {
			const x = el.posMm.toFixed(2);
			const topTick = `<line x1="${x}" y1="${(gutter - tickLen).toFixed(2)}" x2="${x}" y2="${gutter.toFixed(2)}" stroke="#111827" stroke-width="0.22" />`;
			const botTick = `<line x1="${x}" y1="${bottomY.toFixed(2)}" x2="${x}" y2="${(bottomY + tickLen).toFixed(2)}" stroke="#111827" stroke-width="0.22" />`;
			if (!el.showLabel) {
				return `${topTick}${botTick}`;
			}
			const topLbl = `<text x="${x}" y="${(gutter - tickLen - 1.1).toFixed(2)}" text-anchor="middle" font-size="${gridFontMm}" fill="#111827">${el.label}</text>`;
			const botLbl = `<text x="${x}" y="${(bottomY + tickLen + 2.8).toFixed(2)}" text-anchor="middle" font-size="${gridFontMm}" fill="#111827">${el.label}</text>`;
			return `${topTick}${botTick}${topLbl}${botLbl}`;
		})
		.join('\n');

	const northTicksAndLabelsSvg = grid.nLines
		.map((nl) => {
			const y = nl.posMm.toFixed(2);
			const leftTick = `<line x1="${(gutter - tickLen).toFixed(2)}" y1="${y}" x2="${gutter.toFixed(2)}" y2="${y}" stroke="#111827" stroke-width="0.22" />`;
			const rightTick = `<line x1="${rightX.toFixed(2)}" y1="${y}" x2="${(rightX + tickLen).toFixed(2)}" y2="${y}" stroke="#111827" stroke-width="0.22" />`;
			if (!nl.showLabel) {
				return `${leftTick}${rightTick}`;
			}
			const leftLblX = (gutter - tickLen - 1.4).toFixed(2);
			const rightLblX = (rightX + tickLen + 2.8).toFixed(2);
			const leftLbl = `<text x="${leftLblX}" y="${y}" text-anchor="middle" transform="rotate(-90 ${leftLblX} ${y})" font-size="${gridFontMm}" fill="#111827">${nl.label}</text>`;
			const rightLbl = `<text x="${rightLblX}" y="${y}" text-anchor="middle" transform="rotate(-90 ${rightLblX} ${y})" font-size="${gridFontMm}" fill="#111827">${nl.label}</text>`;
			return `${leftTick}${rightTick}${leftLbl}${rightLbl}`;
		})
		.join('\n');

	const cloudImageSvg = cloudOverlayDataUri
		? `<image href="${cloudOverlayDataUri}" x="${gutter}" y="${gutter}" width="${innerW}" height="${innerH}" preserveAspectRatio="none" />`
		: '';

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outerW} ${outerH}" width="${outerW}mm" height="${outerH}mm" style="display:block;font-family:'Liberation Mono','DejaVu Sans Mono',monospace;">
    <defs>
      <clipPath id="${clipId}">
        <rect x="${gutter}" y="${gutter}" width="${innerW}" height="${innerH}" />
      </clipPath>
      <pattern id="pat-def-${panelKey}" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="2.4" height="2.4" fill="#D32F2F" fill-opacity="0.35" />
        <line x1="0" y1="0" x2="0" y2="2.4" stroke="#B71C1C" stroke-width="0.55" stroke-opacity="0.7" />
      </pattern>
      <pattern id="pat-deg-${panelKey}" width="2.2" height="2.2" patternUnits="userSpaceOnUse">
        <rect width="2.2" height="2.2" fill="#F57C00" fill-opacity="0.30" />
        <circle cx="1.1" cy="1.1" r="0.35" fill="#E65100" fill-opacity="0.7" />
      </pattern>
      <pattern id="pat-reg-${panelKey}" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <rect width="2.4" height="2.4" fill="#00C853" fill-opacity="0.30" />
        <line x1="0" y1="0" x2="0" y2="2.4" stroke="#00E676" stroke-width="0.45" stroke-opacity="0.6" />
      </pattern>
    </defs>

    <rect x="0" y="0" width="${outerW}" height="${outerH}" fill="#FFFFFF" />

    <g clip-path="url(#${clipId})">
      <image href="${rgbDataUri}" x="${gutter}" y="${gutter}" width="${innerW}" height="${innerH}" preserveAspectRatio="none" />
      ${cloudImageSvg}
      ${featuresSvg}
      <path d="${aoiPath}" fill="none" stroke="#000000" stroke-width="0.90" stroke-linejoin="round" />
      <path d="${aoiPath}" fill="none" stroke="#FFD600" stroke-width="0.45" stroke-linejoin="round" />
      ${crosshairsSvg}
      ${labelsSvg}
    </g>

    <!-- Moldura dupla do quadro cartográfico -->
    <rect x="${gutter}" y="${gutter}" width="${innerW}" height="${innerH}" fill="none" stroke="#111827" stroke-width="0.40" />
    <rect x="${(gutter - 0.6).toFixed(2)}" y="${(gutter - 0.6).toFixed(2)}" width="${(innerW + 1.2).toFixed(2)}" height="${(innerH + 1.2).toFixed(2)}" fill="none" stroke="#111827" stroke-width="0.20" />

    ${eastTicksAndLabelsSvg}
    ${northTicksAndLabelsSvg}
  </svg>`;
}
