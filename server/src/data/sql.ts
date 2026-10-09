/**
 * Parameterised SQL fragments. Every user-supplied value goes through `val()` and becomes a `?` placeholder;
 * identifiers come only from metadata (generated ids) and are quoted with `q()`.
 * Fragments are composed strictly in textual order so placeholders and params always line up.
 */
export interface Frag {
  sql: string;
  params: unknown[];
}

export const raw = (sql: string): Frag => ({ sql, params: [] });

/** Bind a value. Booleans become 1/0 and objects become JSON since SQLite can't bind them. */
export function val(v: unknown): Frag {
  if (typeof v === 'boolean') return { sql: '?', params: [v ? 1 : 0] };
  if (v === undefined) return { sql: 'NULL', params: [] };
  if (v !== null && typeof v === 'object') return { sql: '?', params: [JSON.stringify(v)] };
  return { sql: '?', params: [v] };
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
