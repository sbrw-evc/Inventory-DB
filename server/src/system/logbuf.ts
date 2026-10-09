/**
 * The last warnings and errors of the server, shown on the system status page (Umbrella's log buffer).
 * Kept in memory only: they describe this process since it started.
 */
export type LogLevel = 'warn' | 'error';
export interface LogEntry {
  at: string;
  level: LogLevel;
  message: string;
  attrs?: Record<string, string>;
}

const LIMIT = 50;
const entries: LogEntry[] = [];
const counts: Record<LogLevel, number> = { warn: 0, error: 0 };

export function logEvent(level: LogLevel, message: string, attrs?: Record<string, unknown>) {
  const clean = attrs && Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
  entries.unshift({ at: new Date().toISOString(), level, message, attrs: clean && Object.keys(clean).length ? clean : undefined });
  if (entries.length > LIMIT) entries.length = LIMIT;
  counts[level]++;
  const line = `[${level}] ${message}${clean ? ' ' + JSON.stringify(clean) : ''}`;
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) (level === 'error' ? console.error : console.warn)(line);
}

export function recentLogs(): { counts: Record<LogLevel, number>; recent: LogEntry[] } {
  return { counts: { ...counts }, recent: entries.slice(0, 20) };
}

/** Tests. */
export function clearLogs() {
  entries.length = 0;
  counts.warn = counts.error = 0;
}
