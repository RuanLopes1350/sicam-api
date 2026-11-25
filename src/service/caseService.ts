import { withTransaction } from '../config/dbConfig.js';
import type { IntersectedMunicipalityInfo } from '../config/db/schema/cases.js';
import { env } from '../config/env.js';
import caseRepository from '../repository/caseRepository.js';
import { DomainError } from '../utils/helpers/domainError.js';
import type { AuthenticatedUser, RequestClientContext } from '../utils/helpers/requestGuard.js';
import { sanitizePlainText } from '../utils/helpers/sanitizer.js';
import {
	type AoiPolygonGeoJson,
	CaseIdParamsSchema,
	CreateCaseBodySchema,
	ListCasesQuerySchema,
	UpdateCaseBodySchema,
} from '../utils/validation/caseValidation.js';
import auditService from './auditService.js';

// Bounding box de sanidade do território nacional brasileiro (incluindo ilhas oceânicas e extremos)
const BRAZIL_BOUNDS = {
	minLon: -74.5,
	maxLon: -28.0,
	minLat: -34.0,
	maxLat: 5.5,
} as const;

function validateAoiPolygonStructure(aoi: AoiPolygonGeoJson): void {
	// 1. Proíbe polígonos vazios ou com anéis internos (buracos) — OpenAPI Seção 3 (Módulo 4)
	if (aoi.coordinates.length !== 1) {
		throw new DomainError(
			'ERR_INVALID_GEOMETRY',
			aoi.coordinates.length === 0
				? 'O polígono da AOI não possui anel de coordenadas.'
				: 'Polígonos com buracos (anéis internos) não são permitidos na AOI.',
			{
				invalidParams: [
					{
						field: 'aoiGeoJson.coordinates',
						reason: aoi.coordinates.length === 0 ? 'EMPTY_RINGS' : 'HOLES_NOT_ALLOWED',
						meta: { ringsCount: aoi.coordinates.length },
					},
				],
			},
		);
	}

	const ring = aoi.coordinates[0]!;
	if (ring.length < 4) {
		throw new DomainError(
			'ERR_INVALID_GEOMETRY',
			'O anel do polígono deve possuir ao menos 3 vértices distintos (4 pares com o fechamento).',
			{
				invalidParams: [
					{
						field: 'aoiGeoJson.coordinates[0]',
						reason: 'TOO_FEW_VERTICES',
						meta: { pointsCount: ring.length },
					},
				],
			},
		);
	}

	const first = ring[0]!;
	const last = ring[ring.length - 1]!;
	if (first[0] !== last[0] || first[1] !== last[1]) {
		throw new DomainError(
			'ERR_INVALID_GEOMETRY',
			'O anel exterior do polígono GeoJSON deve ser fechado (primeiro e último vértices idênticos).',
			{
				invalidParams: [
					{
						field: 'aoiGeoJson.coordinates[0]',
						reason: 'RING_NOT_CLOSED',
					},
				],
			},
		);
	}

	const distinctVertices = ring.length - 1;
	if (distinctVertices > env.MAX_AOI_VERTICES) {
		throw new DomainError(
			'ERR_INVALID_GEOMETRY',
			`O polígono possui ${distinctVertices} vértices, excedendo o limite operacional de ${env.MAX_AOI_VERTICES} vértices.`,
			{
				invalidParams: [
					{
						field: 'aoiGeoJson.coordinates[0]',
						reason: 'MAX_VERTICES_EXCEEDED',
						meta: {
							vertices: distinctVertices,
							maxAllowedVertices: env.MAX_AOI_VERTICES,
						},
					},
				],
			},
		);
	}

	for (let i = 0; i < ring.length; i++) {
		const [lon, lat] = ring[i]!;
		if (
			lon < BRAZIL_BOUNDS.minLon ||
			lon > BRAZIL_BOUNDS.maxLon ||
			lat < BRAZIL_BOUNDS.minLat ||
			lat > BRAZIL_BOUNDS.maxLat
		) {
			throw new DomainError(
				'ERR_INVALID_GEOMETRY',
				'As coordenadas da AOI estão fora dos limites geográficos do território brasileiro (SIRGAS 2000).',
				{
					invalidParams: [
						{
							field: `aoiGeoJson.coordinates[0][${i}]`,
							reason: 'OUTSIDE_BRAZIL_BOUNDS',
							meta: { lon, lat },
						},
					],
				},
			);
		}
	}
}

