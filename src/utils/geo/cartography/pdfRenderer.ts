import { createHash } from 'node:crypto';
import { type Browser, chromium } from 'playwright';
import type { PaperFormat } from '../../../config/db/schema/enums.js';
import { PAPER_LAYOUTS } from './scaleAndLayout.js';

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

export interface RenderPdfResult {
	pdfBuffer: Buffer;
	pdfSha256: string;
	pdfSizeBytes: number;
	blockedRequests: string[];
}

async function getCartographyBrowser(): Promise<Browser> {
	if (browserInstance && browserInstance.isConnected()) {
		return browserInstance;
	}
	if (!browserLaunchPromise) {
		browserLaunchPromise = chromium
			.launch({
				headless: true,
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-gpu',
				],
			})
			.then((browser) => {
				browserInstance = browser;
				browserLaunchPromise = null;
				browser.on('disconnected', () => {
					if (browserInstance === browser) {
						browserInstance = null;
					}
				});
				return browser;
			})
			.catch((err) => {
				browserLaunchPromise = null;
				throw err;
			});
	}
	return browserLaunchPromise;
}

export async function closeCartographyBrowser(): Promise<void> {
	if (browserLaunchPromise) {
		try {
			const launched = await browserLaunchPromise;
			await launched.close();
		} catch {
			// Ignora erro de encerramento se inicialização falhou
		}
		browserLaunchPromise = null;
	}
	if (browserInstance) {
		try {
			await browserInstance.close();
		} finally {
			browserInstance = null;
		}
	}
}

// RNF-05 & Spec Parte II Seção 7.1: Renderização PDF 300 DPI com rede 100% bloqueada no Chromium
export async function renderHtmlToCartographicPdf(
	html: string,
	paperFormat: PaperFormat,
): Promise<RenderPdfResult> {
	const browser = await getCartographyBrowser();
	const layout = PAPER_LAYOUTS[paperFormat];
	const blockedRequests: string[] = [];

	const context = await browser.newContext({
		offline: true,
		viewport: {
			width: Math.round(layout.sheetWidthMm * 3.7795275591),
			height: Math.round(layout.sheetHeightMm * 3.7795275591),
		},
	});

	try {
		const page = await context.newPage();

		// Barreira Zero Trust Anti-SSRF: bloqueia qualquer URL que não seja data: ou about:
		await page.route('**/*', (route) => {
			const url = route.request().url();
			if (url.startsWith('data:') || url.startsWith('about:')) {
				return route.continue();
			}
			blockedRequests.push(url);
			return route.abort('blockedbyclient');
		});

		await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
		await page.evaluate('document.fonts.ready');

		const rawPdf = await page.pdf({
			width: `${layout.sheetWidthMm}mm`,
			height: `${layout.sheetHeightMm}mm`,
			printBackground: true,
			preferCSSPageSize: true,
			margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
		});

		const pdfBuffer = Buffer.isBuffer(rawPdf) ? rawPdf : Buffer.from(rawPdf);
		const pdfSha256 = createHash('sha256').update(pdfBuffer).digest('hex');

		return {
			pdfBuffer,
			pdfSha256,
			pdfSizeBytes: pdfBuffer.byteLength,
			blockedRequests,
		};
	} finally {
		await context.close();
	}
}
