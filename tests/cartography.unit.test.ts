import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { CartographyRunBundle } from '../src/repository/cartographyRepository.js';
import { ANALYSIS_PRESETS } from '../src/config/presets.js';
import {
	buildCartographicPlateHtml,
	composeCloudHatchOverlayDataUri,
	composePrintFramePngDataUri,
	computeGraphicScaleBar,
	computeLockedCartographicFrame,
	computeUtmGridLines,
	escapeHtmlStrict,
	formatAreaPtBr,
	formatDmsCoordinate,
	formatPctPtBr,
	formatScaleDistanceLabel,
	formatScaleRatio,
	formatUtmMetersLabel,
	NORMALIZED_CARTOGRAPHIC_SCALES,
	PAPER_LAYOUTS,
	renderGraphicScaleBarSvg,
	renderIbgeInsetMapSvg,
	renderMapPanelSvg,
	renderTrueNorthArrowSvg,
	selectUtmGridStepM,
} from '../src/utils/geo/cartography/index.js';
import { projectCoords } from '../src/utils/geo/projRegistry.js';
import type { AoiPolygonGeoJson } from '../src/utils/validation/caseValidation.js';

function makeUtmBoxAoi(
	eMin: number,
	nMin: number,
	eMax: number,
	nMax: number,
	utmSrid = 31980,
): AoiPolygonGeoJson {
	const utmCrs = `EPSG:${utmSrid}`;
	const p1 = projectCoords(utmCrs, 'EPSG:4674', eMin, nMin);
	const p2 = projectCoords(utmCrs, 'EPSG:4674', eMax, nMin);
	const p3 = projectCoords(utmCrs, 'EPSG:4674', eMax, nMax);
	const p4 = projectCoords(utmCrs, 'EPSG:4674', eMin, nMax);
	return {
		type: 'Polygon',
		coordinates: [[p1, p2, p3, p4, p1]],
	};
}

