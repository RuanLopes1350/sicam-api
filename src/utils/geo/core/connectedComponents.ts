import type { FeatureClass } from '../../../config/db/schema/enums.js';
import { DomainError } from '../../helpers/domainError.js';

export interface ApprovedConnectedComponent {
	componentId: number;
	featureClass: FeatureClass;
	pixelCount: number;
	approxAreaHa: number;
	meanNdviT0: number;
	meanNdviT1: number;
	meanDeltaNdvi: number;
	bboxPx: [number, number, number, number];
	pixelIndices: Uint32Array;
}

export interface ConnectedComponentsResult {
	components: ApprovedConnectedComponent[];
	approvedMask: Uint8Array;
	discardedMmuComponents: number;
	discardedMmuPixels: number;
	minPixelsRequired: number;
}

interface ComponentAccumulator {
	rootLabel: number;
	pixelCount: number;
	pixelIndices: Uint32Array;
	writeCursor: number;
	sumNdviT0: number;
	sumNdviT1: number;
	sumDeltaNdvi: number;
	spectralCount: number;
	minCol: number;
	minRow: number;
	maxCol: number;
	maxRow: number;
}

// Spec Parte I — Seção 5.2: Two-Pass CCL 8-Vizinhos (Union-Find + Path Compression) + MMU + Agregação Espectral
export function extractApprovedComponents8Conn(params: {
	binaryMask: Uint8Array;
	width: number;
	height: number;
	featureClass: FeatureClass;
	minMappingUnitHa: number;
	ndviT0: Float32Array;
	ndviT1: Float32Array;
	deltaNdvi: Float32Array;
}): ConnectedComponentsResult {
	const {
		binaryMask,
		width,
		height,
		featureClass,
		minMappingUnitHa,
		ndviT0,
		ndviT1,
		deltaNdvi,
	} = params;

	const length = width * height;
	if (
		width <= 0 ||
		height <= 0 ||
		binaryMask.length !== length ||
		ndviT0.length !== length ||
		ndviT1.length !== length ||
		deltaNdvi.length !== length
	) {
		throw new DomainError(
			'ERR_INTERNAL_SERVER_ERROR',
			'Dimensões inconsistentes ao executar rotulagem de componentes conectados (CCL).',
		);
	}

	// Evita erro IEEE-754 (ex: 0.14 / 0.01 = 14.000000000000002) mantendo arredondamento de 6 casas antes do ceil
	const minPixelsRequired = Math.max(1, Math.ceil(Number((minMappingUnitHa * 100).toFixed(6))));

	const labels = new Int32Array(length);
	const parent: number[] = [0];

	function find(x: number): number {
		let root = x;
		while (parent[root]! !== root) {
			root = parent[root]!;
		}
		let curr = x;
		while (curr !== root) {
			const next = parent[curr]!;
			parent[curr] = root;
			curr = next;
		}
		return root;
	}

	function union(a: number, b: number): number {
		let ra = find(a);
		let rb = find(b);
		if (ra === rb) {
			return ra;
		}
		if (rb < ra) {
			const tmp = ra;
			ra = rb;
			rb = tmp;
		}
		parent[rb] = ra;
		return ra;
	}

	// Passo 1: Atribuição inicial e registro de equivalências em 8-conectividade
	let nextLabel = 1;
	for (let r = 0; r < height; r++) {
		const rowOffset = r * width;
		for (let c = 0; c < width; c++) {
			const idx = rowOffset + c;
			if (binaryMask[idx] !== 1) {
				continue;
			}

			let minNeighborRoot = 0;
			const lTopLeft = r > 0 && c > 0 ? labels[idx - width - 1]! : 0;
			const lTop = r > 0 ? labels[idx - width]! : 0;
			const lTopRight = r > 0 && c + 1 < width ? labels[idx - width + 1]! : 0;
			const lLeft = c > 0 ? labels[idx - 1]! : 0;

			if (lTopLeft > 0) {
				const rt = find(lTopLeft);
				minNeighborRoot = minNeighborRoot === 0 || rt < minNeighborRoot ? rt : minNeighborRoot;
			}
			if (lTop > 0) {
				const rt = find(lTop);
				minNeighborRoot = minNeighborRoot === 0 || rt < minNeighborRoot ? rt : minNeighborRoot;
			}
			if (lTopRight > 0) {
				const rt = find(lTopRight);
				minNeighborRoot = minNeighborRoot === 0 || rt < minNeighborRoot ? rt : minNeighborRoot;
			}
			if (lLeft > 0) {
				const rt = find(lLeft);
				minNeighborRoot = minNeighborRoot === 0 || rt < minNeighborRoot ? rt : minNeighborRoot;
			}

			if (minNeighborRoot === 0) {
				const label = nextLabel++;
				parent.push(label);
				labels[idx] = label;
			} else {
				labels[idx] = minNeighborRoot;
				if (lTopLeft > 0) union(minNeighborRoot, lTopLeft);
				if (lTop > 0) union(minNeighborRoot, lTop);
				if (lTopRight > 0) union(minNeighborRoot, lTopRight);
				if (lLeft > 0) union(minNeighborRoot, lLeft);
			}
		}
	}

	if (nextLabel === 1) {
		return {
			components: [],
			approvedMask: new Uint8Array(length),
			discardedMmuComponents: 0,
			discardedMmuPixels: 0,
			minPixelsRequired,
		};
	}

	// Achata equivalências e contabiliza pixels por raiz
	const rootOf = new Int32Array(nextLabel);
	const rootCounts = new Int32Array(nextLabel);
	for (let lbl = 1; lbl < nextLabel; lbl++) {
		rootOf[lbl] = find(lbl);
	}

	for (let i = 0; i < length; i++) {
		const lbl = labels[i]!;
		if (lbl > 0) {
			const rLbl = rootOf[lbl]!;
			rootCounts[rLbl] = rootCounts[rLbl]! + 1;
		}
	}

	// Filtro MMU e preparação dos acumuladores apenas para componentes aprovados
	const rootToSlot = new Int32Array(nextLabel).fill(-1);
	const accumulators: ComponentAccumulator[] = [];
	let discardedMmuComponents = 0;
	let discardedMmuPixels = 0;

	for (let lbl = 1; lbl < nextLabel; lbl++) {
		if (rootOf[lbl] !== lbl) {
			continue;
		}
		const count = rootCounts[lbl]!;
		if (count === 0) {
			continue;
		}
		if (count < minPixelsRequired) {
			discardedMmuComponents++;
			discardedMmuPixels += count;
			continue;
		}

		rootToSlot[lbl] = accumulators.length;
		accumulators.push({
			rootLabel: lbl,
			pixelCount: count,
			pixelIndices: new Uint32Array(count),
			writeCursor: 0,
			sumNdviT0: 0,
			sumNdviT1: 0,
			sumDeltaNdvi: 0,
			spectralCount: 0,
			minCol: width,
			minRow: height,
			maxCol: -1,
			maxRow: -1,
		});
	}

	const approvedMask = new Uint8Array(length);
	if (accumulators.length === 0) {
		return {
			components: [],
			approvedMask,
			discardedMmuComponents,
			discardedMmuPixels,
			minPixelsRequired,
		};
	}

	// Passo 2 (varredura única): preenche approvedMask, pixelIndices, bbox e agregação espectral
	for (let r = 0; r < height; r++) {
		const rowOffset = r * width;
		for (let c = 0; c < width; c++) {
			const i = rowOffset + c;
			const lbl = labels[i]!;
			if (lbl === 0) {
				continue;
			}
			const slotIdx = rootToSlot[rootOf[lbl]!]!;
			if (slotIdx < 0) {
				continue;
			}

			approvedMask[i] = 1;
			const acc = accumulators[slotIdx]!;
			acc.pixelIndices[acc.writeCursor++] = i;

			if (c < acc.minCol) acc.minCol = c;
			if (c > acc.maxCol) acc.maxCol = c;
			if (r < acc.minRow) acc.minRow = r;
			if (r > acc.maxRow) acc.maxRow = r;

			const v0 = ndviT0[i]!;
			const v1 = ndviT1[i]!;
			const vd = deltaNdvi[i]!;
			if (Number.isFinite(v0) && Number.isFinite(v1) && Number.isFinite(vd)) {
				acc.sumNdviT0 += v0;
				acc.sumNdviT1 += v1;
				acc.sumDeltaNdvi += vd;
				acc.spectralCount++;
			}
		}
	}

	accumulators.sort((a, b) => {
		if (b.pixelCount !== a.pixelCount) return b.pixelCount - a.pixelCount;
		if (a.minRow !== b.minRow) return a.minRow - b.minRow;
		return a.minCol - b.minCol;
	});

	const components: ApprovedConnectedComponent[] = accumulators.map((acc, index) => {
		const denom = acc.spectralCount > 0 ? acc.spectralCount : 1;
		return {
			componentId: index + 1,
			featureClass,
			pixelCount: acc.pixelCount,
			approxAreaHa: Number((acc.pixelCount * 0.01).toFixed(4)),
			meanNdviT0: Number((acc.sumNdviT0 / denom).toFixed(4)),
			meanNdviT1: Number((acc.sumNdviT1 / denom).toFixed(4)),
			meanDeltaNdvi: Number((acc.sumDeltaNdvi / denom).toFixed(4)),
			bboxPx: [acc.minCol, acc.minRow, acc.maxCol, acc.maxRow],
			pixelIndices: acc.pixelIndices,
		};
	});

	return {
		components,
		approvedMask,
		discardedMmuComponents,
		discardedMmuPixels,
		minPixelsRequired,
	};
}
