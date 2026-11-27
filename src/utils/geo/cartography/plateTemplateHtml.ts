import QRCode from 'qrcode';
import type { PaperFormat, StacProvider } from '../../../config/db/schema/enums.js';
import type { CartographyRunBundle } from '../../../repository/cartographyRepository.js';
import {
	formatAreaPtBr,
	formatDmsCoordinate,
	formatPctPtBr,
	formatScaleRatio,
	formatUtmMetersLabel,
	type LockedCartographicFrame,
} from './scaleAndLayout.js';
import {
	computeGraphicScaleBar,
	renderGraphicScaleBarSvg,
	renderTrueNorthArrowSvg,
} from './scaleBarSvg.js';

const PROVIDER_LABELS: Record<StacProvider, string> = {
	aws_earth_search: 'Sentinel-2 L2A (AWS Earth Search)',
	inpe_bdc: 'Sentinel-2 L2A (INPE BDC)',
};

// Zero Trust (Matriz + Spec 7.1): Escape HTML estrito contra XSS/HTML Injection
export function escapeHtmlStrict(value: string | null | undefined): string {
	if (!value) {
		return '';
	}
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export async function generateOfflineQrCodeSvg(payload: string): Promise<string> {
	return QRCode.toString(payload, {
		type: 'svg',
		margin: 1,
		errorCorrectionLevel: 'M',
		color: {
			dark: '#0F172A',
			light: '#FFFFFF',
		},
	});
}

function formatIsoToUtcCompact(date: Date): string {
	const iso = date.toISOString();
	const dPart = iso.slice(0, 10).split('-').reverse().join('/');
	const tPart = iso.slice(11, 19);
	return `${dPart} ${tPart} UTC`;
}

function formatDatePtBr(date: Date): string {
	return date.toISOString().slice(0, 10).split('-').reverse().join('/');
}

export interface BuildCartographicPlateHtmlInput {
	bundle: CartographyRunBundle;
	frame: LockedCartographicFrame;
	paperFormat: PaperFormat;
	t0PanelSvg: string;
	t1PanelSvg: string;
	ibgeInsetSvg: string;
	issuer: {
		fullName: string;
		registrationCode: string;
	};
	observations?: string | null;
	visualBasemapSource?: {
		t0Label: string;
		t1Label: string;
		isHiRes: boolean;
	} | null;
	datasetFingerprintSha256: string;
	emittedAt: Date;
}

// Spec Parte II — Seções 1, 6 e 7: Template HTML/CSS milimétrico 100% offline para Playwright 300 DPI
export async function buildCartographicPlateHtml(
	input: BuildCartographicPlateHtmlInput,
): Promise<string> {
	const {
		bundle,
		frame,
		paperFormat,
		t0PanelSvg,
		t1PanelSvg,
		ibgeInsetSvg,
		issuer,
		observations,
		visualBasemapSource,
		datasetFingerprintSha256,
		emittedAt,
	} = input;

	const layout = frame.layout;
	const isA3 = paperFormat === 'A3';
	const totalAoi = bundle.aoiAreaHa > 0 ? bundle.aoiAreaHa : 1;
	const pctOf = (ha: number) => Math.min(100, (ha / totalAoi) * 100);
	const cloudPct = pctOf(bundle.cloudMaskedHa);
	const visibilityCompromised = cloudPct > 50;

	const scaleBarSpec = computeGraphicScaleBar(frame.scaleDenominator, paperFormat);
	const scaleBarSvg = renderGraphicScaleBarSvg(scaleBarSpec);
	const northArrowSvg = renderTrueNorthArrowSvg(isA3 ? 13.0 : 9.5);

	const qrPayload = `SICAM|${bundle.protocolCode}|v${bundle.version}|${datasetFingerprintSha256}`;
	const qrSvg = await generateOfflineQrCodeSvg(qrPayload);

	const pctWidths = layout.footerBlocksMm.map((w) => ((w / layout.frameWidthMm) * 100).toFixed(4));

	const municipalitiesLabel =
		bundle.intersectedMunicipalities.length > 0
			? bundle.intersectedMunicipalities.map((m) => `${m.name}/${m.ufCode}`).join(', ')
			: bundle.primaryMunicipalityName && bundle.stateUf
				? `${bundle.primaryMunicipalityName}/${bundle.stateUf}`
				: 'Cobertura em validação territorial';

	const centerDmsLat = formatDmsCoordinate(bundle.aoiCenterLonLat[1], 'lat');
	const centerDmsLon = formatDmsCoordinate(bundle.aoiCenterLonLat[0], 'lon');
	const utmZoneLabel =
		bundle.utmSrid >= 31977
			? `${bundle.utmSrid - 31960}S`
			: `${bundle.utmSrid - 31954}N`;

	const sanitizedTitle = escapeHtmlStrict(bundle.title);
	const sanitizedProtocol = escapeHtmlStrict(bundle.protocolCode);
	const sanitizedExtRef = bundle.externalRef ? escapeHtmlStrict(bundle.externalRef) : '—';
	const sanitizedMun = escapeHtmlStrict(municipalitiesLabel);
	const sanitizedObs = observations ? escapeHtmlStrict(observations.trim()) : '';
	const sanitizedIssuer = escapeHtmlStrict(`${issuer.fullName} (${issuer.registrationCode})`);
	const sanitizedT0Ids = escapeHtmlStrict(bundle.t0ItemIds.join(', '));
	const sanitizedT1Ids = escapeHtmlStrict(bundle.t1ItemIds.join(', '));
	const sanitizedEngine = escapeHtmlStrict(
		`${bundle.presetName}${bundle.isCustomParams ? ' [CUSTOM]' : ' [PADRÃO]'} · ${bundle.engineVersion}`,
	);
	const sanitizedFingerprint = escapeHtmlStrict(datasetFingerprintSha256);

	const presetFontScale = isA3 ? 1 : 0.76;
	const px = (pt: number) => (pt * presetFontScale).toFixed(2);

	return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Carta-Imagem ${sanitizedProtocol} v${bundle.version}</title>
  <style>
    @page {
      size: ${layout.sheetWidthMm}mm ${layout.sheetHeightMm}mm;
      margin: 0;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: ${layout.sheetWidthMm}mm;
      height: ${layout.sheetHeightMm}mm;
      background: #FFFFFF;
      color: #0F172A;
      font-family: 'Liberation Sans', 'DejaVu Sans', sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      overflow: hidden;
    }
    .sheet {
      width: ${layout.sheetWidthMm}mm;
      height: ${layout.sheetHeightMm}mm;
      padding: ${layout.pageMarginMm}mm;
      background: #FFFFFF;
    }
    .frame {
      width: ${layout.frameWidthMm}mm;
      height: ${layout.frameHeightMm}mm;
      outline: 0.45mm solid #0F172A;
      outline-offset: -0.45mm;
      box-shadow: inset 0 0 0 0.90mm #FFFFFF, inset 0 0 0 1.15mm #334155;
      padding: 0.5mm;
      display: flex;
      flex-direction: column;
      background: #FFFFFF;
    }
    .header-band {
      height: ${layout.headerHeightMm - 0.5}mm;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 ${isA3 ? '4mm' : '3mm'};
      background: #0F172A;
      color: #F8FAFC;
      border-bottom: 0.35mm solid #1E293B;
      margin-bottom: ${layout.gap1Mm}mm;
    }
    .header-left {
      display: flex;
      flex-direction: column;
      gap: 0.5mm;
      min-width: 0;
    }
    .header-kicker {
      font-size: ${px(7.2)}pt;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #93C5FD;
      font-weight: 700;
    }
    .header-title {
      font-size: ${px(11.5)}pt;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: ${isA3 ? '280mm' : '195mm'};
    }
    .header-right {
      text-align: right;
      font-family: 'Liberation Mono', 'DejaVu Sans Mono', monospace;
      flex-shrink: 0;
    }
    .protocol-badge {
      font-size: ${px(10.5)}pt;
      font-weight: 700;
      color: #FDE047;
    }
    .protocol-sub {
      font-size: ${px(7.0)}pt;
      color: #CBD5E1;
    }
    .panels-band {
      height: ${layout.panelsRowHeightMm}mm;
      display: flex;
      flex-direction: row;
      gap: ${layout.panelGapMm}mm;
      margin-bottom: ${layout.gap2Mm}mm;
    }
    .panel-wrapper {
      width: ${layout.panelOuterWidthMm - 0.5}mm;
      height: ${layout.panelsRowHeightMm}mm;
      position: relative;
      border: 0.25mm solid #334155;
      background: #FFFFFF;
      overflow: hidden;
    }
    .panel-banner {
      position: absolute;
      top: 0.8mm;
      left: ${layout.gridGutterMm}mm;
      right: ${layout.gridGutterMm}mm;
      display: flex;
      justify-content: space-between;
      font-size: ${px(7.0)}pt;
      font-weight: 700;
      color: #0F172A;
      z-index: 2;
      pointer-events: none;
    }
    .panel-banner span.tag-t0 {
      color: #1D4ED8;
    }
    .panel-banner span.tag-t1 {
      color: #B91C1C;
    }
    .footer-band {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: row;
      border-top: 0.35mm solid #0F172A;
      background: #FFFFFF;
    }
    .footer-block {
      height: 100%;
      padding: ${isA3 ? '2.2mm 2.6mm' : '1.5mm 1.8mm'};
      border-right: 0.25mm solid #334155;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden;
    }
    .footer-block:last-child {
      border-right: none;
    }
    .block-title {
      font-size: ${px(7.2)}pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #0F172A;
      border-bottom: 0.2mm solid #CBD5E1;
      padding-bottom: 0.7mm;
      margin-bottom: 1.0mm;
    }
    .legend-grid {
      display: flex;
      flex-direction: column;
      gap: ${isA3 ? '1.3mm' : '0.8mm'};
    }
    .legend-row {
      display: flex;
      align-items: center;
      gap: 1.8mm;
      font-size: ${px(6.8)}pt;
    }
    .swatch {
      width: ${isA3 ? '5.5mm' : '4.0mm'};
      height: ${isA3 ? '3.0mm' : '2.2mm'};
      flex-shrink: 0;
      border: 0.2mm solid #1E293B;
    }
    .swatch-aoi {
      background: #FFD600;
      border: 0.45mm solid #000000;
    }
    .swatch-def {
      background: repeating-linear-gradient(45deg, rgba(211,47,47,0.55), rgba(211,47,47,0.55) 1px, rgba(183,28,28,0.85) 1px, rgba(183,28,28,0.85) 2px);
      border-color: #B71C1C;
    }
    .swatch-deg {
      background: rgba(245,124,0,0.45);
      border-color: #E65100;
    }
    .swatch-reg {
      background: rgba(0,200,83,0.40);
      border-color: #00E676;
    }
    .swatch-cloud {
      background: rgba(148,163,184,0.45);
      border-color: #64748B;
    }
    .scale-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 2mm;
      margin-top: 1mm;
      padding-top: 1mm;
      border-top: 0.15mm solid #E2E8F0;
    }
    .scale-numeric {
      font-family: 'Liberation Mono', 'DejaVu Sans Mono', monospace;
      font-size: ${px(8.0)}pt;
      font-weight: 700;
      color: #0F172A;
    }
    .inset-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
    }
    .inset-coords {
      font-family: 'Liberation Mono', 'DejaVu Sans Mono', monospace;
      font-size: ${px(6.1)}pt;
      color: #334155;
      line-height: 1.3;
      margin-top: 0.8mm;
    }
    table.quant-table {
      width: 100%;
      border-collapse: collapse;
      font-size: ${px(6.6)}pt;
    }
    table.quant-table th {
      background: #F1F5F9;
      color: #0F172A;
      text-align: left;
      padding: ${isA3 ? '0.9mm 1.2mm' : '0.5mm 0.8mm'};
      border-bottom: 0.2mm solid #64748B;
      font-weight: 700;
    }
    table.quant-table th.num,
    table.quant-table td.num {
      text-align: right;
      font-family: 'Liberation Mono', 'DejaVu Sans Mono', monospace;
    }
    table.quant-table td {
      padding: ${isA3 ? '0.8mm 1.2mm' : '0.45mm 0.8mm'};
      border-bottom: 0.12mm solid #E2E8F0;
    }
    table.quant-table tr.row-total td {
      font-weight: 700;
      background: #F8FAFC;
      border-bottom: 0.2mm solid #94A3B8;
    }
    .warnings-stack {
      display: flex;
      flex-direction: column;
      gap: 0.8mm;
      margin-top: 0.8mm;
    }
    .warn-pill {
      font-size: ${px(6.0)}pt;
      font-weight: 700;
      padding: 0.6mm 1.2mm;
      border-radius: 0.6mm;
      text-align: center;
    }
    .warn-cloud {
      background: #FEE2E2;
      color: #991B1B;
      border: 0.2mm solid #DC2626;
    }
    .warn-season {
      background: #FEF3C7;
      color: #92400E;
      border: 0.2mm solid #D97706;
    }
    .stamp-grid {
      display: grid;
      grid-template-columns: 1fr ${isA3 ? '21mm' : '15mm'};
      gap: 2mm;
      height: 100%;
      align-items: start;
    }
    .stamp-meta {
      font-size: ${px(6.1)}pt;
      line-height: 1.32;
      color: #1E293B;
      display: flex;
      flex-direction: column;
      gap: ${isA3 ? '0.65mm' : '0.4mm'};
      overflow: hidden;
    }
    .stamp-meta strong {
      color: #0F172A;
    }
    .mono {
      font-family: 'Liberation Mono', 'DejaVu Sans Mono', monospace;
    }
    .qr-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 0.8mm;
    }
    .qr-box svg {
      width: ${isA3 ? '19mm' : '13.5mm'};
      height: ${isA3 ? '19mm' : '13.5mm'};
      border: 0.2mm solid #CBD5E1;
    }
    .qr-caption {
      font-family: 'Liberation Mono', 'DejaVu Sans Mono', monospace;
      font-size: ${px(5.2)}pt;
      color: #475569;
      text-align: center;
      word-break: break-all;
    }
    .obs-box {
      margin-top: 0.6mm;
      padding: 0.8mm 1.2mm;
      background: #F8FAFC;
      border-left: 0.5mm solid #334155;
      font-size: ${px(5.8)}pt;
      color: #334155;
      max-height: ${isA3 ? '11mm' : '7.5mm'};
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="frame">
      <!-- FAIXA SUPERIOR -->
      <header class="header-band">
        <div class="header-left">
          <div class="header-kicker">SICAM — Sistema de Carta-Imagem e Análise Multitemporal (SIRGAS 2000)</div>
          <div class="header-title">CARTA-IMAGEM COMPARATIVA: ${sanitizedTitle}</div>
        </div>
        <div class="header-right">
          <div class="protocol-badge">${sanitizedProtocol} · v${bundle.version}</div>
          <div class="protocol-sub">${sanitizedMun} · Escala ${formatScaleRatio(frame.scaleDenominator)}</div>
        </div>
      </header>

      <!-- FAIXA CENTRAL: QUADROS SINCRONIZADOS T0 E T1 -->
      <section class="panels-band">
        <div class="panel-wrapper">
          <div class="panel-banner">
            <span class="tag-t0">T0 — CENÁRIO ANTERIOR: ${formatDatePtBr(bundle.t0AcquiredAt)}</span>
            <span>${escapeHtmlStrict(visualBasemapSource?.t0Label ?? PROVIDER_LABELS[bundle.t0Provider])}</span>
          </div>
          ${t0PanelSvg}
        </div>
        <div class="panel-wrapper">
          <div class="panel-banner">
            <span class="tag-t1">T1 — CENÁRIO ALVO: ${formatDatePtBr(bundle.t1AcquiredAt)}</span>
            <span>${escapeHtmlStrict(visualBasemapSource?.t1Label ?? PROVIDER_LABELS[bundle.t1Provider])}</span>
          </div>
          ${t1PanelSvg}
        </div>
      </section>

      <!-- FAIXA INFERIOR: 4 BLOCOS TÉCNICOS -->
      <footer class="footer-band">
        <!-- BLOCO 1: LEGENDA, NORTE E ESCALA -->
        <div class="footer-block" style="width:${pctWidths[0]}%;">
          <div>
            <div class="block-title">Legenda Temática &amp; Escala</div>
            <div class="legend-grid">
              <div class="legend-row"><span class="swatch swatch-aoi"></span><span>Perímetro da Área de Interesse (AOI)</span></div>
              <div class="legend-row"><span class="swatch swatch-def"></span><span>Desmatamento / Supressão (Classe 1)</span></div>
              <div class="legend-row"><span class="swatch swatch-deg"></span><span>Degradação / Perda Parcial (Classe 2)</span></div>
              <div class="legend-row"><span class="swatch swatch-reg"></span><span>Regeneração Florestal (Classe 3)</span></div>
              <div class="legend-row"><span class="swatch swatch-cloud"></span><span>Área Obstruída (Nuvens / Sombra SCL)</span></div>
            </div>
          </div>
          <div class="scale-row">
            <div style="display:flex;flex-direction:column;gap:0.8mm;">
              <div class="scale-numeric">Escala: ${formatScaleRatio(frame.scaleDenominator)} (${paperFormat})</div>
              ${scaleBarSvg}
            </div>
            <div>${northArrowSvg}</div>
          </div>
        </div>

        <!-- BLOCO 2: ENCARTE DE LOCALIZAÇÃO IBGE -->
        <div class="footer-block" style="width:${pctWidths[1]}%;">
          <div class="block-title">Localização Regional (IBGE)</div>
          <div class="inset-container">${ibgeInsetSvg}</div>
          <div class="inset-coords">
            <div>Centro AOI (SIRGAS 2000): ${centerDmsLat}, ${centerDmsLon}</div>
            <div>UTM Fuso ${utmZoneLabel}: ${formatUtmMetersLabel(bundle.aoiCenterUtm[0], 'E')} / ${formatUtmMetersLabel(bundle.aoiCenterUtm[1], 'N')}</div>
          </div>
        </div>

        <!-- BLOCO 3: QUADRO QUANTITATIVO DE ÁREAS -->
        <div class="footer-block" style="width:${pctWidths[2]}%;">
          <div>
            <div class="block-title">Quadro Quantitativo Oficial (SIRGAS UTM)</div>
            <table class="quant-table">
              <thead>
                <tr>
                  <th>Classe / Cobertura</th>
                  <th class="num">Área (ha)</th>
                  <th class="num">% AOI</th>
                </tr>
              </thead>
              <tbody>
                <tr class="row-total">
                  <td>Área Total da AOI</td>
                  <td class="num">${formatAreaPtBr(bundle.aoiAreaHa, 4)}</td>
                  <td class="num">100,00%</td>
                </tr>
                <tr>
                  <td>Área Analisada Limpa</td>
                  <td class="num">${formatAreaPtBr(bundle.validAnalyzedHa, 4)}</td>
                  <td class="num">${formatPctPtBr(pctOf(bundle.validAnalyzedHa))}%</td>
                </tr>
                <tr>
                  <td>Obstrução (Nuvem/Sombra)</td>
                  <td class="num">${formatAreaPtBr(bundle.cloudMaskedHa, 4)}</td>
                  <td class="num">${formatPctPtBr(cloudPct)}%</td>
                </tr>
                <tr>
                  <td>Desmatamento Válido</td>
                  <td class="num">${formatAreaPtBr(bundle.deforestationHa, 4)}</td>
                  <td class="num">${formatPctPtBr(pctOf(bundle.deforestationHa))}%</td>
                </tr>
                <tr>
                  <td>Degradação Florestal</td>
                  <td class="num">${formatAreaPtBr(bundle.degradationHa, 4)}</td>
                  <td class="num">${formatPctPtBr(pctOf(bundle.degradationHa))}%</td>
                </tr>
                <tr>
                  <td>Regeneração Florestal</td>
                  <td class="num">${formatAreaPtBr(bundle.regrowthHa, 4)}</td>
                  <td class="num">${formatPctPtBr(pctOf(bundle.regrowthHa))}%</td>
                </tr>
                <tr>
                  <td>Área Estável</td>
                  <td class="num">${formatAreaPtBr(bundle.stableHa, 4)}</td>
                  <td class="num">${formatPctPtBr(pctOf(bundle.stableHa))}%</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="warnings-stack">
            ${visibilityCompromised ? '<div class="warn-pill warn-cloud">AVISO RN-04: VISIBILIDADE COMPROMETIDA (&gt; 50% NUVENS)</div>' : ''}
            ${bundle.seasonalityWarning ? '<div class="warn-pill warn-season">AVISO RF-14: DIFERENÇA SAZONAL &gt; 60 DIAS ENTRE T0 E T1</div>' : ''}
          </div>
        </div>

        <!-- BLOCO 4: CARIMBO TÉCNICO & CUSTÓDIA SHA-256 -->
        <div class="footer-block" style="width:${pctWidths[3]}%;">
          <div class="block-title">Carimbo Técnico &amp; Cadeia de Custódia</div>
          <div class="stamp-grid">
            <div class="stamp-meta">
              <div><strong>Protocolo:</strong> <span class="mono">${sanitizedProtocol} (v${bundle.version})</span> · <strong>Ref:</strong> ${sanitizedExtRef}</div>
              <div><strong>Referencial:</strong> SIRGAS 2000 / UTM ${utmZoneLabel} (EPSG:${bundle.utmSrid})</div>
              <div><strong>Cena T0:</strong> <span class="mono">${sanitizedT0Ids}</span> (${formatIsoToUtcCompact(bundle.t0AcquiredAt)}, ${formatPctPtBr(bundle.t0CloudPctAoi)}% nuvem)</div>
              <div><strong>Cena T1:</strong> <span class="mono">${sanitizedT1Ids}</span> (${formatIsoToUtcCompact(bundle.t1AcquiredAt)}, ${formatPctPtBr(bundle.t1CloudPctAoi)}% nuvem)</div>
              ${visualBasemapSource?.isHiRes ? `<div><strong>Mosaico Visual PDF:</strong> ${escapeHtmlStrict(visualBasemapSource.t0Label)} / ${escapeHtmlStrict(visualBasemapSource.t1Label)}</div>` : ''}
              <div><strong>Parâmetros / Motor:</strong> ${sanitizedEngine}</div>
              <div><strong>Emissor:</strong> ${sanitizedIssuer} · <strong>Emissão:</strong> ${formatIsoToUtcCompact(emittedAt)}</div>
              <div><strong>Fingerprint Dados:</strong> <span class="mono">${sanitizedFingerprint.slice(0, 24)}…</span></div>
              ${sanitizedObs ? `<div class="obs-box"><strong>Obs.:</strong> ${sanitizedObs}</div>` : ''}
            </div>
            <div class="qr-box">
              ${qrSvg}
              <div class="qr-caption">SHA-256 Dados<br/>${sanitizedFingerprint.slice(0, 12)}</div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  </div>
</body>
</html>`;
}