describe('Task API-09 — Motor Cartográfico A4/A3 (300 DPI) — Testes Unitários', () => {
	describe('1. Sistema de Medidas Físicas e Escala Cartográfica Travada', () => {
		it('deve validar somas milimétricas exatas de A3 e A4 e escolher escala travada determinística', () => {
			for (const fmt of ['A3', 'A4'] as const) {
				const l = PAPER_LAYOUTS[fmt];
				expect(l.pageMarginMm * 2 + l.frameWidthMm).toBeCloseTo(l.sheetWidthMm, 5);
				expect(l.pageMarginMm * 2 + l.frameHeightMm).toBeCloseTo(l.sheetHeightMm, 5);
				expect(l.headerHeightMm + l.gap1Mm + l.panelsRowHeightMm + l.gap2Mm + l.footerHeightMm).toBeCloseTo(
					l.frameHeightMm,
					5,
				);
				expect(l.panelOuterWidthMm * 2 + l.panelGapMm).toBeCloseTo(l.frameWidthMm, 5);
				expect(l.gridGutterMm * 2 + l.mapInnerWidthMm).toBeCloseTo(l.panelOuterWidthMm, 5);
				expect(l.gridGutterMm * 2 + l.mapInnerHeightMm).toBeCloseTo(l.panelOuterHeightMm, 5);
				expect(l.footerBlocksMm.reduce((a, b) => a + b, 0)).toBeCloseTo(l.frameWidthMm, 5);
			}

			// AOI 3400m x 3400m -> W_req = 4216m -> 4216 / 0.181 = 23292 -> trava em 1:25.000 em A3
			const frameA3 = computeLockedCartographicFrame([790000, 8594000, 793400, 8597400], 'A3');
			expect(frameA3.scaleDenominator).toBe(25000);
			expect(NORMALIZED_CARTOGRAPHIC_SCALES).toContain(frameA3.scaleDenominator);
			// Exemplo exato da Spec Seção 2.2: 181 mm * 25.000 = 4.525 m; 176 mm * 25.000 = 4.400 m
			expect(frameA3.mapWidthM).toBe(4525);
			expect(frameA3.mapHeightM).toBe(4400);

			// AOI gigante (~50.000 ha = 22.360m x 22.360m) em A4 testa escalas superiores / fallback
			const frameHugeA4 = computeLockedCartographicFrame([780000, 8570000, 815000, 8595000], 'A4');
			expect(frameHugeA4.scaleDenominator).toBeGreaterThanOrEqual(250000);
			expect(frameHugeA4.mapWidthM).toBeGreaterThanOrEqual((815000 - 780000) * 1.24);

			// Formatadores geodésicos
			expect(formatScaleRatio(25000)).toBe('1:25.000');
			expect(formatUtmMetersLabel(792000, 'E')).toContain('792');
			expect(formatUtmMetersLabel(8598000, 'N')).toContain('N');
			expect(formatAreaPtBr(14.3245, 2)).toBe('14,32');
			expect(formatPctPtBr(52.1)).toBe('52,10');
			expect(formatDmsCoordinate(-12.74056, 'lat')).toBe(`12°44'26"S`);
			expect(formatDmsCoordinate(-60.14583, 'lon')).toBe(`60°08'45"W`);
			expect(formatDmsCoordinate(1.99999, 'lat')).toBe(`2°00'00"N`);
		});
	});

	describe('2. Barra de Escala Gráfica, Seta Norte e Grade UTM SVG', () => {
		it('deve calcular barra de escala milimétrica exata e grade UTM com trava anti-colisão e vetores T0/T1', () => {
			const scale25k = computeGraphicScaleBar(25000, 'A3');
			expect(scale25k.dTotalM).toBe(1000);
			expect(scale25k.barLengthMm).toBe(40);
			expect(scale25k.segmentLengthMm).toBe(10);
			expect(scale25k.labels).toEqual(['0', '250 m', '500 m', '1 km']);
			expect(formatScaleDistanceLabel(750)).toBe('750 m');

			const scaleSmall = computeGraphicScaleBar(2500, 'A3');
			expect(scaleSmall.dTotalM).toBe(100);
			expect(scaleSmall.barLengthMm).toBe(40);

			const scaleBarSvg = renderGraphicScaleBarSvg(scale25k);
			const northSvg = renderTrueNorthArrowSvg(14);
			expect(scaleBarSvg).toContain('<rect');
			expect(scaleBarSvg).toContain('1 km');
			expect(northSvg).toContain('<polygon');
			expect(northSvg).toContain('>N<');

			// Grade UTM: step limpo entre 4..6 intervalos e anti-colisão (< 10 mm do canto)
			expect(selectUtmGridStepM(4525)).toBe(1000);
			expect(selectUtmGridStepM(10000)).toBe(2000);
			expect(selectUtmGridStepM(3765)).toBe(1000); // fallback ratio mais próximo de 5

			const aoiGeoJson = makeUtmBoxAoi(790000, 8594000, 793400, 8597400, 31980);
			const frame = computeLockedCartographicFrame([790000, 8594000, 793400, 8597400], 'A3');
			const gridLines = computeUtmGridLines(frame);
			expect(gridLines.eLines.length).toBeGreaterThanOrEqual(3);
			expect(gridLines.nLines.length).toBeGreaterThanOrEqual(3);

			// Com 1:25.000 (10 mm = 250 m), começar em 790900 coloca 791000 a exatos 4 mm (< 10 mm) do canto esquerdo
			const edgeFrame = {
				...frame,
				mapBboxUtm: [790900, 8594900, 790900 + frame.mapWidthM, 8594900 + frame.mapHeightM] as [
					number,
					number,
					number,
					number,
				],
			};
			const edgeGrid = computeUtmGridLines(edgeFrame);
			expect(edgeGrid.eLines.some((l) => !l.showLabel)).toBe(true);
			expect(edgeGrid.nLines.some((l) => !l.showLabel)).toBe(true);

			// Gera 18 feições (incluindo donut com buraco, degradação e regeneração) para validar limite 15 rótulos P1..P15
			const dummyPoly = makeUtmBoxAoi(791000, 8595000, 791500, 8595500, 31980);
			const dummyHolePoly: AoiPolygonGeoJson = {
				type: 'Polygon',
				coordinates: [
					dummyPoly.coordinates[0]!,
					makeUtmBoxAoi(791150, 8595150, 791350, 8595350, 31980).coordinates[0]!.reverse(),
				],
			};

			const features = Array.from({ length: 18 }, (_, i) => ({
				featureSequence: i + 1,
				featureClass:
					i % 3 === 0 ? ('deforestation' as const) : i % 3 === 1 ? ('degradation' as const) : ('regrowth' as const),
				geomGeoJson: i === 0 ? dummyHolePoly : dummyPoly,
				centroidUtmE: 791250 + i * 20,
				centroidUtmN: 8595250,
			}));

			const t0Svg = renderMapPanelSvg({
				panelKey: 't0',
				frame,
				utmSrid: 31980,
				rgbDataUri: 'data:image/png;base64,AA==',
				aoiGeoJson,
				features,
			});
			const t1Svg = renderMapPanelSvg({
				panelKey: 't1',
				frame,
				utmSrid: 31980,
				rgbDataUri: 'data:image/png;base64,AA==',
				cloudOverlayDataUri: 'data:image/png;base64,AA==',
				aoiGeoJson,
				features,
			});

			// T0 não deve desenhar feições nem rótulos P1..P15
			expect(t0Svg).not.toContain('P1<');
			expect(t0Svg).not.toContain('fill-rule="evenodd"');
			expect(t0Svg).toContain('#FFD600');

			// T1 desenha todas as classes, preserva buraco (evenodd) e limita rótulos em P15
			expect(t1Svg).toContain('fill-rule="evenodd"');
			expect(t1Svg).toContain('>P1</text>');
			expect(t1Svg).toContain('>P15</text>');
			expect(t1Svg).not.toContain('>P16</text>');
			expect(t1Svg).toContain('rotate(-90');
		});
	});

	describe('3. Encarte IBGE SVG, Compositor 300 DPI (sharp) e HTML Anti-XSS', () => {
		it('deve renderizar encarte IBGE com correção cos(lat) e compor Data URIs 300 DPI exatos', async () => {
			const insetSvg = renderIbgeInsetMapSvg({
				widthMm: 80.8,
				heightMm: 49.0,
				stateUf: 'RO',
				stateName: 'Rondônia',
				stateGeom: {
					type: 'MultiPolygon',
					coordinates: [
						[
							[
								[-66.8, -13.7],
								[-59.7, -13.7],
								[-59.7, -7.9],
								[-66.8, -7.9],
								[-66.8, -13.7],
							],
						],
					],
				},
				municipalities: [
					{
						ibgeCode: '1100304',
						name: 'Vilhena',
						geom: {
							type: 'Polygon',
							coordinates: [
								[
									[-60.45, -12.95],
									[-59.95, -12.95],
									[-59.95, -12.45],
									[-60.45, -12.45],
									[-60.45, -12.95],
								],
							],
						},
					},
					{
						ibgeCode: '1100049',
						name: 'Cacoal',
						geom: {
							type: 'MultiPolygon',
							coordinates: [
								[
									[
										[-61.6, -11.6],
										[-61.2, -11.6],
										[-61.2, -11.2],
										[-61.6, -11.2],
										[-61.6, -11.6],
									],
								],
							],
						},
					},
				],
				primaryMunicipalityIbge: '1100304',
				primaryMunicipalityName: 'Vilhena',
				aoiCenterLonLat: [-60.2, -12.7],
			});

			expect(insetSvg).toContain('Rondônia (RO)');
			expect(insetSvg).toContain('Vilhena');
			expect(insetSvg).toContain('fill="#CBD5E1"');
			expect(insetSvg).toContain('fill="#E2E8F0"');
			expect(insetSvg).toContain('fill="#DC2626"');

			// Fallback sem geometrias carregadas
			const emptyInset = renderIbgeInsetMapSvg({
				widthMm: 54,
				heightMm: 34,
				stateUf: null,
				stateName: null,
				stateGeom: null,
				municipalities: [],
				primaryMunicipalityIbge: null,
				primaryMunicipalityName: null,
				aoiCenterLonLat: [-60.2, -12.7],
			});
			expect(emptyInset).toContain('Brasil / SIRGAS 2000');

			// Compositor 300 DPI: transforma raster 100x100 em 1482x1400 (A4) e 2138x2079 (A3)
			const rawRgb = Buffer.alloc(100 * 100 * 4, 180);
			const srcRgbPng = await sharp(rawRgb, { raw: { width: 100, height: 100, channels: 4 } })
				.png()
				.toBuffer();

			const a4Uri = await composePrintFramePngDataUri({
				sourcePngBuffer: srcRgbPng,
				gridBboxUtm: [803750, 8593750, 804750, 8594750],
				mapBboxUtm: [803500, 8593500, 805000, 8595000],
				targetWidthPx: PAPER_LAYOUTS.A4.mapInnerWidthPx,
				targetHeightPx: PAPER_LAYOUTS.A4.mapInnerHeightPx,
			});
			expect(a4Uri.startsWith('data:image/png;base64,')).toBe(true);
			const a4Meta = await sharp(Buffer.from(a4Uri.split(',')[1]!, 'base64')).metadata();
			expect(a4Meta.width).toBe(1482);
			expect(a4Meta.height).toBe(1400);

			// Sem interseção retorna canvas neutro limpo nas dimensões exatas
			const disjointUri = await composePrintFramePngDataUri({
				sourcePngBuffer: srcRgbPng,
				gridBboxUtm: [803750, 8593750, 804750, 8594750],
				mapBboxUtm: [100000, 8000000, 102000, 8002000],
				targetWidthPx: 200,
				targetHeightPx: 150,
			});
			const disjointMeta = await sharp(Buffer.from(disjointUri.split(',')[1]!, 'base64')).metadata();
			expect(disjointMeta.width).toBe(200);
			expect(disjointMeta.height).toBe(150);

			// Cloud overlay: sem nuvens -> null; com pixel cinza (158, 158, 158, 95) -> Data URI
			const cleanMaskPng = await sharp(Buffer.alloc(20 * 20 * 4, 0), {
				raw: { width: 20, height: 20, channels: 4 },
			})
				.png()
				.toBuffer();
			expect(
				await composeCloudHatchOverlayDataUri({
					deltaMaskPngBuffer: cleanMaskPng,
					gridBboxUtm: [0, 0, 200, 200],
					mapBboxUtm: [0, 0, 200, 200],
					targetWidthPx: 100,
					targetHeightPx: 100,
				}),
			).toBeNull();

			const cloudMaskBuf = Buffer.alloc(20 * 20 * 4, 0);
			cloudMaskBuf[0] = 158;
			cloudMaskBuf[1] = 158;
			cloudMaskBuf[2] = 158;
			cloudMaskBuf[3] = 95;
			const cloudMaskPng = await sharp(cloudMaskBuf, {
				raw: { width: 20, height: 20, channels: 4 },
			})
				.png()
				.toBuffer();
			const cloudOverlayUri = await composeCloudHatchOverlayDataUri({
				deltaMaskPngBuffer: cloudMaskPng,
				gridBboxUtm: [0, 0, 200, 200],
				mapBboxUtm: [0, 0, 200, 200],
				targetWidthPx: 100,
				targetHeightPx: 100,
				opacityScale: 0.9,
			});
			expect(cloudOverlayUri?.startsWith('data:image/png;base64,')).toBe(true);
		});

		it('deve escapar estritamente HTML/XSS nos campos humanos e exibir selos RN-04 e RF-14', async () => {
			expect(escapeHtmlStrict(`<script>alert("1")</script>&'`)).toBe(
				'&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt;&amp;&#39;',
			);

			const frame = computeLockedCartographicFrame([804000, 8594000, 804500, 8594500], 'A3');
			const dummyBundle: CartographyRunBundle = {
				runId: '11111111-1111-4111-8111-111111111111',
				caseId: '22222222-2222-4222-8222-222222222222',
				version: 2,
				status: 'ready_for_review',
				protocolCode: 'CI-2026-000042',
				externalRef: '<img src="https://evil.local/ref">',
				title: '<script>window.pwned=1</script> Gleba Teste & Monitoramento',
				primaryMunicipalityIbge: '1100304',
				primaryMunicipalityName: 'Vilhena',
				stateUf: 'RO',
				intersectedMunicipalities: [
					{ ibgeCode: '1100304', name: 'Vilhena', ufCode: 'RO', overlapHa: 25, overlapPct: 100 },
				],
				utmSrid: 31980,
				aoiAreaHa: 100,
				aoiGeoJson: makeUtmBoxAoi(804000, 8594000, 805000, 8595000, 31980),
				aoiBoundsUtm: [804000, 8594000, 805000, 8595000],
				aoiCenterLonLat: [-60.2, -12.7],
				aoiCenterUtm: [804500, 8594500],
				t0Provider: 'aws_earth_search',
				t0Collection: 'sentinel-2-l2a',
				t0ItemIds: ['S2A_T0'],
				t0AcquiredAt: new Date('2024-02-10T14:20:00Z'),
				t0CloudPctAoi: 1.5,
				t0StacMetadata: {
					provider: 'aws_earth_search',
					collection: 'sentinel-2-l2a',
					acquiredAt: '2024-02-10T14:20:00Z',
					aoiCloudPct: 1.5,
					aoiCoveragePct: 100,
					globalCloudPct: 5,
					isMultiTile: false,
					processingBaseline: '05.11',
					boaOffsetApplied: true,
					items: [],
				},
				t1Provider: 'inpe_bdc',
				t1Collection: 'S2_L2A-1',
				t1ItemIds: ['S2B_T1'],
				t1AcquiredAt: new Date('2026-08-15T14:20:00Z'),
				t1CloudPctAoi: 60.0,
				t1StacMetadata: {
					provider: 'inpe_bdc',
					collection: 'S2_L2A-1',
					acquiredAt: '2026-08-15T14:20:00Z',
					aoiCloudPct: 60.0,
					aoiCoveragePct: 100,
					globalCloudPct: 62,
					isMultiTile: false,
					processingBaseline: '05.11',
					boaOffsetApplied: false,
					items: [],
				},
				seasonalityWarning: true,
				presetName: 'CUSTOM',
				isCustomParams: true,
				algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
				engineVersion: '1.0.0',
				validAnalyzedHa: 40,
				cloudMaskedHa: 60,
				deforestationHa: 5,
				degradationHa: 2,
				regrowthHa: 1,
				stableHa: 32,
				executor: { id: '3333', fullName: 'Analista Geo', registrationCode: 'MAT-01' },
				activeFeatures: [],
				rastersByType: {},
				ibgeInset: { stateName: 'Rondônia', stateGeom: null, municipalities: [] },
			};

			const html = await buildCartographicPlateHtml({
				bundle: dummyBundle,
				frame,
				paperFormat: 'A3',
				t0PanelSvg: '<svg></svg>',
				t1PanelSvg: '<svg></svg>',
				ibgeInsetSvg: '<svg></svg>',
				issuer: { fullName: 'Emissor <B>Oficial</B>', registrationCode: 'ANA-99' },
				observations: `<iframe src="https://169.254.169.254/"></iframe> Observação válida.`,
				datasetFingerprintSha256: 'a'.repeat(64),
				emittedAt: new Date('2026-11-26T18:00:00Z'),
			});

			expect(html).not.toContain('<script>');
			expect(html).not.toContain('<iframe');
			expect(html).not.toContain('<img src="https://evil.local');
			expect(html).toContain('&lt;script&gt;window.pwned=1&lt;/script&gt;');
			expect(html).toContain('AVISO RN-04: VISIBILIDADE COMPROMETIDA');
			expect(html).toContain('AVISO RF-14: DIFERENÇA SAZONAL');
			expect(html).toContain('<svg'); // QR Code local embarcado
		});
	});
});
