import type { Column, SelectOption } from '@shared';

/**
 * Chip palette from the Umbrella legend (fill / border): info, ok, warning, error, critical, neutral, purple.
 * Select options store the fill colour; the border is derived from it.
 */
export const CHIP_PALETTE: Array<{ name: string; bg: string; border: string }> = [
  { name: 'info', bg: '#DAE8FC', border: '#6C8EBF' },
  { name: 'ok', bg: '#D5E8D4', border: '#82B366' },
  { name: 'warning', bg: '#FFF2CC', border: '#D6B656' },
  { name: 'error', bg: '#FFE6CC', border: '#D79B00' },
  { name: 'critical', bg: '#F8CECC', border: '#B85450' },
  { name: 'neutral', bg: '#F5F5F5', border: '#666666' },
  { name: 'purple', bg: '#E1D5E7', border: '#9673A6' },
];

export const CHOICE_COLORS = CHIP_PALETTE.map((c) => c.bg);

export const BASE_COLORS = ['#1168BD', '#438DD5', '#2E7D32', '#D79B00', '#B85450', '#9673A6', '#0B4884', '#666666'];

export function nextChoiceColor(existing: SelectOption[]): string {
  return CHOICE_COLORS[existing.length % CHOICE_COLORS.length];
}

export function choiceColor(column: Pick<Column, 'options'>, title: string): string {
  const found = column.options?.choices?.find((c) => c.title === title);
  if (found?.color) return found.color;
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CHOICE_COLORS[h % CHOICE_COLORS.length];
}

/** Border colour for a chip fill: the palette pair when known, otherwise a darkened fill. */
export function chipBorder(bg: string): string {
  const known = CHIP_PALETTE.find((c) => c.bg.toLowerCase() === bg.toLowerCase());
  if (known) return known.border;
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return '#9E9E9E';
  const n = parseInt(m[1], 16);
  const f = (x: number) => Math.max(0, Math.round(x * 0.6)).toString(16).padStart(2, '0');
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** Picks dark or white text for a background colour. */
export function textOn(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return '#222222';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#222222' : '#ffffff';
}

/** Theme tones the palette colours are drawn in: soft fill and strong text, as Umbrella's pills. */
const TONES: Record<string, [string, string]> = {
  info: ['var(--info-soft)', 'var(--info)'],
  ok: ['var(--ok-soft)', 'var(--ok)'],
  warning: ['var(--warn-soft)', 'var(--warn)'],
  error: ['var(--orange-soft)', 'var(--orange)'],
  critical: ['var(--error-soft)', 'var(--error)'],
  neutral: ['var(--surface-2)', 'var(--muted)'],
  purple: ['var(--purple-soft)', 'var(--purple)'],
};

export function chipStyle(bg: string): { background: string; borderColor: string; color: string } {
  const known = CHIP_PALETTE.find((c) => c.bg.toLowerCase() === bg.toLowerCase());
  const tone = known && TONES[known.name];
  // Palette colours follow the theme (light and dark); a custom colour is shown as stored.
  if (tone) return { background: tone[0], borderColor: 'transparent', color: tone[1] };
  return { background: bg, borderColor: 'transparent', color: textOn(bg) };
}
