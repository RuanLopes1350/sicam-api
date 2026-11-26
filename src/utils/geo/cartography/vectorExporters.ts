import type { FeatureClass, ReviewStatus } from '../../../config/db/schema/enums.js';
import type { AoiPolygonGeoJson } from '../../validation/caseValidation.js';
import type { DetectedFeaturePolygonGeoJson } from '../../validation/runValidation.js';
import { formatDmsCoordinate } from './scaleAndLayout.js';

export interface ExportFeatureRecord {
	id: string;
	featureSequence: number;
	featureClass: FeatureClass;
	geomGeoJson: DetectedFeaturePolygonGeoJson;
	areaHa: number;
	pixelCount: number;
	meanNdviT0: number;
	meanNdviT1: number;
	meanDeltaNdvi: number;
	centroidLat: number;
	centroidLon: number;
	centroidUtmE: number;
	centroidUtmN: number;
	reviewStatus: ReviewStatus;
	dismissalReason: string | null;
	reviewedBy: { id: string; fullName: string; registrationCode: string } | null;
	reviewedAt: Date | null;
}

export interface GeneratedFileArtifact {
	path: string;
	mimeType: string;
	buffer: Buffer;
}

export interface VectorExportContext {
	caseId: string;
	protocolCode: string;
	externalRef: string | null;
	title: string;
	primaryMunicipalityName: string | null;
	stateUf: string | null;
	aoiAreaHa: number;
	aoiPerimeterM: number;
	utmSrid: number;
	aoiGeoJson: AoiPolygonGeoJson;
	runId: string;
	version: number;
	t0AcquiredAt: Date;
	t1AcquiredAt: Date;
	engineVersion: string;
	presetName: string;
}

interface FeatureClassExportMeta {
	slug: string;
	layerName: string;
	labelPt: string;
	kmlLineColor: string;
	kmlPolyColor: string;
}

const FEATURE_CLASS_EXPORT_META: Record<FeatureClass, FeatureClassExportMeta> = {
	deforestation: {
		slug: 'desmatamento',
		layerName: 'Desmatamento / Supressão Vegetal (Delta-NDVI)',
		labelPt: 'Desmatamento',
		kmlLineColor: 'ff1c1cb7',
		kmlPolyColor: '662f2fd3',
	},
	degradation: {
		slug: 'degradacao',
		layerName: 'Degradação / Perda Parcial (Delta-NDVI)',
		labelPt: 'Degradação',
		kmlLineColor: 'ff0051e6',
		kmlPolyColor: '66007cf5',
	},
	regrowth: {
		slug: 'regeneracao',
		layerName: 'Regeneração Florestal (Delta-NDVI)',
		labelPt: 'Regeneração',
		kmlLineColor: 'ff76e600',
		kmlPolyColor: '6653c800',
	},
};

const EXPORT_CLASSES_ORDER: readonly FeatureClass[] = [
	'deforestation',
	'degradation',
	'regrowth',
];

const FORMULA_INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

const XML_ESCAPE_MAP: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

export function escapeXmlStrict(value: string | number | null | undefined): string {
	if (value === null || value === undefined) {
		return '';
	}
	return String(value).replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch] ?? ch);
}

// Proteção contra CSV Formula Injection (OWASP) e quoting padrão RFC 4180
export function escapeCsvTextCell(value: string | null | undefined): string {
	if (value === null || value === undefined || value.length === 0) {
		return '';
	}
	const trimmedLead = value.trimStart();
	const needsGuard =
		trimmedLead.length > 0 && FORMULA_INJECTION_PREFIXES.has(trimmedLead[0]!);
	const safe = needsGuard ? `'${value}` : value;

	if (
		safe.includes(',') ||
		safe.includes('"') ||
		safe.includes('\n') ||
		safe.includes('\r') ||
		safe.includes("'")
	) {
		return `"${safe.replaceAll('"', '""')}"`;
	}
	return safe;
}