function parseBboxParam(rawBbox: string): [number, number, number, number] {
	const parts = rawBbox.split(',').map((p) => Number(p.trim()));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			'O parâmetro bbox deve seguir o formato numérico minLon,minLat,maxLon,maxLat.',
			{
				invalidParams: [{ field: 'bbox', reason: 'INVALID_BBOX_FORMAT' }],
			},
		);
	}

	const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
	if (
		minLon < -180 ||
		maxLon > 180 ||
		minLon >= maxLon ||
		minLat < -90 ||
		maxLat > 90 ||
		minLat >= maxLat
	) {
		throw new DomainError(
			'ERR_VALIDATION_FAILED',
			'Limites de bbox inválidos: garanta minLon < maxLon em [-180, 180] e minLat < maxLat em [-90, 90].',
			{
				invalidParams: [
					{
						field: 'bbox',
						reason: 'INVALID_BBOX_BOUNDS',
						meta: { minLon, minLat, maxLon, maxLat },
					},
				],
			},
		);
	}

	return [minLon, minLat, maxLon, maxLat];
}

function formatCaseRecord(params: {
	id: string;
	protocolCode: string;
	externalRef: string | null;
	title: string;
	description: string | null;
	aoiAreaHa: string;
	aoiPerimeterM: string;
	utmSrid: number;
	stateUf: string | null;
	primaryMunicipalityIbge: string | null;
	primaryMunicipalityName: string | null;
	intersectedMunicipalities: IntersectedMunicipalityInfo[];
	aoiGeoJson: AoiPolygonGeoJson;
	creator: { id: string; fullName: string; registrationCode: string };
	createdAt: Date;
	updatedAt: Date;
}) {
	const cleanStateUf = params.stateUf ? params.stateUf.trim() : null;
	const cleanMunCode = params.primaryMunicipalityIbge
		? params.primaryMunicipalityIbge.trim()
		: null;

	return {
		id: params.id,
		protocolCode: params.protocolCode,
		externalRef: params.externalRef,
		title: params.title,
		description: params.description,
		aoiAreaHa: Number(params.aoiAreaHa),
		aoiPerimeterM: Number(params.aoiPerimeterM),
		utmSrid: params.utmSrid,
		stateUf: cleanStateUf,
		primaryMunicipality:
			cleanMunCode && params.primaryMunicipalityName && cleanStateUf
				? {
						ibgeCode: cleanMunCode,
						name: params.primaryMunicipalityName,
						ufCode: cleanStateUf,
					}
				: null,
		intersectedMunicipalities: params.intersectedMunicipalities,
		aoiGeoJson: params.aoiGeoJson,
		createdBy: params.creator,
		createdAt: params.createdAt.toISOString(),
		updatedAt: params.updatedAt.toISOString(),
	};
}

