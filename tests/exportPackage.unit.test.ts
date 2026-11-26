import { describe, expect, it } from 'vitest';
import { ANALYSIS_PRESETS } from '../src/config/presets.js';
import {
	buildAllVectorAndTabularArtifacts,
	buildAoiGeoJsonBuffer,
	buildAoiKmlBuffer,
	buildAuditManifestArtifact,
	buildClassFeaturesGeoJsonBuffer,
	buildClassFeaturesKmlBuffer,
	buildDeterministicZipBuffer,
	buildFeaturesCsvBuffer,
	computeDatasetFingerprintSha256,
	escapeCsvTextCell,
	escapeXmlStrict,
	type ExportFeatureRecord,
	extractZipEntriesFromBuffer,
	type VectorExportContext,
} from '../src/utils/geo/cartography/index.js';
import { sha256Hex } from '../src/utils/helpers/crypto.js';

describe('Task API-10 — Exporters CSV/GeoJSON/KML, Manifesto SHA-256 e Empacotamento ZIP (Unitário)', () => {
	const ctx: VectorExportContext = {
		caseId: '11111111-1111-4111-8111-111111111111',
		protocolCode: 'CI-2026-000142',
		externalRef: 'PROC-2026 & <Teste>',
		title: 'Monitoramento Gleba Norte <RO>',
		primaryMunicipalityName: 'Vilhena',
		stateUf: 'RO',
		aoiAreaHa: 120.5,
		aoiPerimeterM: 4400.25,
		utmSrid: 31980,
		aoiGeoJson: {
			type: 'Polygon',
			coordinates: [
				[
					[-60.2, -12.7],
					[-60.18, -12.7],
					[-60.18, -12.68],
					[-60.2, -12.68],
					[-60.2, -12.7],
				],
			],
		},
		runId: '22222222-2222-4222-8222-222222222222',
		version: 1,
		t0AcquiredAt: new Date('2024-08-14T14:27:19Z'),
		t1AcquiredAt: new Date('2026-08-19T14:27:25Z'),
		engineVersion: '1.0.0',
		presetName: 'TECHNICAL_STANDARD',
	};

	const features: ExportFeatureRecord[] = [
		{
			id: '33333333-3333-4333-8333-333333333331',
			featureSequence: 1,
			featureClass: 'deforestation',
			geomGeoJson: {
				type: 'Polygon',
				coordinates: [
					[
						[-60.195, -12.695],
						[-60.185, -12.695],
						[-60.185, -12.685],
						[-60.195, -12.685],
						[-60.195, -12.695],
					],
					[
						[-60.192, -12.692],
						[-60.192, -12.688],
						[-60.188, -12.688],
						[-60.188, -12.692],
						[-60.192, -12.692],
					],
				],
			},
			areaHa: 14.32,
			pixelCount: 1432,
			meanNdviT0: 0.74,
			meanNdviT1: 0.29,
			meanDeltaNdvi: -0.45,
			centroidLat: -12.69,
			centroidLon: -60.19,
			centroidUtmE: 805120.55,
			centroidUtmN: 8595810.4,
			reviewStatus: 'confirmed',
			dismissalReason: null,
			reviewedBy: {
				id: '99999999-9999-4999-8999-999999999991',
				fullName: 'Analista Oficial',
				registrationCode: 'MAT-1042',
			},
			reviewedAt: new Date('2026-11-26T10:00:00Z'),
		},
		{
			id: '33333333-3333-4333-8333-333333333332',
			featureSequence: 2,
			featureClass: 'degradation',
			geomGeoJson: {
				type: 'Polygon',
				coordinates: [
					[
						[-60.198, -12.698],
						[-60.196, -12.698],
						[-60.196, -12.696],
						[-60.198, -12.696],
						[-60.198, -12.698],
					],
				],
			},
			areaHa: 1.85,
			pixelCount: 185,
			meanNdviT0: 0.71,
			meanNdviT1: 0.52,
			meanDeltaNdvi: -0.19,
			centroidLat: -12.697,
			centroidLon: -60.197,
			centroidUtmE: 804350.1,
			centroidUtmN: 8595035.2,
			reviewStatus: 'dismissed_noise',
			dismissalReason: '=CMD|"sombra, sazonal" descartada pelo analista',
			reviewedBy: {
				id: '99999999-9999-4999-8999-999999999991',
				fullName: 'Analista Oficial',
				registrationCode: 'MAT-1042',
			},
			reviewedAt: new Date('2026-11-26T10:05:00Z'),
		},
		{
			id: '33333333-3333-4333-8333-333333333333',
			featureSequence: 3,
			featureClass: 'regrowth',
			geomGeoJson: {
				type: 'Polygon',
				coordinates: [
					[
						[-60.184, -12.684],
						[-60.182, -12.684],
						[-60.182, -12.682],
						[-60.184, -12.682],
						[-60.184, -12.684],
					],
				],
			},
			areaHa: 2.15,
			pixelCount: 215,
			meanNdviT0: 0.35,
			meanNdviT1: 0.68,
			meanDeltaNdvi: 0.33,
			centroidLat: -12.683,
			centroidLon: -60.183,
			centroidUtmE: 805890.0,
			centroidUtmN: 8596580.0,
			reviewStatus: 'auto_detected',
			dismissalReason: null,
			reviewedBy: null,
			reviewedAt: null,
		},
	];

	describe('1. Escape CSV/XML e Exportadores Tabular + GeoJSON + KML', () => {
		it('deve proteger células CSV contra formula injection e incluir todas as feições e centroides', () => {
			expect(escapeCsvTextCell(null)).toBe('');
			expect(escapeCsvTextCell('texto_limpo')).toBe('texto_limpo');
			expect(escapeCsvTextCell('=SUM(A1:A2)')).toBe('"\'=SUM(A1:A2)"');
			expect(escapeCsvTextCell('+1+1')).toBe('"\'+1+1"');
			expect(escapeCsvTextCell('a, "b"')).toBe('"a, ""b"""');
			expect(escapeXmlStrict(null)).toBe('');
			expect(escapeXmlStrict(`<a&b>'c"`)).toBe('&lt;a&amp;b&gt;&#39;c&quot;');

			const csv = buildFeaturesCsvBuffer(features, 31980).toString('utf8');
			const lines = csv.trimEnd().split('\n');
			expect(lines).toHaveLength(4); // Header + P1, P2, P3
			expect(lines[0]).toContain('sequencia,id,classe,status_revisao,motivo_descarte');
			expect(lines[1]).toContain('P1,');
			expect(lines[2]).toContain('dismissed_noise');
			// Formula injection neutralizada no motivo do descarte de P2
			expect(lines[2]).toContain('"\'=CMD|""sombra, sazonal"" descartada pelo analista"');
			expect(lines[3]).toContain('P3,');
			expect(lines[1]).toContain('31980');
		});

		it('deve gerar GeoJSON e KML válidos por classe filtrando dismissed_noise e preservando buracos', () => {
			const artifacts = buildAllVectorAndTabularArtifacts(ctx, features);
			expect(artifacts.map((a) => a.path)).toEqual([
				'02_relatorio_poligonos.csv',
				'03_vetores/aoi.geojson',
				'03_vetores/aoi.kml',
				'03_vetores/desmatamento.geojson',
				'03_vetores/desmatamento.kml',
				'03_vetores/degradacao.geojson',
				'03_vetores/degradacao.kml',
				'03_vetores/regeneracao.geojson',
				'03_vetores/regeneracao.kml',
			]);

			const aoiGeo = JSON.parse(buildAoiGeoJsonBuffer(ctx).toString('utf8'));
			expect(aoiGeo.type).toBe('FeatureCollection');
			expect(aoiGeo.features).toHaveLength(1);
			expect(aoiGeo.features[0].properties.protocolCode).toBe('CI-2026-000142');

			// Desmatamento mantém P1 (com anel interno preservado)
			const defGeo = JSON.parse(
				buildClassFeaturesGeoJsonBuffer(ctx, features, 'deforestation').toString('utf8'),
			);
			expect(defGeo.features).toHaveLength(1);
			expect(defGeo.features[0].properties.label).toBe('P1');
			expect(defGeo.features[0].geometry.coordinates).toHaveLength(2);

			// Degradação exclui P2 descartado como dismissed_noise
			const degGeo = JSON.parse(
				buildClassFeaturesGeoJsonBuffer(ctx, features, 'degradation').toString('utf8'),
			);
			expect(degGeo.features).toHaveLength(0);

			// KML preserva buracos (<innerBoundaryIs>) e escapa XML estritamente
			const aoiKml = buildAoiKmlBuffer(ctx).toString('utf8');
			expect(aoiKml).toContain('xmlns="http://www.opengis.net/kml/2.2"');
			expect(aoiKml).toContain('PROC-2026 &amp; &lt;Teste&gt;');
			expect(aoiKml).toContain('<outerBoundaryIs>');

			const defKml = buildClassFeaturesKmlBuffer(ctx, features, 'deforestation').toString('utf8');
			expect(defKml).toContain('<outerBoundaryIs>');
			expect(defKml).toContain('<innerBoundaryIs>');
			expect(defKml).toContain('P1');

			const degKml = buildClassFeaturesKmlBuffer(ctx, features, 'degradation').toString('utf8');
			expect(degKml).not.toContain('<Placemark');
		});
	});

	describe('2. Fingerprint Criptográfico, Manifesto de Auditoria e ZIP Determinístico', () => {
		it('deve computar fingerprint canônico sensível a alterações e empacotar ZIP bit-a-bit determinístico', async () => {
			const emittedAt = new Date('2026-11-26T19:00:00Z');
			const artifacts = buildAllVectorAndTabularArtifacts(ctx, features);
			const analyticalEntries = artifacts.map((a) => ({
				path: a.path,
				mimeType: a.mimeType,
				sizeBytes: a.buffer.byteLength,
				sha256: sha256Hex(a.buffer),
			}));

			const fpInput = {
				caseId: ctx.caseId,
				protocolCode: ctx.protocolCode,
				runId: ctx.runId,
				runVersion: 1,
				utmSrid: 31980,
				engineVersion: '1.0.0',
				presetName: 'TECHNICAL_STANDARD',
				isCustomParams: false,
				algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
				t0: {
					provider: 'aws_earth_search' as const,
					collection: 'sentinel-2-l2a',
					itemIds: ['S2B_T0_B', 'S2B_T0_A'],
					acquiredAt: ctx.t0AcquiredAt,
				},
				t1: {
					provider: 'aws_earth_search' as const,
					collection: 'sentinel-2-l2a',
					itemIds: ['S2A_T1'],
					acquiredAt: ctx.t1AcquiredAt,
				},
				features,
				analyticalFiles: analyticalEntries,
			};

			const fp1 = computeDatasetFingerprintSha256(fpInput);
			const fpReordered = computeDatasetFingerprintSha256({
				...fpInput,
				analyticalFiles: [...analyticalEntries].reverse(),
				t0: { ...fpInput.t0, itemIds: ['S2B_T0_A', 'S2B_T0_B'] },
			});
			expect(fp1).toMatch(/^[a-f0-9]{64}$/);
			expect(fp1).toBe(fpReordered);

			const fpMutated = computeDatasetFingerprintSha256({
				...fpInput,
				presetName: 'CONSERVATIVE',
			});
			expect(fpMutated).not.toBe(fp1);

			const fakePdf = Buffer.from('%PDF-1.4\nfake-pdf-content\n', 'utf8');
			const fakePdfSha = sha256Hex(fakePdf);

			const manifestArtifact = buildAuditManifestArtifact({
				generatedAt: emittedAt,
				issuer: {
					id: '99999999-9999-4999-8999-999999999991',
					fullName: 'Analista Oficial',
					registrationCode: 'MAT-1042',
				},
				caseInfo: {
					caseId: ctx.caseId,
					protocolCode: ctx.protocolCode,
					externalRef: ctx.externalRef,
					title: ctx.title,
					description: 'Descrição técnica',
					primaryMunicipalityIbge: '1100304',
					primaryMunicipalityName: 'Vilhena',
					stateUf: 'RO',
					intersectedMunicipalities: [],
					utmSrid: 31980,
					aoiAreaHa: 120.5,
					aoiPerimeterM: 4400.25,
				},
				runInfo: {
					runId: ctx.runId,
					version: 1,
					presetName: 'TECHNICAL_STANDARD',
					isCustomParams: false,
					algorithmParams: ANALYSIS_PRESETS.TECHNICAL_STANDARD,
					engineVersion: '1.0.0',
					seasonalityWarning: false,
					validAnalyzedHa: 120.5,
					cloudMaskedHa: 0,
					deforestationHa: 14.32,
					degradationHa: 0,
					regrowthHa: 2.15,
					stableHa: 104.03,
				},
				stacProvenance: {
					t0: {
						provider: 'aws_earth_search',
						collection: 'sentinel-2-l2a',
						itemIds: ['S2B_T0_A', 'S2B_T0_B'],
						acquiredAt: ctx.t0AcquiredAt.toISOString(),
						aoiCloudPct: 0.5,
						isMultiTile: true,
						processingBaseline: '05.11',
						boaOffsetApplied: true,
					},
					t1: {
						provider: 'aws_earth_search',
						collection: 'sentinel-2-l2a',
						itemIds: ['S2A_T1'],
						acquiredAt: ctx.t1AcquiredAt.toISOString(),
						aoiCloudPct: 0.2,
						isMultiTile: false,
						processingBaseline: '05.11',
						boaOffsetApplied: true,
					},
				},
				cartography: {
					paperFormat: 'A3',
					cartographicScale: 10000,
					dpi: 300,
					observations: 'Laudo válido.',
				},
				features,
				datasetFingerprintSha256: fp1,
				pdfSha256: fakePdfSha,
				packageFiles: [
					{
						path: '01_carta_imagem_comparativa.pdf',
						mimeType: 'application/pdf',
						sizeBytes: fakePdf.byteLength,
						sha256: fakePdfSha,
					},
					...analyticalEntries,
				],
			});

			expect(manifestArtifact.manifest.cryptographicCustody.files).toHaveLength(10);
			expect(manifestArtifact.manifest.curationHistory).toHaveLength(3);

			const rawEntries = [
				{ path: '01_carta_imagem_comparativa.pdf', buffer: fakePdf },
				...artifacts.map((a) => ({ path: a.path, buffer: a.buffer })),
				{ path: '05_manifesto_auditoria.json', buffer: manifestArtifact.buffer },
			];

			const zipA = await buildDeterministicZipBuffer(rawEntries, emittedAt);
			const zipB = await buildDeterministicZipBuffer([...rawEntries].reverse(), emittedAt);

			expect(zipA.zipSha256).toBe(zipB.zipSha256);
			expect(zipA.zipBuffer.equals(zipB.zipBuffer)).toBe(true);

			const unpacked = extractZipEntriesFromBuffer(zipA.zipBuffer);
			expect(unpacked.size).toBe(rawEntries.length);
			for (const entry of rawEntries) {
				const found = unpacked.get(entry.path);
				expect(found).toBeDefined();
				expect(found!.sha256).toBe(sha256Hex(entry.buffer));
				expect(found!.buffer.equals(entry.buffer)).toBe(true);
			}

			expect(() => extractZipEntriesFromBuffer(Buffer.from('short'))).toThrow();
			expect(() => extractZipEntriesFromBuffer(Buffer.alloc(64, 0))).toThrow();
		});
	});
});
