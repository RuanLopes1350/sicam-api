export type GeoJsonPolygonOrMulti =
	| { type: 'Polygon'; coordinates: [number, number][][] }
	| { type: 'MultiPolygon'; coordinates: [number, number][][][] };

export interface InsetMunicipalityShape {
	ibgeCode: string;
	name: string;
	geom: GeoJsonPolygonOrMulti;
}

export interface IbgeInsetInput {
	widthMm: number;
	heightMm: number;
	stateUf: string | null;
	stateName: string | null;
	stateGeom: GeoJsonPolygonOrMulti | null;
	municipalities: ReadonlyArray<InsetMunicipalityShape>;
	primaryMunicipalityIbge: string | null;
	primaryMunicipalityName: string | null;
	aoiCenterLonLat: [number, number];
}

function escapeXml(val: string): string {
	return val
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function extractPolygonRings(geom: GeoJsonPolygonOrMulti): [number, number][][][] {
	if (geom.type === 'Polygon') {
		return [geom.coordinates];
	}
	return geom.coordinates;
}

function extendBoundsFromGeom(
	geom: GeoJsonPolygonOrMulti,
	bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number },
): void {
	for (const poly of extractPolygonRings(geom)) {
		for (const ring of poly) {
			for (const [lon, lat] of ring) {
				if (lon < bounds.minLon) bounds.minLon = lon;
				if (lat < bounds.minLat) bounds.minLat = lat;
				if (lon > bounds.maxLon) bounds.maxLon = lon;
				if (lat > bounds.maxLat) bounds.maxLat = lat;
			}
		}
	}
}

// Spec Parte II — Seção 5.2: Encarte vetorial dinâmico IBGE em SVG com correção cos(φ_média)
export function renderIbgeInsetMapSvg(input: IbgeInsetInput): string {
	const {
		widthMm,
		heightMm,
		stateUf,
		stateName,
		stateGeom,
		municipalities,
		primaryMunicipalityIbge,
		primaryMunicipalityName,
		aoiCenterLonLat,
	} = input;

	const bounds = {
		minLon: Number.POSITIVE_INFINITY,
		minLat: Number.POSITIVE_INFINITY,
		maxLon: Number.NEGATIVE_INFINITY,
		maxLat: Number.NEGATIVE_INFINITY,
	};

	if (stateGeom) {
		extendBoundsFromGeom(stateGeom, bounds);
	}
	for (const mun of municipalities) {
		extendBoundsFromGeom(mun.geom, bounds);
	}

	if (!Number.isFinite(bounds.minLon)) {
		const [cLon, cLat] = aoiCenterLonLat;
		bounds.minLon = cLon - 1.5;
		bounds.maxLon = cLon + 1.5;
		bounds.minLat = cLat - 1.5;
		bounds.maxLat = cLat + 1.5;
	}

	const meanLatRad = (((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180;
	const cosLat = Math.max(0.25, Math.cos(meanLatRad));

	const rawSpanX = Math.max(0.05, (bounds.maxLon - bounds.minLon) * cosLat);
	const rawSpanY = Math.max(0.05, bounds.maxLat - bounds.minLat);

	const padX = 3.0;
	const padTop = 6.0;
	const padBottom = 3.0;
	const drawW = Math.max(10, widthMm - padX * 2);
	const drawH = Math.max(10, heightMm - padTop - padBottom);

	const scale = Math.min(drawW / rawSpanX, drawH / rawSpanY);
	const contentW = rawSpanX * scale;
	const contentH = rawSpanY * scale;
	const offsetX = padX + (drawW - contentW) / 2;
	const offsetY = padTop + (drawH - contentH) / 2;

	const projectLonLat = (lon: number, lat: number): [number, number] => {
		const x = offsetX + (lon - bounds.minLon) * cosLat * scale;
		const y = offsetY + (bounds.maxLat - lat) * scale;
		return [x, y];
	};

	const geomToSvgPath = (geom: GeoJsonPolygonOrMulti): string => {
		const subPaths: string[] = [];
		for (const poly of extractPolygonRings(geom)) {
			for (const ring of poly) {
				if (ring.length < 3) continue;
				const cmds: string[] = [];
				for (let i = 0; i < ring.length; i++) {
					const [lon, lat] = ring[i]!;
					const [x, y] = projectLonLat(lon, lat);
					cmds.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
				}
				cmds.push('Z');
				subPaths.push(cmds.join(' '));
			}
		}
		return subPaths.join(' ');
	};

	const otherMunicipalitiesPaths: string[] = [];
	const primaryMunicipalitiesPaths: string[] = [];

	for (const mun of municipalities) {
		const d = geomToSvgPath(mun.geom);
		if (!d) continue;
		if (primaryMunicipalityIbge && mun.ibgeCode.trim() === primaryMunicipalityIbge.trim()) {
			primaryMunicipalitiesPaths.push(
				`<path d="${d}" fill="#CBD5E1" fill-rule="evenodd" stroke="#334155" stroke-width="0.35" stroke-linejoin="round" />`,
			);
		} else {
			otherMunicipalitiesPaths.push(
				`<path d="${d}" fill="#E2E8F0" fill-rule="evenodd" stroke="#94A3B8" stroke-width="0.15" stroke-linejoin="round" />`,
			);
		}
	}

	const stateOutlinePath = stateGeom ? geomToSvgPath(stateGeom) : '';
	const stateSvg = stateOutlinePath
		? `<path d="${stateOutlinePath}" fill="${municipalities.length === 0 ? '#E2E8F0' : 'none'}" fill-rule="evenodd" stroke="#475569" stroke-width="0.30" stroke-linejoin="round" />`
		: '';

	const [aoiX, aoiY] = projectLonLat(aoiCenterLonLat[0], aoiCenterLonLat[1]);
	const markerSize = 2.6;
	const aoiMarkerSvg = `
    <circle cx="${aoiX.toFixed(2)}" cy="${aoiY.toFixed(2)}" r="3.2" fill="none" stroke="#DC2626" stroke-width="0.28" stroke-opacity="0.7" />
    <rect x="${(aoiX - markerSize / 2).toFixed(2)}" y="${(aoiY - markerSize / 2).toFixed(2)}" width="${markerSize}" height="${markerSize}" fill="#DC2626" stroke="#FFFFFF" stroke-width="0.30" />
  `;

	const titleLine = stateName
		? `${escapeXml(stateName)}${stateUf ? ` (${escapeXml(stateUf)})` : ''}`
		: stateUf
			? `UF: ${escapeXml(stateUf)}`
			: 'Brasil / SIRGAS 2000';
	const munSubtitle = primaryMunicipalityName
		? `Município: ${escapeXml(primaryMunicipalityName)}`
		: 'Localização da AOI';

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthMm} ${heightMm}" width="${widthMm}mm" height="${heightMm}mm" style="display:block;font-family:'Liberation Sans','DejaVu Sans',sans-serif;">
    <rect x="0" y="0" width="${widthMm}" height="${heightMm}" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="0.20" />
    ${stateSvg}
    ${otherMunicipalitiesPaths.join('\n')}
    ${primaryMunicipalitiesPaths.join('\n')}
    ${aoiMarkerSvg}
    <text x="2.0" y="2.8" font-size="1.95" font-weight="700" fill="#0F172A">${titleLine}</text>
    <text x="2.0" y="4.9" font-size="1.65" font-weight="500" fill="#475569">${munSubtitle}</text>
  </svg>`;
}
