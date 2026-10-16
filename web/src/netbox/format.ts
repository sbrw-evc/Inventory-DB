/** Pure helpers (no React) for DCIM/IPAM pages; unit-tested in format.test.ts. */
import type { Choice, Ref } from './api';

export type Tone = 'ok' | 'info' | 'warning' | 'error' | 'critical' | 'neutral' | 'purple';

/** Status → chip tone, per docs/design.md. */
export function statusTone(value: string | null | undefined): Tone {
  switch (value) {
    case 'active':
    case 'connected':
    case 'available':
    case 'ok':
      return 'ok';
    case 'planned':
    case 'container':
    case 'dhcp':
    case 'slaac':
    case 'info':
    case 'create':
      return 'info';
    case 'staged':
    case 'staging':
    case 'reserved':
    case 'warning':
    case 'update':
      return 'warning';
    case 'error':
      return 'error';
    case 'failed':
    case 'deprecated':
    case 'critical':
    case 'delete':
      return 'critical';
    default:
      return 'neutral';
  }
}

export const utilTone = (pct: number): Tone => (pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : 'ok');

export const isRef = (v: unknown): v is Ref => !!v && typeof v === 'object' && 'id' in v && 'display' in v;
export const isChoice = (v: unknown): v is Choice => !!v && typeof v === 'object' && 'value' in v && 'label' in v && !('id' in v);

/** Plain-text rendering of an API value (for CSV export and simple cells). */
export function plainText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(plainText).filter(Boolean).join(', ');
  if (isRef(v)) {
    const o = v as Record<string, unknown>;
    const parent = [o.device, o.virtual_machine, o.circuit, o.power_panel].find(isRef);
    return parent ? `${parent.display} ${v.display}` : v.display;
  }
  if (isChoice(v)) return v.label;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('object' in o && isRef(o.object)) return plainText(o.object);
    return JSON.stringify(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** CSV text with a header row. */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(plainText(r[c]))).join(','));
  return lines.join('\n');
}

export interface ElevationUnit {
  id: number;
  name: string;
  occupied: boolean;
  device: (Ref & { position: number; u_height: number; role_color?: string; status?: string; name?: string | null }) | null;
}

export interface ElevationBlock {
  /** Index of the first (top-most drawn) row in the units array. */
  row: number;
  /** Number of rows (units) the block spans. */
  span: number;
  device: ElevationUnit['device'];
  label: string;
}

/** Groups consecutive units of the same device into drawable blocks; empty units become single-row blocks. */
export function elevationBlocks(units: ElevationUnit[]): ElevationBlock[] {
  const out: ElevationBlock[] = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const prev = out[out.length - 1];
    if (u.device && prev?.device && prev.device.id === u.device.id && prev.row + prev.span === i) {
      prev.span++;
      continue;
    }
    out.push({ row: i, span: 1, device: u.device, label: u.device ? u.device.display : u.name });
  }
  return out;
}

export interface MonitoringStatus {
  status: 'ok' | 'info' | 'warning' | 'error' | 'critical' | string;
  open_alerts?: number;
  incident_url?: string | null;
}

/**
 * Normalises the Beacon integration status response. Accepts `{results: {id: status}}`, `{results: [{id|object_id, ...}]}`,
 * a bare map or a bare list.
 */
export function normalizeMonitoring(data: unknown): Map<number, MonitoringStatus> {
  const out = new Map<number, MonitoringStatus>();
  const body = data && typeof data === 'object' && 'results' in (data as object) ? (data as { results: unknown }).results : data;
  const put = (id: unknown, v: unknown) => {
    const n = Number(id);
    if (!Number.isFinite(n) || !v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    out.set(n, {
      status: String(o.status ?? 'unknown'),
      open_alerts: Number(o.open_alerts ?? o.alerts ?? 0) || 0,
      incident_url: (o.incident_url ?? o.incident_link ?? o.incident ?? null) as string | null,
    });
  };
  if (Array.isArray(body)) body.forEach((r) => put((r as Record<string, unknown>)?.object_id ?? (r as Record<string, unknown>)?.id, r));
  else if (body && typeof body === 'object') Object.entries(body).forEach(([k, v]) => put(k, v));
  return out;
}

/** Query params the UI keeps in the URL but must not send to the API. */
export const UI_PARAMS = new Set(['_sel', '_tab']);

export function apiParams(sp: URLSearchParams): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  sp.forEach((v, k) => {
    if (UI_PARAMS.has(k) || v === '') return;
    (out[k] ??= []).push(v);
  });
  return out;
}

