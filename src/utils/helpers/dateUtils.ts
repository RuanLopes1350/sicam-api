export function toUtcIso(date: Date): string {
	return date.toISOString();
}

export function getDayOfYearUtc(date: Date): number {
	const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
	const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
	return Math.floor((current - startOfYear) / 86_400_000);
}

// RF-14: Alerta de sazonalidade se a distância cíclica do dia-do-ano entre T0 e T1 exceder 60 dias
export function checkSeasonalityWarning(t0: Date, t1: Date, maxCyclicDays = 60): boolean {
	const doy0 = getDayOfYearUtc(t0);
	const doy1 = getDayOfYearUtc(t1);
	const directDiff = Math.abs(doy1 - doy0);
	const cyclicDiff = Math.min(directDiff, 365 - directDiff);
	return cyclicDiff > maxCyclicDays;
}