// RF-27: Relatório CSV de todos os polígonos detectados (incluindo descartados para auditoria)
export function buildFeaturesCsvBuffer(
	features: readonly ExportFeatureRecord[],
	utmSrid: number,
): Buffer {
	const header = [
		'sequencia',
		'id',
		'classe',
		'status_revisao',
		'motivo_descarte',
		'revisado_por',
		'revisado_em_utc',
		'area_ha',
		'contagem_pixels',
		'ndvi_medio_t0',
		'ndvi_medio_t1',
		'delta_ndvi_medio',
		'centroide_lat',
		'centroide_lon',
		'centroide_gms',
		'centroide_utm_e',
		'centroide_utm_n',
		'srid_utm',
	].join(',');

	const sorted = [...features].sort((a, b) => a.featureSequence - b.featureSequence);
	const lines: string[] = [header];

	for (const f of sorted) {
		const reviewerLabel = f.reviewedBy
			? `${f.reviewedBy.fullName} (${f.reviewedBy.registrationCode})`
			: '';
		const reviewedAtIso = f.reviewedAt ? f.reviewedAt.toISOString() : '';
		const centroidDms = `${formatDmsCoordinate(f.centroidLat, 'lat')} ${formatDmsCoordinate(f.centroidLon, 'lon')}`;

		const row = [
			escapeCsvTextCell(`P${f.featureSequence}`),
			escapeCsvTextCell(f.id),
			escapeCsvTextCell(f.featureClass),
			escapeCsvTextCell(f.reviewStatus),
			escapeCsvTextCell(f.dismissalReason),
			escapeCsvTextCell(reviewerLabel),
			escapeCsvTextCell(reviewedAtIso),
			f.areaHa.toFixed(4),
			String(f.pixelCount),
			f.meanNdviT0.toFixed(4),
			f.meanNdviT1.toFixed(4),
			f.meanDeltaNdvi.toFixed(4),
			f.centroidLat.toFixed(7),
			f.centroidLon.toFixed(7),
			escapeCsvTextCell(centroidDms),
			f.centroidUtmE.toFixed(2),
			f.centroidUtmN.toFixed(2),
			String(utmSrid),
		].join(',');

		lines.push(row);
	}

	return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

// RF-26: GeoJSON padronizado em SIRGAS 2000 (EPSG:4674) para a AOI
export function buildAoiGeoJsonBuffer(ctx: VectorExportContext): Buffer {
	const collection = {
		type: 'FeatureCollection',
		name: `${ctx.protocolCode}_AOI`,
		metadata: {
			crs: 'EPSG:4674',
			utmSrid: `EPSG:${ctx.utmSrid}`,
			protocolCode: ctx.protocolCode,
			runVersion: ctx.version,
			engineVersion: ctx.engineVersion,
		},
		features: [
			{
				type: 'Feature',
				id: ctx.caseId,
				geometry: ctx.aoiGeoJson,
				properties: {
					caseId: ctx.caseId,
					protocolCode: ctx.protocolCode,
					externalRef: ctx.externalRef,
					title: ctx.title,
					municipality: ctx.primaryMunicipalityName,
					stateUf: ctx.stateUf,
					areaHa: Number(ctx.aoiAreaHa.toFixed(4)),
					perimeterM: Number(ctx.aoiPerimeterM.toFixed(2)),
					utmSrid: ctx.utmSrid,
					runId: ctx.runId,
					runVersion: ctx.version,
				},
			},
		],
	};

	return Buffer.from(`${JSON.stringify(collection, null, 2)}\n`, 'utf8');
}

// RF-26: GeoJSON por classe temática (exclui falsos positivos descartados)
export function buildClassFeaturesGeoJsonBuffer(
	ctx: VectorExportContext,
	features: readonly ExportFeatureRecord[],
	targetClass: FeatureClass,
): Buffer {
	const meta = FEATURE_CLASS_EXPORT_META[targetClass];
	const activeClassFeatures = features
		.filter((f) => f.featureClass === targetClass && f.reviewStatus !== 'dismissed_noise')
		.sort((a, b) => a.featureSequence - b.featureSequence);

	const collection = {
		type: 'FeatureCollection',
		name: `${ctx.protocolCode}_${meta.slug}_v${ctx.version}`,
		metadata: {
			crs: 'EPSG:4674',
			utmSrid: `EPSG:${ctx.utmSrid}`,
			protocolCode: ctx.protocolCode,
			runId: ctx.runId,
			runVersion: ctx.version,
			featureClass: targetClass,
			presetName: ctx.presetName,
			engineVersion: ctx.engineVersion,
		},
		features: activeClassFeatures.map((f) => ({
			type: 'Feature',
			id: f.id,
			geometry: f.geomGeoJson,
			properties: {
				id: f.id,
				featureSequence: f.featureSequence,
				label: `P${f.featureSequence}`,
				featureClass: f.featureClass,
				featureClassLabel: meta.labelPt,
				reviewStatus: f.reviewStatus,
				areaHa: Number(f.areaHa.toFixed(4)),
				pixelCount: f.pixelCount,
				meanNdviT0: Number(f.meanNdviT0.toFixed(4)),
				meanNdviT1: Number(f.meanNdviT1.toFixed(4)),
				meanDeltaNdvi: Number(f.meanDeltaNdvi.toFixed(4)),
				centroidLat: Number(f.centroidLat.toFixed(7)),
				centroidLon: Number(f.centroidLon.toFixed(7)),
				centroidUtmE: Number(f.centroidUtmE.toFixed(2)),
				centroidUtmN: Number(f.centroidUtmN.toFixed(2)),
				utmSrid: ctx.utmSrid,
				protocolCode: ctx.protocolCode,
				runVersion: ctx.version,
				t0AcquiredAt: ctx.t0AcquiredAt.toISOString(),
				t1AcquiredAt: ctx.t1AcquiredAt.toISOString(),
			},
		})),
	};

	return Buffer.from(`${JSON.stringify(collection, null, 2)}\n`, 'utf8');
}

function formatKmlRingCoordinates(ring: readonly (readonly [number, number])[]): string {
	return ring.map(([lon, lat]) => `${lon},${lat},0`).join(' ');
}

// Preserva anel externo (<outerBoundaryIs>) e buracos internos (<innerBoundaryIs>) em OGC KML 2.2
function renderKmlPolygonXml(coordinates: readonly (readonly (readonly [number, number])[])[]): string {
	const outerRing = coordinates[0] ?? [];
	const outerXml = `<outerBoundaryIs><LinearRing><coordinates>${formatKmlRingCoordinates(outerRing)}</coordinates></LinearRing></outerBoundaryIs>`;
	const innerXml = coordinates
		.slice(1)
		.map(
			(ring) =>
				`<innerBoundaryIs><LinearRing><coordinates>${formatKmlRingCoordinates(ring)}</coordinates></LinearRing></innerBoundaryIs>`,
		)
		.join('');

	return `<Polygon><tessellate>1</tessellate>${outerXml}${innerXml}</Polygon>`;
}

function renderKmlExtendedData(entries: ReadonlyArray<readonly [string, string | number | null]>): string {
	const dataXml = entries
		.map(
			([key, val]) =>
				`      <Data name="${escapeXmlStrict(key)}"><value>${escapeXmlStrict(val ?? '')}</value></Data>`,
		)
		.join('\n');
	return `    <ExtendedData>\n${dataXml}\n    </ExtendedData>`;
}

function wrapKmlDocument(params: {
	documentName: string;
	styleId: string;
	lineColor: string;
	lineWidth: string;
	polyColor: string;
	polyFill: '0' | '1';
	placemarksXml: string;
}): Buffer {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXmlStrict(params.documentName)}</name>
    <Style id="${escapeXmlStrict(params.styleId)}">
      <LineStyle>
        <color>${params.lineColor}</color>
        <width>${params.lineWidth}</width>
      </LineStyle>
      <PolyStyle>
        <color>${params.polyColor}</color>
        <fill>${params.polyFill}</fill>
        <outline>1</outline>
      </PolyStyle>
    </Style>
${params.placemarksXml}
  </Document>
</kml>
`;
	return Buffer.from(xml, 'utf8');
}

// RF-26: KML 2.2 da Área de Interesse (AOI)
export function buildAoiKmlBuffer(ctx: VectorExportContext): Buffer {
	const extendedData = renderKmlExtendedData([
		['protocolo', ctx.protocolCode],
		['referencia_externa', ctx.externalRef],
		['municipio', ctx.primaryMunicipalityName],
		['uf', ctx.stateUf],
		['area_ha', ctx.aoiAreaHa.toFixed(4)],
		['perimetro_m', ctx.aoiPerimeterM.toFixed(2)],
		['srid_utm', ctx.utmSrid],
		['versao_execucao', ctx.version],
	]);

	const placemark = `    <Placemark id="${escapeXmlStrict(ctx.caseId)}">
      <name>${escapeXmlStrict(`${ctx.protocolCode} — Perímetro AOI`)}</name>
      <styleUrl>#sicam_aoi</styleUrl>
${extendedData}
      ${renderKmlPolygonXml(ctx.aoiGeoJson.coordinates)}
    </Placemark>`;

	return wrapKmlDocument({
		documentName: `${ctx.protocolCode} — Área de Interesse (AOI)`,
		styleId: 'sicam_aoi',
		lineColor: 'ff00d6ff',
		lineWidth: '2.5',
		polyColor: '00000000',
		polyFill: '0',
		placemarksXml: placemark,
	});
}

// RF-26: KML 2.2 por classe temática (exclui falsos positivos descartados)
export function buildClassFeaturesKmlBuffer(
	ctx: VectorExportContext,
	features: readonly ExportFeatureRecord[],
	targetClass: FeatureClass,
): Buffer {
	const meta = FEATURE_CLASS_EXPORT_META[targetClass];
	const activeClassFeatures = features
		.filter((f) => f.featureClass === targetClass && f.reviewStatus !== 'dismissed_noise')
		.sort((a, b) => a.featureSequence - b.featureSequence);

	const placemarksXml = activeClassFeatures
		.map((f) => {
			const extendedData = renderKmlExtendedData([
				['sequencia', `P${f.featureSequence}`],
				['id', f.id],
				['classe', meta.labelPt],
				['status_revisao', f.reviewStatus],
				['area_ha', f.areaHa.toFixed(4)],
				['contagem_pixels', f.pixelCount],
				['ndvi_medio_t0', f.meanNdviT0.toFixed(4)],
				['ndvi_medio_t1', f.meanNdviT1.toFixed(4)],
				['delta_ndvi_medio', f.meanDeltaNdvi.toFixed(4)],
				['centroide_utm_e', f.centroidUtmE.toFixed(2)],
				['centroide_utm_n', f.centroidUtmN.toFixed(2)],
				['srid_utm', ctx.utmSrid],
				['protocolo', ctx.protocolCode],
			]);

			return `    <Placemark id="${escapeXmlStrict(f.id)}">
      <name>${escapeXmlStrict(`P${f.featureSequence} (${meta.labelPt} — ${f.areaHa.toFixed(2)} ha)`)}</name>
      <styleUrl>#sicam_${meta.slug}</styleUrl>
${extendedData}
      ${renderKmlPolygonXml(f.geomGeoJson.coordinates)}
    </Placemark>`;
		})
		.join('\n');

	return wrapKmlDocument({
		documentName: `${ctx.protocolCode} v${ctx.version} — ${meta.layerName}`,
		styleId: `sicam_${meta.slug}`,
		lineColor: meta.kmlLineColor,
		lineWidth: '2.0',
		polyColor: meta.kmlPolyColor,
		polyFill: '1',
		placemarksXml,
	});
}

// Gera todos os artefatos tabulares (CSV) e vetoriais (GeoJSON + KML) do Pacote Técnico
export function buildAllVectorAndTabularArtifacts(
	ctx: VectorExportContext,
	allFeatures: readonly ExportFeatureRecord[],
): GeneratedFileArtifact[] {
	const artifacts: GeneratedFileArtifact[] = [
		{
			path: '02_relatorio_poligonos.csv',
			mimeType: 'text/csv; charset=utf-8',
			buffer: buildFeaturesCsvBuffer(allFeatures, ctx.utmSrid),
		},
		{
			path: '03_vetores/aoi.geojson',
			mimeType: 'application/geo+json; charset=utf-8',
			buffer: buildAoiGeoJsonBuffer(ctx),
		},
		{
			path: '03_vetores/aoi.kml',
			mimeType: 'application/vnd.google-earth.kml+xml; charset=utf-8',
			buffer: buildAoiKmlBuffer(ctx),
		},
	];

	for (const featureClass of EXPORT_CLASSES_ORDER) {
		const meta = FEATURE_CLASS_EXPORT_META[featureClass];
		artifacts.push(
			{
				path: `03_vetores/${meta.slug}.geojson`,
				mimeType: 'application/geo+json; charset=utf-8',
				buffer: buildClassFeaturesGeoJsonBuffer(ctx, allFeatures, featureClass),
			},
			{
				path: `03_vetores/${meta.slug}.kml`,
				mimeType: 'application/vnd.google-earth.kml+xml; charset=utf-8',
				buffer: buildClassFeaturesKmlBuffer(ctx, allFeatures, featureClass),
			},
		);
	}

	return artifacts;
}
