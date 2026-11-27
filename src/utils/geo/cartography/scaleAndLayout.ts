import type { PaperFormat } from '../../../config/db/schema/enums.js';

export const PX_PER_MM_300_DPI = 300 / 25.4;

// Sentinel-2 (10 m/pixel): piso de 1:25.000 garante >= ~63,5 DPI nativos no papel sem quadriculado/borrão em AOIs pequenas
export const MIN_SENTINEL2_SCALE_DENOMINATOR = 25_000;
// Imagery Wayback (~0,3m - 1m/pixel): permite escala de detalhe 1:2.500 sem perda de nitidez
export const MIN_HIRES_SCALE_DENOMINATOR = 2_500;

export const NORMALIZED_CARTOGRAPHIC_SCALES = [
	2500,
	5000,
	7500,
	10000,
	12500,
	15000,
	20000,
	25000,
	30000,
	40000,
	50000,
	75000,
	100000,
	125000,
	150000,
	200000,
	250000,
] as const;

export interface PaperLayoutSpec {
	paperFormat: PaperFormat;
	sheetWidthMm: number;
	sheetHeightMm: number;
	sheetWidthPx: number;
	sheetHeightPx: number;
	pageMarginMm: number;
	frameWidthMm: number;
	frameHeightMm: number;
	headerHeightMm: number;
	gap1Mm: number;
	panelsRowHeightMm: number;
	panelGapMm: number;
	panelOuterWidthMm: number;
	panelOuterHeightMm: number;
	gridGutterMm: number;
	mapInnerWidthMm: number;
	mapInnerHeightMm: number;
	mapInnerWidthPx: number;
	mapInnerHeightPx: number;
	gap2Mm: number;
	footerHeightMm: number;
	footerBlocksMm: readonly [number, number, number, number];
	gridFontPt: number;
}

// Spec Parte II — Seção 1: Dimensões físicas milimétricas A3 / A4 Paisagem (300 DPI)
export const PAPER_LAYOUTS: Record<PaperFormat, PaperLayoutSpec> = {
	A3: {
		paperFormat: 'A3',
		sheetWidthMm: 420.0,
		sheetHeightMm: 297.0,
		sheetWidthPx: 4961,
		sheetHeightPx: 3508,
		pageMarginMm: 8.0,
		frameWidthMm: 404.0,
		frameHeightMm: 281.0,
		headerHeightMm: 14.0,
		gap1Mm: 3.0,
		panelsRowHeightMm: 194.0,
		panelGapMm: 6.0,
		panelOuterWidthMm: 199.0,
		panelOuterHeightMm: 194.0,
		gridGutterMm: 9.0,
		mapInnerWidthMm: 181.0,
		mapInnerHeightMm: 176.0,
		mapInnerWidthPx: 2138,
		mapInnerHeightPx: 2079,
		gap2Mm: 3.0,
		footerHeightMm: 67.0,
		footerBlocksMm: [96.0, 86.0, 108.0, 114.0],
		gridFontPt: 6.5,
	},
	A4: {
		paperFormat: 'A4',
		sheetWidthMm: 297.0,
		sheetHeightMm: 210.0,
		sheetWidthPx: 3508,
		sheetHeightPx: 2480,
		pageMarginMm: 6.0,
		frameWidthMm: 285.0,
		frameHeightMm: 198.0,
		headerHeightMm: 11.0,
		gap1Mm: 2.5,
		panelsRowHeightMm: 133.5,
		panelGapMm: 4.0,
		panelOuterWidthMm: 140.5,
		panelOuterHeightMm: 133.5,
		gridGutterMm: 7.5,
		mapInnerWidthMm: 125.5,
		mapInnerHeightMm: 118.5,
		mapInnerWidthPx: 1482,
		mapInnerHeightPx: 1400,
		gap2Mm: 2.5,
		footerHeightMm: 48.5,
		footerBlocksMm: [68.0, 60.0, 76.0, 81.0],
		gridFontPt: 5.5,
	},
};

export interface LockedCartographicFrame {
	paperFormat: PaperFormat;
	layout: PaperLayoutSpec;
	scaleDenominator: number;
	rawDenominator: number;
	centerUtmE: number;
	centerUtmN: number;
	mapWidthM: number;
	mapHeightM: number;
	mapBboxUtm: [number, number, number, number];
}

