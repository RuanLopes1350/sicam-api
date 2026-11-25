const HTML_ESCAPE_MAP: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

// Especificação Parte II Seção 7.1: Escape HTML estrito (&, <, >, ", ') sem dependência pesada de DOM
export function escapeHtml(input: string): string {
	return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

// Remove caracteres de controle invisíveis (exceto quebra de linha e tabulação) e normaliza espaços externos
export function sanitizePlainText(input: string): string {
	return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}