class CaseService {
	// Pipeline completo Zero Trust para criação de caso e validação geodésica SIRGAS 2000 (RF-05, RF-08, RN-01, RN-06)
	async createCase(
		rawBody: unknown,
		actor: AuthenticatedUser,
		ctx: RequestClientContext,
	) {
		// Rejeita tipos GeoJSON diferentes de Polygon (ex: MultiPolygon, Point) com 422 ERR_INVALID_GEOMETRY
		if (
			rawBody &&
			typeof rawBody === 'object' &&
			'aoiGeoJson' in rawBody &&
			rawBody.aoiGeoJson &&
			typeof rawBody.aoiGeoJson === 'object' &&
			'type' in rawBody.aoiGeoJson &&
			typeof (rawBody.aoiGeoJson as { type?: unknown }).type === 'string' &&
			(rawBody.aoiGeoJson as { type: string }).type !== 'Polygon'
		) {
			throw new DomainError(
				'ERR_INVALID_GEOMETRY',
				`A geometria da AOI deve ser estritamente do tipo 'Polygon' (recebido '${(rawBody.aoiGeoJson as { type: string }).type}').`,
				{
					invalidParams: [
						{
							field: 'aoiGeoJson.type',
							reason: 'EXPECTED_POLYGON',
						},
					],
				},
			);
		}

		const input = CreateCaseBodySchema.parse(rawBody);
		validateAoiPolygonStructure(input.aoiGeoJson);

		const geoJsonString = JSON.stringify(input.aoiGeoJson);
		const geoEval = await caseRepository.evaluateAoiGeometry(geoJsonString);

		if (
			!geoEval.isValid ||
			!geoEval.isSimple ||
			geoEval.isEmpty ||
			geoEval.nRings !== 1 ||
			geoEval.geomType !== 'ST_Polygon' ||
			geoEval.utmSrid === null ||
			geoEval.areaHa === null ||
			geoEval.perimeterM === null
		) {
			throw new DomainError(
				'ERR_INVALID_GEOMETRY',
				`Geometria topologicamente inválida no PostGIS: ${geoEval.validReason}.`,
				{
					invalidParams: [
						{
							field: 'aoiGeoJson',
							reason: 'INVALID_POSTGIS_TOPOLOGY',
							meta: { postgisReason: geoEval.validReason },
						},
					],
				},
			);
		}

		if (geoEval.areaHa < env.MIN_AOI_AREA_HA || geoEval.areaHa > env.MAX_AOI_AREA_HA) {
			const isOverMax = geoEval.areaHa > env.MAX_AOI_AREA_HA;
			throw new DomainError(
				'ERR_AOI_AREA_OUT_OF_BOUNDS',
				isOverMax
					? `A área calculada em SIRGAS 2000 UTM (${geoEval.areaHa} ha) excede o teto configurado de ${env.MAX_AOI_AREA_HA} ha.`
					: `A área calculada em SIRGAS 2000 UTM (${geoEval.areaHa} ha) é inferior ao mínimo operacional de ${env.MIN_AOI_AREA_HA} ha.`,
				{
					invalidParams: [
						{
							field: 'aoiGeoJson',
							reason: isOverMax ? 'MAX_AREA_EXCEEDED' : 'MIN_AREA_BELOW_THRESHOLD',
							meta: {
								calculatedHa: geoEval.areaHa,
								minAllowedHa: env.MIN_AOI_AREA_HA,
								maxAllowedHa: env.MAX_AOI_AREA_HA,
							},
						},
					],
				},
			);
		}

		const territoryEval = await caseRepository.findTerritoryOverlaps(
			geoJsonString,
			geoEval.utmSrid,
		);

		if (env.ENFORCE_IMPORTED_UF_COVERAGE && territoryEval.coveredStates.length === 0) {
			throw new DomainError(
				'ERR_UF_NOT_COVERED',
				'A Área de Interesse não intersecta nenhuma Unidade Federativa ativa na base territorial do sistema.',
				{
					invalidParams: [
						{
							field: 'aoiGeoJson',
							reason: 'UF_NOT_IMPORTED',
						},
					],
				},
			);
		}

		const primaryMun = territoryEval.intersectedMunicipalities[0] ?? null;
		const resolvedStateUf = primaryMun?.ufCode ?? territoryEval.coveredStates[0] ?? null;

		const cleanTitle = sanitizePlainText(input.title);
		const cleanExternalRef = input.externalRef ? sanitizePlainText(input.externalRef) : null;
		const cleanDescription = input.description ? sanitizePlainText(input.description) : null;

		const created = await withTransaction(async (tx) => {
			const row = await caseRepository.create(
				{
					title: cleanTitle,
					externalRef: cleanExternalRef,
					description: cleanDescription,
					primaryMunicipalityIbge: primaryMun?.ibgeCode ?? null,
					primaryMunicipalityName: primaryMun?.name ?? null,
					stateUf: resolvedStateUf,
					intersectedMunicipalities: territoryEval.intersectedMunicipalities,
					geoJsonString,
					aoiAreaHa: geoEval.areaHa!.toFixed(4),
					aoiPerimeterM: geoEval.perimeterM!.toFixed(2),
					utmSrid: geoEval.utmSrid!,
					createdBy: actor.id,
				},
				tx,
			);

			await auditService.record(
				{
					actorUserId: actor.id,
					action: 'case_created',
					entityType: 'analysis_case',
					entityId: row.id,
					ipAddress: ctx.ipAddress,
					userAgent: ctx.userAgent,
					correlationId: ctx.correlationId,
					metadata: {
						protocolCode: row.protocolCode,
						aoiAreaHa: Number(row.aoiAreaHa),
						utmSrid: row.utmSrid,
						stateUf: row.stateUf,
						primaryMunicipalityIbge: row.primaryMunicipalityIbge,
					},
				},
				tx,
			);

			return row;
		});

		return formatCaseRecord({
			...created,
			creator: {
				id: actor.id,
				fullName: actor.fullName,
				registrationCode: actor.registrationCode,
			},
		});
	}

	async listCases(rawQuery: unknown) {
		const q = ListCasesQuerySchema.parse(rawQuery);
		const parsedBbox = q.bbox ? parseBboxParam(q.bbox) : undefined;

		const { total, rows } = await caseRepository.findManyPaginated({
			q: q.q,
			stateUf: q.stateUf,
			municipalityIbge: q.municipalityIbge,
			bbox: parsedBbox,
			status: q.status,
			createdBy: q.createdBy,
			from: q.from ? new Date(q.from) : undefined,
			to: q.to ? new Date(q.to) : undefined,
			page: q.page,
			limit: q.limit,
		});

		const totalPages = total === 0 ? 0 : Math.ceil(total / q.limit);

		return {
			items: rows.map((r) => ({
				...formatCaseRecord({
					id: r.id,
					protocolCode: r.protocolCode,
					externalRef: r.externalRef,
					title: r.title,
					description: r.description,
					aoiAreaHa: r.aoiAreaHa,
					aoiPerimeterM: r.aoiPerimeterM,
					utmSrid: r.utmSrid,
					stateUf: r.stateUf,
					primaryMunicipalityIbge: r.primaryMunicipalityIbge,
					primaryMunicipalityName: r.primaryMunicipalityName,
					intersectedMunicipalities: r.intersectedMunicipalities,
					aoiGeoJson: r.aoiGeoJson,
					creator: {
						id: r.creatorId,
						fullName: r.creatorFullName,
						registrationCode: r.creatorRegistrationCode,
					},
					createdAt: r.createdAt,
					updatedAt: r.updatedAt,
				}),
				runsCount: r.runsCount,
				latestRunStatus: r.latestRunStatus,
			})),
			pagination: {
				page: q.page,
				limit: q.limit,
				total,
				totalPages,
			},
		};
	}

