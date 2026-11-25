import { customType } from 'drizzle-orm/pg-core';

// Colunas PostGIS em SIRGAS 2000 (EPSG:4674) — ADR-04
export const geometryPolygon4674 = customType<{ data: string; driverData: string }>({
	dataType() {
		return 'geometry(Polygon, 4674)';
	},
});

export const geometryMultiPolygon4674 = customType<{ data: string; driverData: string }>({
	dataType() {
		return 'geometry(MultiPolygon, 4674)';
	},
});

export const inetType = customType<{ data: string; driverData: string }>({
	dataType() {
		return 'inet';
	},
});
