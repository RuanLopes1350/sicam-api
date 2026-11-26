import type { FeatureClass } from '../../../config/db/schema/enums.js';
import { ensureProjDefinitions, projectCoords } from '../projRegistry.js';
import type { CanonicalGrid } from './canonicalGrid.js';
import type { ApprovedConnectedComponent } from './connectedComponents.js';

export interface GeoJsonPolygon4674 {
	type: 'Polygon';
	coordinates: [number, number][][];
}

export interface VectorizedFeaturePolygon {
	featureClass: FeatureClass;
	sourceComponentId: number;
	geomGeoJson: GeoJsonPolygon4674;
	ringsUtm: [number, number][][];
	pixelCount: number;
	approxAreaHa: number;
	meanNdviT0: number;
	meanNdviT1: number;
	meanDeltaNdvi: number;
	representativePointUtm: [number, number];
	representativePoint4674: [number, number];
}

interface DirectedGridEdge {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	dx: number;
	dy: number;
	used: boolean;
}

type Pt = [number, number];

function shoelaceSignedArea(ring: ReadonlyArray<Pt>): number {
	let sum = 0;
	const n = ring.length;
	for (let i = 0; i < n; i++) {
		const [x1, y1] = ring[i]!;
		const [x2, y2] = ring[(i + 1) % n]!;
		sum += x1 * y2 - x2 * y1;
	}
	return 0.5 * sum;
}

function pointInRing(pt: Pt, ring: ReadonlyArray<Pt>): boolean {
	const [px, py] = pt;
	let inside = false;
	const n = ring.length;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const [xi, yi] = ring[i]!;
		const [xj, yj] = ring[j]!;
		const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
		if (intersects) {
			inside = !inside;
		}
	}
	return inside;
}

function removeCollinearClosed(ring: ReadonlyArray<Pt>, epsilon = 1e-6): Pt[] {
	if (ring.length <= 3) {
		return ring.map(([x, y]) => [x, y]);
	}

	let pts: Pt[] = ring.map(([x, y]) => [x, y]);
	let changed = true;

	while (changed && pts.length > 3) {
		changed = false;
		const next: Pt[] = [];
		const n = pts.length;
		for (let i = 0; i < n; i++) {
			const prev = pts[(i - 1 + n) % n]!;
			const curr = pts[i]!;
			const after = pts[(i + 1) % n]!;
			const cross = Math.abs(
				(curr[0] - prev[0]) * (after[1] - prev[1]) - (curr[1] - prev[1]) * (after[0] - prev[0]),
			);
			const dot =
				(curr[0] - prev[0]) * (after[0] - curr[0]) + (curr[1] - prev[1]) * (after[1] - curr[1]);
			if (cross <= epsilon && dot >= -epsilon) {
				changed = true;
			} else {
				next.push(curr);
			}
		}
		if (next.length >= 3) {
			pts = next;
		} else {
			break;
		}
	}

	return pts;
}

function perpendicularDistance(pt: Pt, lineStart: Pt, lineEnd: Pt): number {
	const dx = lineEnd[0] - lineStart[0];
	const dy = lineEnd[1] - lineStart[1];
	const lenSq = dx * dx + dy * dy;
	if (lenSq <= 1e-12) {
		return Math.hypot(pt[0] - lineStart[0], pt[1] - lineStart[1]);
	}
	const num = Math.abs(dy * pt[0] - dx * pt[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0]);
	return num / Math.sqrt(lenSq);
}

function douglasPeuckerOpenChain(pts: ReadonlyArray<Pt>, tolerance: number): Pt[] {
	if (pts.length <= 2) {
		return pts.map(([x, y]) => [x, y]);
	}

	const start = pts[0]!;
	const end = pts[pts.length - 1]!;
	let maxDist = -1;
	let maxIdx = -1;

	for (let i = 1; i < pts.length - 1; i++) {
		const d = perpendicularDistance(pts[i]!, start, end);
		if (d > maxDist) {
			maxDist = d;
			maxIdx = i;
		}
	}

	if (maxDist > tolerance && maxIdx > 0) {
		const left = douglasPeuckerOpenChain(pts.slice(0, maxIdx + 1), tolerance);
		const right = douglasPeuckerOpenChain(pts.slice(maxIdx), tolerance);
		return [...left.slice(0, -1), ...right];
	}

	return [start, end];
}