// Spec Parte II — Seção 2.2: Cálculo da Escala Cartográfica Travada e da Janela Exata UTM centrada na AOI
export function computeLockedCartographicFrame(
	aoiBoundsUtm: [number, number, number, number],
	paperFormat: PaperFormat,
	minScaleDenominator: number = MIN_SENTINEL2_SCALE_DENOMINATOR,
): LockedCartographicFrame {
	const [eMin, nMin, eMax, nMax] = aoiBoundsUtm;
	const layout = PAPER_LAYOUTS[paperFormat];

	const spanEM = Math.max(10, eMax - eMin);
	const spanNM = Math.max(10, nMax - nMin);

	const wReqM = spanEM * 1.24;
	const hReqM = spanNM * 1.24;

	const lPapelM = layout.mapInnerWidthMm / 1000;
	const hPapelM = layout.mapInnerHeightMm / 1000;

	const rawDenominator = Math.max(wReqM / lPapelM, hReqM / hPapelM);
	const effectiveRaw = Math.max(rawDenominator, minScaleDenominator);

	let scaleDenominator: number | undefined = NORMALIZED_CARTOGRAPHIC_SCALES.find(
		(s) => s >= effectiveRaw,
	);
	if (scaleDenominator === undefined) {
		scaleDenominator = Math.ceil(effectiveRaw / 50_000) * 50_000;
	}

	const centerUtmE = (eMin + eMax) / 2;
	const centerUtmN = (nMin + nMax) / 2;
	const mapWidthM = lPapelM * scaleDenominator;
	const mapHeightM = hPapelM * scaleDenominator;

	return {
		paperFormat,
		layout,
		scaleDenominator,
		rawDenominator: Number(rawDenominator.toFixed(2)),
		centerUtmE,
		centerUtmN,
		mapWidthM,
		mapHeightM,
		mapBboxUtm: [
			centerUtmE - mapWidthM / 2,
			centerUtmN - mapHeightM / 2,
			centerUtmE + mapWidthM / 2,
			centerUtmN + mapHeightM / 2,
		],
	};
}

// Projeção exata UTM -> coordenadas em mm no viewBox externo da caixa do mapa (incluindo calha)
export function utmToPanelMm(
	easting: number,
	northing: number,
	frame: LockedCartographicFrame,
): [number, number] {
	const [eMapMin, nMapMin, , nMapMax] = frame.mapBboxUtm;
	const { gridGutterMm, mapInnerWidthMm, mapInnerHeightMm } = frame.layout;
	const x = gridGutterMm + ((easting - eMapMin) / frame.mapWidthM) * mapInnerWidthMm;
	const y = gridGutterMm + ((nMapMax - northing) / frame.mapHeightM) * mapInnerHeightMm;
	return [x, y];
}

export function formatUtmMetersLabel(meters: number, axis: 'E' | 'N'): string {
	const rounded = Math.round(meters);
	const formatted = rounded.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
	return `${formatted}m ${axis}`;
}

export function formatScaleRatio(scaleDenominator: number): string {
	return `1:${Math.round(scaleDenominator).toLocaleString('pt-BR')}`;
}

export function formatAreaPtBr(ha: number, decimals = 2): string {
	return ha.toLocaleString('pt-BR', {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});
}

export function formatPctPtBr(pct: number): string {
	return pct.toLocaleString('pt-BR', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

export function formatDmsCoordinate(decimalDeg: number, axis: 'lat' | 'lon'): string {
	const abs = Math.abs(decimalDeg);
	const deg = Math.floor(abs);
	const minFloat = (abs - deg) * 60;
	const min = Math.floor(minFloat);
	let sec = Math.round((minFloat - min) * 60);

	let adjDeg = deg;
	let adjMin = min;
	if (sec >= 60) {
		sec = 0;
		adjMin += 1;
	}
	if (adjMin >= 60) {
		adjMin = 0;
		adjDeg += 1;
	}

	const hemi = axis === 'lat' ? (decimalDeg >= 0 ? 'N' : 'S') : decimalDeg >= 0 ? 'E' : 'W';
	const minStr = String(adjMin).padStart(2, '0');
	const secStr = String(sec).padStart(2, '0');
	return `${adjDeg}°${minStr}'${secStr}"${hemi}`;
}
