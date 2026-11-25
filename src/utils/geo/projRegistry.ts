import proj4 from 'proj4';

let initialized = false;

// Projeção cônica equivalente de Albers oficial do INPE Brazil Data Cube (BDC_MD / EPSG:102033)
export const INPE_BDC_ALBERS_CODE = 'EPSG:102033';
const INPE_BDC_ALBERS_PROJ4 =
	'+proj=aea +lat_0=-12 +lon_0=-54 +lat_1=-2 +lat_2=-22 +x_0=5000000 +y_0=10000000 +ellps=GRS80 +units=m +no_defs';

export function ensureProjDefinitions(): void {
	if (initialized) return;

	// SIRGAS 2000 Geográfico (EPSG:4674)
	proj4.defs('EPSG:4674', '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs');

	// SIRGAS 2000 UTM Norte (zonas 11N..22N -> EPSG:31965..31976)
	for (let zone = 11; zone <= 22; zone++) {
		const srid = 31954 + zone;
		proj4.defs(
			`EPSG:${srid}`,
			`+proj=utm +zone=${zone} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`,
		);
	}

	// SIRGAS 2000 UTM Sul (zonas 17S..25S -> EPSG:31977..31985)
	for (let zone = 17; zone <= 25; zone++) {
		const srid = 31960 + zone;
		proj4.defs(
			`EPSG:${srid}`,
			`+proj=utm +zone=${zone} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`,
		);
	}

	// WGS 84 UTM Norte (EPSG:32601..32660) e Sul (EPSG:32701..32760) — cenas Sentinel-2 AWS
	for (let zone = 1; zone <= 60; zone++) {
		const pad = String(zone).padStart(2, '0');
		proj4.defs(`EPSG:326${pad}`, `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`);
		proj4.defs(`EPSG:327${pad}`, `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`);
	}

	// Albers Equal Area do INPE Brazil Data Cube
	proj4.defs(INPE_BDC_ALBERS_CODE, INPE_BDC_ALBERS_PROJ4);

	initialized = true;
}

export function projectCoords(
	fromCrs: string,
	toCrs: string,
	x: number,
	y: number,
): [number, number] {
	ensureProjDefinitions();
	if (fromCrs === toCrs) {
		return [x, y];
	}
	const out = proj4(fromCrs, toCrs, [x, y]);
	return [out[0]!, out[1]!];
}

// Spec Seção 2.3 (Caso Rápido): SIRGAS 2000 UTM e WGS84 UTM no mesmo fuso e hemisfério diferem < 10 cm
export function isEquivalentUtmZone(sirgasUtmSrid: number, tileCrs: string): boolean {
	if (`EPSG:${sirgasUtmSrid}` === tileCrs) return true;
	const m = /^EPSG:(326|327)(\d{2})$/.exec(tileCrs);
	if (!m) return false;

	const hemiPrefix = m[1];
	const wgsZone = Number(m[2]);

	if (sirgasUtmSrid >= 31977 && sirgasUtmSrid <= 31985) {
		const sirgasZoneSouth = sirgasUtmSrid - 31960;
		return hemiPrefix === '327' && wgsZone === sirgasZoneSouth;
	}

	if (sirgasUtmSrid >= 31965 && sirgasUtmSrid <= 31976) {
		const sirgasZoneNorth = sirgasUtmSrid - 31954;
		return hemiPrefix === '326' && wgsZone === sirgasZoneNorth;
	}

	return false;
}