function simplifyClosedRingUtm(ring: ReadonlyArray<Pt>, toleranceM: number): Pt[] {
	const clean = removeCollinearClosed(ring);
	if (toleranceM <= 0 || clean.length <= 4) {
		return clean;
	}

	// Ancora determinística no vértice mais sudoeste
	let anchorIdx = 0;
	for (let i = 1; i < clean.length; i++) {
		const cur = clean[i]!;
		const anc = clean[anchorIdx]!;
		if (cur[0] < anc[0] || (cur[0] === anc[0] && cur[1] < anc[1])) {
			anchorIdx = i;
		}
	}

	const rotated = [...clean.slice(anchorIdx), ...clean.slice(0, anchorIdx)];
	let oppIdx = 1;
	let maxDistSq = -1;
	const a = rotated[0]!;
	for (let i = 1; i < rotated.length; i++) {
		const p = rotated[i]!;
		const dSq = (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
		if (dSq > maxDistSq) {
			maxDistSq = dSq;
			oppIdx = i;
		}
	}

	const chain1 = douglasPeuckerOpenChain(rotated.slice(0, oppIdx + 1), toleranceM);
	const chain2 = douglasPeuckerOpenChain([...rotated.slice(oppIdx), rotated[0]!], toleranceM);
	const combined = [...chain1.slice(0, -1), ...chain2.slice(0, -1)];
	return removeCollinearClosed(combined);
}

function orientationSign(a: Pt, b: Pt, c: Pt): number {
	const val = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	if (Math.abs(val) <= 1e-9) return 0;
	return val > 0 ? 1 : -1;
}

function onSegment(a: Pt, b: Pt, p: Pt): boolean {
	return (
		p[0] >= Math.min(a[0], b[0]) - 1e-9 &&
		p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
		p[1] >= Math.min(a[1], b[1]) - 1e-9 &&
		p[1] <= Math.max(a[1], b[1]) + 1e-9
	);
}

function segmentsIntersectOrTouch(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
	if (
		Math.max(a1[0], a2[0]) < Math.min(b1[0], b2[0]) - 1e-9 ||
		Math.max(b1[0], b2[0]) < Math.min(a1[0], a2[0]) - 1e-9 ||
		Math.max(a1[1], a2[1]) < Math.min(b1[1], b2[1]) - 1e-9 ||
		Math.max(b1[1], b2[1]) < Math.min(a1[1], a2[1]) - 1e-9
	) {
		return false;
	}

	const o1 = orientationSign(a1, a2, b1);
	const o2 = orientationSign(a1, a2, b2);
	const o3 = orientationSign(b1, b2, a1);
	const o4 = orientationSign(b1, b2, a2);

	if (o1 !== o2 && o3 !== o4) return true;
	if (o1 === 0 && onSegment(a1, a2, b1)) return true;
	if (o2 === 0 && onSegment(a1, a2, b2)) return true;
	if (o3 === 0 && onSegment(b1, b2, a1)) return true;
	if (o4 === 0 && onSegment(b1, b2, a2)) return true;
	return false;
}

function isSimpleRing(ring: ReadonlyArray<Pt>): boolean {
	const n = ring.length;
	if (n < 3 || Math.abs(shoelaceSignedArea(ring)) < 25) {
		return false;
	}
	for (let i = 0; i < n; i++) {
		const a1 = ring[i]!;
		const a2 = ring[(i + 1) % n]!;
		for (let j = i + 2; j < n; j++) {
			if (i === 0 && j === n - 1) continue;
			const b1 = ring[j]!;
			const b2 = ring[(j + 1) % n]!;
			if (segmentsIntersectOrTouch(a1, a2, b1, b2)) {
				return false;
			}
		}
	}
	return true;
}

function ringsIntersect(ringA: ReadonlyArray<Pt>, ringB: ReadonlyArray<Pt>): boolean {
	const na = ringA.length;
	const nb = ringB.length;
	for (let i = 0; i < na; i++) {
		const a1 = ringA[i]!;
		const a2 = ringA[(i + 1) % na]!;
		for (let j = 0; j < nb; j++) {
			const b1 = ringB[j]!;
			const b2 = ringB[(j + 1) % nb]!;
			if (segmentsIntersectOrTouch(a1, a2, b1, b2)) {
				return true;
			}
		}
	}
	return false;
}

function enforceRingWindingCartesian(ring: ReadonlyArray<Pt>, counterClockwise: boolean): Pt[] {
	const area = shoelaceSignedArea(ring);
	const shouldFlip = counterClockwise ? area < 0 : area > 0;
	const ordered = shouldFlip ? [...ring].reverse() : ring.map(([x, y]): Pt => [x, y]);
	return [...ordered, [ordered[0]![0], ordered[0]![1]]];
}

// Spec Parte I — Seção 5.3: Vetorização por Contorno de Arestas Orientadas na Grade de Pixels (suporte a buracos + sela + DP 5m)
export function vectorizeComponentToPolygons(
	component: ApprovedConnectedComponent,
	grid: CanonicalGrid,
	simplifyToleranceM = 5.0,
): VectorizedFeaturePolygon[] {
	ensureProjDefinitions();

	const [minCol, minRow, maxCol, maxRow] = component.bboxPx;
	const localW = maxCol - minCol + 1;
	const localH = maxRow - minRow + 1;
	const localMask = new Uint8Array(localW * localH);

	for (let k = 0; k < component.pixelIndices.length; k++) {
		const idx = component.pixelIndices[k]!;
		const c = idx % grid.width;
		const r = Math.trunc(idx / grid.width);
		localMask[(r - minRow) * localW + (c - minCol)] = 1;
	}

	const edges: DirectedGridEdge[] = [];
	const stride = grid.width + 1;
	const edgesByStart = new Map<number, DirectedGridEdge[]>();

	const pushEdge = (x1: number, y1: number, x2: number, y2: number): void => {
		const edge: DirectedGridEdge = {
			x1,
			y1,
			x2,
			y2,
			dx: x2 - x1,
			dy: y2 - y1,
			used: false,
		};
		edges.push(edge);
		const key = y1 * stride + x1;
		const list = edgesByStart.get(key);
		if (list) {
			list.push(edge);
		} else {
			edgesByStart.set(key, [edge]);
		}
	};

	// Emissão de arestas orientadas segundo Spec Seção 5.3 passo 1
	for (let lr = 0; lr < localH; lr++) {
		const r = minRow + lr;
		const rowOffset = lr * localW;
		for (let lc = 0; lc < localW; lc++) {
			if (localMask[rowOffset + lc] !== 1) continue;
			const c = minCol + lc;

			if (lr === 0 || localMask[(lr - 1) * localW + lc] === 0) {
				pushEdge(c, r, c + 1, r);
			}
			if (lc + 1 === localW || localMask[rowOffset + lc + 1] === 0) {
				pushEdge(c + 1, r, c + 1, r + 1);
			}
			if (lr + 1 === localH || localMask[(lr + 1) * localW + lc] === 0) {
				pushEdge(c + 1, r + 1, c, r + 1);
			}
			if (lc === 0 || localMask[rowOffset + lc - 1] === 0) {
				pushEdge(c, r + 1, c, r);
			}
		}
	}

	// Encadeamento de anéis fechados com desambiguação de vértices de sela pela curva mais à direita
	const rawRingsGrid: Pt[][] = [];
	const holeProbePtsGrid: Map<number, Pt> = new Map();

	for (const seedEdge of edges) {
		if (seedEdge.used) continue;

		const ring: Pt[] = [[seedEdge.x1, seedEdge.y1]];
		seedEdge.used = true;
		let curr = seedEdge;

		while (curr.x2 !== seedEdge.x1 || curr.y2 !== seedEdge.y1) {
			ring.push([curr.x2, curr.y2]);
			const nextKey = curr.y2 * stride + curr.x2;
			const candidates = edgesByStart.get(nextKey)?.filter((e) => !e.used) ?? [];
			if (candidates.length === 0) {
				break;
			}

			let chosen: DirectedGridEdge;
			if (candidates.length === 1) {
				chosen = candidates[0]!;
			} else {
				// No sistema de grade (x p/ direita, y p/ baixo), curva à direita a partir de (dx, dy) é (-dy, dx)
				const rightDx = -curr.dy;
				const rightDy = curr.dx;
				chosen =
					candidates.find((e) => e.dx === rightDx && e.dy === rightDy) ??
					candidates.find((e) => e.dx === curr.dx && e.dy === curr.dy) ??
					candidates[0]!;
			}

			chosen.used = true;
			curr = chosen;
		}

		if (ring.length >= 4) {
			const signedPx = shoelaceSignedArea(ring);
			const ringIdx = rawRingsGrid.length;
			rawRingsGrid.push(ring);
			if (signedPx < 0) {
				// Centro do pixel vazio adjacente à esquerda da aresta seed (garantidamente no interior do buraco)
				const probeX = (seedEdge.x1 + seedEdge.x2) / 2 + 0.5 * seedEdge.dy;
				const probeY = (seedEdge.y1 + seedEdge.y2) / 2 - 0.5 * seedEdge.dx;
				holeProbePtsGrid.set(ringIdx, [probeX, probeY]);
			}
		}
	}

	interface ClassifiedExterior {
		gridRing: Pt[];
		areaPx: number;
		holes: Array<{ gridRing: Pt[]; probeGrid: Pt }>;
	}

	const exteriors: ClassifiedExterior[] = [];
	const holes: Array<{ gridRing: Pt[]; probeGrid: Pt }> = [];

	rawRingsGrid.forEach((gridRing, idx) => {
		const areaPx = shoelaceSignedArea(gridRing);
		if (areaPx > 0) {
			exteriors.push({ gridRing, areaPx, holes: [] });
		} else if (areaPx < 0) {
			const probeGrid = holeProbePtsGrid.get(idx) ?? gridRing[0]!;
			holes.push({ gridRing, probeGrid });
		}
	});

	// Ordena exteriores por menor área primeiro para que cada buraco vá ao menor exterior que o contém
	const exteriorsBySmallest = [...exteriors].sort((a, b) => a.areaPx - b.areaPx);
	for (const hole of holes) {
		const container = exteriorsBySmallest.find((ext) => pointInRing(hole.probeGrid, ext.gridRing));
		if (container) {
			container.holes.push(hole);
		}
	}

	// Mantém ordem decrescente de área líquida entre as partes do componente
	const toUtmRing = (gridRing: ReadonlyArray<Pt>): Pt[] =>
		gridRing.map(([gx, gy]) => [grid.e0 + gx * grid.pixelSizeM, grid.n1 - gy * grid.pixelSizeM]);

	const gridPtToUtm = ([gx, gy]: Pt): Pt => [
		grid.e0 + gx * grid.pixelSizeM,
		grid.n1 - gy * grid.pixelSizeM,
	];

	const utmCrs = `EPSG:${grid.utmSrid}`;
	const totalExactGridAreaPx = exteriors.reduce(
		(acc, ext) =>
			acc + ext.areaPx - ext.holes.reduce((hAcc, h) => hAcc + Math.abs(shoelaceSignedArea(h.gridRing)), 0),
		0,
	);

	const results: VectorizedFeaturePolygon[] = [];
	let allocatedPixelsSum = 0;

	// Ordena maiores exteriores primeiro para consistência com feature_sequence
	const sortedExteriors = [...exteriors].sort((a, b) => b.areaPx - a.areaPx);

	sortedExteriors.forEach((ext, extIdx) => {
		const exactExteriorUtm = removeCollinearClosed(toUtmRing(ext.gridRing));
		const dpExteriorUtm = simplifyClosedRingUtm(exactExteriorUtm, simplifyToleranceM);
		const useDpExterior =
			isSimpleRing(dpExteriorUtm) &&
			ext.holes.every((h) => pointInRing(gridPtToUtm(h.probeGrid), dpExteriorUtm));
		const finalOpenExteriorUtm = useDpExterior ? dpExteriorUtm : exactExteriorUtm;

		const acceptedOpenHolesUtm: Pt[][] = [];
		for (const hole of ext.holes) {
			const exactHoleUtm = removeCollinearClosed(toUtmRing(hole.gridRing));
			const dpHoleUtm = simplifyClosedRingUtm(exactHoleUtm, simplifyToleranceM);
			const holeProbeUtm = gridPtToUtm(hole.probeGrid);

			const dpValid =
				isSimpleRing(dpHoleUtm) &&
				pointInRing(holeProbeUtm, finalOpenExteriorUtm) &&
				!ringsIntersect(dpHoleUtm, finalOpenExteriorUtm) &&
				acceptedOpenHolesUtm.every((other) => !ringsIntersect(dpHoleUtm, other));

			acceptedOpenHolesUtm.push(dpValid ? dpHoleUtm : exactHoleUtm);
		}

		// Impõe orientação RFC 7946: exterior CCW (> 0), buracos CW (< 0) e fecha o anel
		const closedRingsUtm: Pt[][] = [
			enforceRingWindingCartesian(finalOpenExteriorUtm, true),
			...acceptedOpenHolesUtm.map((h) => enforceRingWindingCartesian(h, false)),
		];

		const exteriorAreaM2 = Math.abs(shoelaceSignedArea(finalOpenExteriorUtm));
		const holesAreaM2 = acceptedOpenHolesUtm.reduce(
			(sum, h) => sum + Math.abs(shoelaceSignedArea(h)),
			0,
		);
		const netAreaM2 = Math.max(0, exteriorAreaM2 - holesAreaM2);
		const approxAreaHa = Number((netAreaM2 / 10_000).toFixed(4));

		const exactPartGridPx =
			ext.areaPx -
			ext.holes.reduce((hSum, h) => hSum + Math.abs(shoelaceSignedArea(h.gridRing)), 0);

		let partPixelCount: number;
		if (sortedExteriors.length === 1) {
			partPixelCount = component.pixelCount;
		} else if (extIdx === sortedExteriors.length - 1) {
			partPixelCount = Math.max(1, component.pixelCount - allocatedPixelsSum);
		} else {
			partPixelCount = Math.max(
				1,
				Math.round((exactPartGridPx / Math.max(1, totalExactGridAreaPx)) * component.pixelCount),
			);
			allocatedPixelsSum += partPixelCount;
		}

		// Ponto representativo interno: centro do pixel do componente dentro deste anel exterior e fora dos buracos
		let repSumE = 0;
		let repSumN = 0;
		let repCount = 0;
		const insidePartPts: Pt[] = [];
		for (let k = 0; k < component.pixelIndices.length; k++) {
			const idx = component.pixelIndices[k]!;
			const c = idx % grid.width;
			const r = Math.trunc(idx / grid.width);
			const ptUtm: Pt = [
				grid.e0 + (c + 0.5) * grid.pixelSizeM,
				grid.n1 - (r + 0.5) * grid.pixelSizeM,
			];
			if (
				pointInRing(ptUtm, finalOpenExteriorUtm) &&
				acceptedOpenHolesUtm.every((h) => !pointInRing(ptUtm, h))
			) {
				insidePartPts.push(ptUtm);
				repSumE += ptUtm[0];
				repSumN += ptUtm[1];
				repCount++;
			}
		}

		let repUtm: Pt;
		if (insidePartPts.length > 0) {
			const meanE = repSumE / repCount;
			const meanN = repSumN / repCount;
			repUtm = insidePartPts[0]!;
			let bestDistSq = Number.POSITIVE_INFINITY;
			for (const pt of insidePartPts) {
				const dSq = (pt[0] - meanE) ** 2 + (pt[1] - meanN) ** 2;
				if (dSq < bestDistSq) {
					bestDistSq = dSq;
					repUtm = pt;
				}
			}
		} else {
			repUtm = finalOpenExteriorUtm[0]!;
		}

		const [repLon, repLat] = projectCoords(utmCrs, 'EPSG:4674', repUtm[0], repUtm[1]);

		const coordinates4674: Pt[][] = closedRingsUtm.map((ring) => {
			const projected = ring.map(([e, n]): Pt => {
				const [lon, lat] = projectCoords(utmCrs, 'EPSG:4674', e, n);
				return [Number(lon.toFixed(7)), Number(lat.toFixed(7))];
			});
			// Garante fechamento exato após arredondamento
			projected[projected.length - 1] = [projected[0]![0], projected[0]![1]];
			return projected;
		});

		results.push({
			featureClass: component.featureClass,
			sourceComponentId: component.componentId,
			geomGeoJson: {
				type: 'Polygon',
				coordinates: coordinates4674,
			},
			ringsUtm: closedRingsUtm,
			pixelCount: partPixelCount,
			approxAreaHa,
			meanNdviT0: component.meanNdviT0,
			meanNdviT1: component.meanNdviT1,
			meanDeltaNdvi: component.meanDeltaNdvi,
			representativePointUtm: [Number(repUtm[0].toFixed(2)), Number(repUtm[1].toFixed(2))],
			representativePoint4674: [Number(repLon.toFixed(7)), Number(repLat.toFixed(7))],
		});
	});

	return results;
}

// Vetoriza e ordena todos os componentes por área líquida decrescente (P1, P2, P3...)
export function vectorizeAllComponents(
	components: ReadonlyArray<ApprovedConnectedComponent>,
	grid: CanonicalGrid,
	simplifyToleranceM = 5.0,
): VectorizedFeaturePolygon[] {
	const all: VectorizedFeaturePolygon[] = [];
	for (const comp of components) {
		all.push(...vectorizeComponentToPolygons(comp, grid, simplifyToleranceM));
	}
	all.sort((a, b) => b.approxAreaHa - a.approxAreaHa);
	return all;
}
