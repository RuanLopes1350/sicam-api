import { logger } from '../config/loggerConfig.js';
import territoryRepository from '../repository/territoryRepository.js';
import { MunicipalitiesQuerySchema } from '../utils/validation/territoryValidation.js';

interface IbgeStateApiInfo {
	id: number;
	sigla: string;
	nome: string;
}

interface IbgeMunicipalityApiInfo {
	id: number;
	nome: string;
}

interface GeoJsonFeature {
	type: 'Feature';
	properties?: Record<string, unknown>;
	geometry: {
		type: string;
		coordinates: unknown;
	};
}

interface GeoJsonFeatureCollection {
	type: 'FeatureCollection';
	features: GeoJsonFeature[];
}

async function fetchJsonWithRetry<T>(url: string, retries = 3): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(30_000),
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ao consultar ${url}`);
			}
			return (await res.json()) as T;
		} catch (err) {
			lastErr = err;
			if (attempt < retries) {
				await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
			}
		}
	}
	throw lastErr;
}

class TerritoryService {
	async listStates() {
		const rows = await territoryRepository.findAllStates();
		return {
			items: rows.map((r) => ({
				ufCode: r.ufCode,
				ibgeStateId: r.ibgeStateId,
				name: r.name,
				datasetVersion: r.datasetVersion,
				importedAt: r.importedAt.toISOString(),
			})),
		};
	}

	async searchMunicipalities(rawQuery: unknown) {
		const { uf, q, limit } = MunicipalitiesQuerySchema.parse(rawQuery);
		const rows = await territoryRepository.searchMunicipalities({ uf, q, limit });

		return {
			items: rows.map((r) => ({
				ibgeCode: r.ibgeCode,
				name: r.name,
				ufCode: r.ufCode,
				centroid: {
					lat: Number(r.centroidLat.toFixed(6)),
					lon: Number(r.centroidLon.toFixed(6)),
				},
				bbox: [
					Number(r.minLon.toFixed(6)),
					Number(r.minLat.toFixed(6)),
					Number(r.maxLon.toFixed(6)),
					Number(r.maxLat.toFixed(6)),
				] as [number, number, number, number],
			})),
		};
	}

	// ADR-11 & Modelagem Física Seção 8.4: Carga idempotente da malha oficial IBGE por UF (ex: --uf=RO)
	async importIbgeStateFromApi(ufRaw: string): Promise<{
		ufCode: string;
		municipalitiesImported: number;
	}> {
		const uf = ufRaw.trim().toUpperCase();
		if (!/^[A-Z]{2}$/.test(uf)) {
			throw new Error(`Código UF inválido: '${ufRaw}'. Informe duas letras (ex: --uf=RO).`);
		}

		logger.info({ uf }, 'Consultando metadados e malhas oficiais no IBGE...');

		const stateInfo = await fetchJsonWithRetry<IbgeStateApiInfo>(
			`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}`,
		);

		const [stateGeoJson, munList, munGeoJson] = await Promise.all([
			fetchJsonWithRetry<GeoJsonFeatureCollection>(
				`https://servicodados.ibge.gov.br/api/v3/malhas/estados/${stateInfo.id}?formato=application/vnd.geo+json&qualidade=maxima`,
			),
			fetchJsonWithRetry<IbgeMunicipalityApiInfo[]>(
				`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${stateInfo.id}/municipios`,
			),
			fetchJsonWithRetry<GeoJsonFeatureCollection>(
				`https://servicodados.ibge.gov.br/api/v3/malhas/estados/${stateInfo.id}?intrarregiao=municipio&formato=application/vnd.geo+json&qualidade=maxima`,
			),
		]);

		const stateFeature = stateGeoJson.features[0];
		if (!stateFeature?.geometry) {
			throw new Error(`Malha estadual vazia retornada pelo IBGE para ${uf}.`);
		}

		const munNameByCode = new Map<string, string>();
		for (const m of munList) {
			munNameByCode.set(String(m.id).padStart(7, '0'), m.nome);
		}

		const municipalities: Array<{ ibgeCode: string; name: string; geometryJson: string }> = [];
		for (const feat of munGeoJson.features) {
			const codareaRaw =
				feat.properties?.codarea ?? feat.properties?.CD_MUN ?? feat.properties?.id;
			const ibgeCode = String(codareaRaw ?? '').padStart(7, '0');
			if (!/^[0-9]{7}$/.test(ibgeCode) || !feat.geometry) {
				continue;
			}
			municipalities.push({
				ibgeCode,
				name: munNameByCode.get(ibgeCode) ?? `Município ${ibgeCode}`,
				geometryJson: JSON.stringify(feat.geometry),
			});
		}

		const datasetVersion = `IBGE_MALHAS_V3_${uf}`;
		const importedCount = await territoryRepository.upsertStateAndMunicipalities({
			uf,
			ibgeStateId: stateInfo.id,
			stateName: stateInfo.nome,
			stateGeometryJson: JSON.stringify(stateFeature.geometry),
			datasetVersion,
			municipalities,
		});

		logger.info(
			{ uf, municipalitiesImported: importedCount, datasetVersion },
			'Malha oficial IBGE importada com sucesso no PostGIS.',
		);

		return { ufCode: uf, municipalitiesImported: importedCount };
	}
}

export default new TerritoryService();