	async getCaseById(rawParams: unknown) {
		const { caseId } = CaseIdParamsSchema.parse(rawParams);
		const found = await caseRepository.findByIdWithRuns(caseId);

		if (!found) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Caso de análise não encontrado.');
		}

		const { caseRow, runRows } = found;

		return {
			...formatCaseRecord({
				id: caseRow.id,
				protocolCode: caseRow.protocolCode,
				externalRef: caseRow.externalRef,
				title: caseRow.title,
				description: caseRow.description,
				aoiAreaHa: caseRow.aoiAreaHa,
				aoiPerimeterM: caseRow.aoiPerimeterM,
				utmSrid: caseRow.utmSrid,
				stateUf: caseRow.stateUf,
				primaryMunicipalityIbge: caseRow.primaryMunicipalityIbge,
				primaryMunicipalityName: caseRow.primaryMunicipalityName,
				intersectedMunicipalities: caseRow.intersectedMunicipalities,
				aoiGeoJson: caseRow.aoiGeoJson,
				creator: {
					id: caseRow.creatorId,
					fullName: caseRow.creatorFullName,
					registrationCode: caseRow.creatorRegistrationCode,
				},
				createdAt: caseRow.createdAt,
				updatedAt: caseRow.updatedAt,
			}),
			runs: runRows.map((run) => ({
				id: run.id,
				version: run.version,
				status: run.status,
				presetName: run.presetName,
				isCustomParams: run.isCustomParams,
				seasonalityWarning: run.seasonalityWarning,
				t0AcquiredAt: run.t0AcquiredAt.toISOString(),
				t1AcquiredAt: run.t1AcquiredAt.toISOString(),
				deforestationHa: run.deforestationHa !== null ? Number(run.deforestationHa) : null,
				degradationHa: run.degradationHa !== null ? Number(run.degradationHa) : null,
				regrowthHa: run.regrowthHa !== null ? Number(run.regrowthHa) : null,
				cloudMaskedHa: run.cloudMaskedHa !== null ? Number(run.cloudMaskedHa) : null,
				queuedAt: run.queuedAt.toISOString(),
				finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
			})),
		};
	}

	async updateCaseMetadata(rawParams: unknown, rawBody: unknown) {
		const { caseId } = CaseIdParamsSchema.parse(rawParams);
		const input = UpdateCaseBodySchema.parse(rawBody);

		const patch: Partial<{
			title: string;
			externalRef: string | null;
			description: string | null;
		}> = {};

		if (input.title !== undefined) {
			patch.title = sanitizePlainText(input.title);
		}
		if (input.externalRef !== undefined) {
			patch.externalRef = input.externalRef !== null ? sanitizePlainText(input.externalRef) : null;
		}
		if (input.description !== undefined) {
			patch.description = input.description !== null ? sanitizePlainText(input.description) : null;
		}

		const updated = await caseRepository.updateMetadataById(caseId, patch);
		if (!updated) {
			throw new DomainError('ERR_RESOURCE_NOT_FOUND', 'Caso de análise não encontrado.');
		}

		const { caseRow } = updated;
		return formatCaseRecord({
			id: caseRow.id,
			protocolCode: caseRow.protocolCode,
			externalRef: caseRow.externalRef,
			title: caseRow.title,
			description: caseRow.description,
			aoiAreaHa: caseRow.aoiAreaHa,
			aoiPerimeterM: caseRow.aoiPerimeterM,
			utmSrid: caseRow.utmSrid,
			stateUf: caseRow.stateUf,
			primaryMunicipalityIbge: caseRow.primaryMunicipalityIbge,
			primaryMunicipalityName: caseRow.primaryMunicipalityName,
			intersectedMunicipalities: caseRow.intersectedMunicipalities,
			aoiGeoJson: caseRow.aoiGeoJson,
			creator: {
				id: caseRow.creatorId,
				fullName: caseRow.creatorFullName,
				registrationCode: caseRow.creatorRegistrationCode,
			},
			createdAt: caseRow.createdAt,
			updatedAt: caseRow.updatedAt,
		});
	}
}

export default new CaseService();
