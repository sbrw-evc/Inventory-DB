/**
 * Parameterised SQL fragments. Every user-supplied value goes through `val()` and becomes a `?` placeholder;
 * identifiers come only from metadata (generated ids) and are quoted with `q()`.
 * Fragments are composed strictly in textual order so placeholders and params always line up.
 */
export interface Frag {
  sql: string;
  params: unknown[];
  /** Result type, where the compiler knows it (column expressions, formulas). */
  type?: SqlType;
}

/** Coarse SQL result types the compilers track to insert the casts PostgreSQL needs. */
export type SqlType = 'num' | 'text' | 'bool';

export const raw = (sql: string, type?: SqlType): Frag => ({ sql, params: [], type });

export const typed = (f: Frag, type: SqlType | undefined): Frag => ({ sql: f.sql, params: f.params, type });

/** Bind a value. Booleans become 1/0 (the stored checkbox form) and objects become JSON text. */
export function val(v: unknown): Frag {
  if (typeof v === 'boolean') return { sql: '?', params: [v ? 1 : 0], type: 'num' };
  if (v === undefined || v === null) return { sql: 'NULL', params: [] };
  if (typeof v === 'object') return { sql: '?', params: [JSON.stringify(v)], type: 'text' };
  if (typeof v === 'number') return { sql: Number.isInteger(v) ? '?' : 'CAST(? AS DOUBLE PRECISION)', params: [v], type: 'num' };
  return { sql: '?', params: [v], type: typeof v === 'string' ? 'text' : undefined };
}

/** Tagged template: every interpolation must be a Frag. */
export function sql(strings: TemplateStringsArray, ...parts: Frag[]): Frag {
  let text = strings[0];
  const params: unknown[] = [];
  parts.forEach((p, i) => {
    text += p.sql + strings[i + 1];
    params.push(...p.params);
  });
  return { sql: text, params };
}

export function join(frags: Frag[], sep: string): Frag {
  return { sql: frags.map((f) => f.sql).join(sep), params: frags.flatMap((f) => f.params) };
}

/** Escape LIKE wildcards; use with `ESCAPE '\'`. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