/** Numeric value and family of an address or prefix string (`10.0.0.0/24`, `2001:db8::/32`), for sorting in the browser. */
export function addrKey(text: string): { family: 4 | 6; value: bigint; length: number } | null {
  const [ip, len] = String(text).split('/');
  if (ip.includes(':')) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const tl = tail !== undefined ? (tail ? tail.split(':') : []) : [];
    const groups = tail !== undefined ? [...h, ...Array<string>(Math.max(0, 8 - h.length - tl.length)).fill('0'), ...tl] : h;
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
    const value = groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
    return { family: 6, value, length: len ? Number(len) : 128 };
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return { family: 4, value: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n), length: len ? Number(len) : 32 };
}

export function compareAddr(a: string, b: string): number {
  const x = addrKey(a);
  const y = addrKey(b);
  if (!x || !y) return a.localeCompare(b);
  if (x.family !== y.family) return x.family - y.family;
  if (x.value !== y.value) return x.value < y.value ? -1 : 1;
  return x.length - y.length;
}

/** Text colour (dark/white) readable on a hex background. */
export function contrastText(hex: string | null | undefined): string {
  const h = String(hex ?? '9e9e9e').replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#222222' : '#ffffff';
}

/** Keys that changed between two serialized snapshots (for the history tab). */
export function changedKeys(pre: Record<string, unknown> | null, post: Record<string, unknown> | null): string[] {
  const skip = new Set(['last_updated', 'created', 'url', 'display_url']);
  const keys = new Set([...Object.keys(pre ?? {}), ...Object.keys(post ?? {})]);
  return [...keys].filter((k) => !skip.has(k) && JSON.stringify(pre?.[k] ?? null) !== JSON.stringify(post?.[k] ?? null));
}

/** Bits per second in SI units: `7.2 Gb/s` (`7,2 Гбит/с` in Russian). */
export function formatBps(bps: number | null | undefined, lang: 'en' | 'ru' = 'en'): string {
  if (bps == null || !Number.isFinite(bps)) return '—';
  const units = lang === 'ru' ? ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с', 'Тбит/с'] : ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'];
  let v = Math.max(0, bps);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = v >= 100 || i === 0 ? 0 : 1;
  return `${v.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${units[i]}`;
}

/** Bytes in binary units: `1.2 MiB` (`1,2 МиБ`). */
export function formatBytes(bytes: number | null | undefined, lang: 'en' | 'ru' = 'en'): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = lang === 'ru' ? ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`;
}

/** Utilisation (0..1, from Current) as a whole percentage for UtilBar; null when the speed is unknown. */
export const utilPct = (u: number | null | undefined): number | null => (u == null || !Number.isFinite(u) ? null : Math.round(Math.max(0, u) * 100));

/**
 * Time window of a sparkline: `10:00–11:00` within one day, `Oct 12, 10:00 PM – Oct 13, 10:00 PM`
 * (`12 окт., 22:00 – 13 окт., 22:00`) across days, so a 24-hour window is not shown as `10:00 PM–10:00 PM`.
 */
export function formatTimeRange(start: Date, end: Date, lang: 'en' | 'ru' = 'en', timeZone?: string): string {
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone });
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', timeZone };
  if (day(start) === day(end)) return `${start.toLocaleTimeString(locale, time)}–${end.toLocaleTimeString(locale, time)}`;
  const full = (d: Date) => d.toLocaleString(locale, { ...time, day: 'numeric', month: 'short' });
  return `${full(start)} – ${full(end)}`;
}

/** SVG polyline points for a sparkline series scaled to `max` inside a w×h box. */
export function sparkPoints(values: number[], max: number, w: number, h: number): string {
  if (!values.length) return '';
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const scale = max > 0 ? (h - 2) / max : 0;
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - Math.max(0, Number(v) || 0) * scale).toFixed(1)}`).join(' ');
}
