/**
 * Formula language: tokenizer, parser, reference normalisation and a compiler to SQLite SQL.
 *
 * Users write `{Field Title}` references; the stored form uses `{columnId}` so renames never break a formula.
 * Literals are always bound as parameters (see sql.ts).
 */
import { type Frag, join, raw, sql, val } from './sql.js';

export class FormulaError extends Error {}

type Tok =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'str'; v: string; s: number; e: number }
  | { t: 'ref'; v: string; s: number; e: number }
  | { t: 'id'; v: string; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number }
  | { t: '(' | ')' | ',' | 'eof'; v: string; s: number; e: number };

export type FNode =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; name: string }
  | { k: 'call'; fn: string; args: FNode[] }
  | { k: 'bin'; op: string; l: FNode; r: FNode }
  | { k: 'neg'; e: FNode };

const OPS = ['<=', '>=', '!=', '<>', '==', '&&', '||', '+', '-', '*', '/', '%', '&', '=', '<', '>'];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const s = i;
    if (c === '{') {
      let v = '';
      i++;
      while (i < src.length && src[i] !== '}') {
        if (src[i] === '\\' && i + 1 < src.length) i++;
        v += src[i++];
      }
      if (i >= src.length) throw new FormulaError(`Unclosed field reference at position ${s + 1}`);
      i++;
      out.push({ t: 'ref', v: v.trim(), s, e: i });
      continue;
    }
    if (c === '"' || c === "'") {
      let v = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) {
          i++;
          v += src[i] === 'n' ? '\n' : src[i] === 't' ? '\t' : src[i];
          i++;
          continue;
        }
        v += src[i++];
      }
      if (i >= src.length) throw new FormulaError(`Unclosed string at position ${s + 1}`);
      i++;
      out.push({ t: 'str', v, s, e: i });
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new FormulaError(`Unexpected "${c}" at position ${i + 1}`);
      i += m[0].length;
      out.push({ t: 'num', v: Number(m[0]), s, e: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      i += m[0].length;
      out.push({ t: 'id', v: m[0], s, e: i });
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      i++;
      out.push({ t: c, v: c, s, e: i });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      i += op.length;
      out.push({ t: 'op', v: op, s, e: i });
      continue;
    }
    throw new FormulaError(`Unexpected "${c}" at position ${i + 1}`);
  }
  out.push({ t: 'eof', v: '', s: src.length, e: src.length });
  return out;
}

/** name -> [min args, max args] */
const FUNCTIONS: Record<string, [number, number]> = {
  IF: [2, 3],
  AND: [1, Infinity],
  OR: [1, Infinity],
  NOT: [1, 1],
  SWITCH: [3, Infinity],
  CONCAT: [1, Infinity],
  UPPER: [1, 1],
  LOWER: [1, 1],
  TRIM: [1, 1],
  LEN: [1, 1],
  LEFT: [2, 2],
  RIGHT: [2, 2],
  MID: [3, 3],
  SUBSTITUTE: [3, 3],
  REPLACE: [3, 3],
  ROUND: [1, 2],
  FLOOR: [1, 1],
  CEILING: [1, 1],
  ABS: [1, 1],
  MIN: [1, Infinity],
  MAX: [1, Infinity],
  MOD: [2, 2],
  POWER: [2, 2],
  SQRT: [1, 1],
  BLANK: [0, 0],
  ISBLANK: [1, 1],
  NOW: [0, 0],
  TODAY: [0, 0],
  DATEADD: [3, 3],
  DATETIME_DIFF: [2, 3],
  YEAR: [1, 1],
  MONTH: [1, 1],
  DAY: [1, 1],
  WEEKDAY: [1, 1],
  VALUE: [1, 1],
  TEXT: [1, 1],
  TRUE: [0, 0],
  FALSE: [0, 0],
};
export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);

const BIN_LEVELS: string[][] = [['||'], ['&&'], ['=', '==', '!=', '<>', '<', '>', '<=', '>='], ['&'], ['+', '-'], ['*', '/', '%']];

export function parseFormula(src: string): FNode {
  if (!src.trim()) throw new FormulaError('Formula is empty');
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const fail = (t: Tok, what = `Unexpected ${t.t === 'eof' ? 'end of formula' : `"${t.v}"`}`) => {
    throw new FormulaError(t.t === 'eof' ? what : `${what} at position ${t.s + 1}`);
  };
  const expect = (t: Tok['t']) => {
    const tok = toks[p];
    if (tok.t !== t) fail(tok, `Expected "${t}"`);
    p++;
    return tok;
  };

  const parseLevel = (lvl: number): FNode => {
    if (lvl >= BIN_LEVELS.length) return parseUnary();
    let l = parseLevel(lvl + 1);
    for (;;) {
      const t = peek();
      if (t.t === 'op' && BIN_LEVELS[lvl].includes(t.v)) {
        p++;
        const r = parseLevel(lvl + 1);
        l = { k: 'bin', op: t.v, l, r };
      } else return l;
    }
  };
  const parseUnary = (): FNode => {
    const t = peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
      p++;
      const e = parseUnary();
      return t.v === '-' ? { k: 'neg', e } : e;
    }
    return parsePrimary();
  };
  const parsePrimary = (): FNode => {
    const t = toks[p++];
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v };
      case 'str':
        return { k: 'str', v: t.v };
      case 'ref':
        if (!t.v) fail(t, 'Empty field reference');
        return { k: 'ref', name: t.v };
      case '(': {
        const e = parseLevel(0);
        expect(')');
        return e;
      }
      case 'id': {
        const name = t.v.toUpperCase();
        if (peek().t !== '(') {
          if (name === 'TRUE' || name === 'FALSE') return { k: 'bool', v: name === 'TRUE' };
          fail(t, `Unknown identifier "${t.v}" (use {${t.v}} to reference a field)`);
        }
        const spec = FUNCTIONS[name];
        if (!spec) fail(t, `Unknown function ${t.v}`);
        p++;
        const args: FNode[] = [];
        if (peek().t !== ')') {
          for (;;) {
            args.push(parseLevel(0));
            if (peek().t === ',') {
              p++;
              continue;
            }
            break;
          }
        }
        expect(')');
        const [min, max] = spec;
        if (args.length < min || args.length > max) {
          const range = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
          throw new FormulaError(`${name} expects ${range} argument${min === 1 && max === 1 ? '' : 's'}, got ${args.length}`);
        }
        if (name === 'TRUE' || name === 'FALSE') return { k: 'bool', v: name === 'TRUE' };
        return { k: 'call', fn: name, args };
      }
      default:
        return fail(t);
    }
  };
  const node = parseLevel(0);
  if (peek().t !== 'eof') fail(peek());
  return node;
}

export function collectRefs(node: FNode, out: string[] = []): string[] {
  switch (node.k) {
    case 'ref':
      out.push(node.name);
      break;
    case 'call':
      node.args.forEach((a) => collectRefs(a, out));
      break;
    case 'bin':
      collectRefs(node.l, out);
      collectRefs(node.r, out);
      break;
    case 'neg':
      collectRefs(node.e, out);
      break;
  }
  return out;
}

const escapeRef = (title: string) => title.replace(/[\\}]/g, (c) => `\\${c}`);

/** Replace every `{ref}` token using `map`; keeps the user's formatting otherwise. */
function rewriteRefs(src: string, map: (ref: string) => string): string {
  const toks = tokenize(src);
  let out = '';
  let last = 0;
  for (const t of toks) {
    if (t.t !== 'ref') continue;
    out += src.slice(last, t.s) + `{${escapeRef(map(t.v))}}`;
    last = t.e;
  }
  return out + src.slice(last);
}

/**
 * Validate a user-typed formula and convert `{Title}` refs to `{columnId}`.
 * Titles match case-insensitively; a raw column id is accepted too.
 */
export function normalizeFormula(src: string, columns: { id: string; title: string }[]): { normalized: string; refs: string[] } {
  const node = parseFormula(src);
  const resolve = (name: string) => {
    const c =
      columns.find((x) => x.title === name) ??
      columns.find((x) => x.title.toLowerCase() === name.toLowerCase()) ??
      columns.find((x) => x.id === name);
    if (!c) throw new FormulaError(`Unknown field {${name}}`);
    return c.id;
  };
  const refs = collectRefs(node).map(resolve);
  return { normalized: rewriteRefs(src, resolve), refs };
}

/** Stored `{columnId}` form -> display `{Title}` form. Unknown ids are left as-is. */
export function displayFormula(normalized: string, titleById: (id: string) => string | undefined): string {
  try {
    return rewriteRefs(normalized, (id) => titleById(id) ?? id);
  } catch {
    return normalized;
  }
}

const isoNow = raw(`strftime('%Y-%m-%dT%H:%M:%fZ','now')`);

const DATE_UNITS: Record<string, [string, number]> = {
  second: ['seconds', 1],
  minute: ['minutes', 1],
  hour: ['hours', 1],
  day: ['days', 1],
  week: ['days', 7],
  month: ['months', 1],
  year: ['years', 1],
};
function dateUnit(node: FNode, fn: string): string {
  if (node.k !== 'str') throw new FormulaError(`${fn}: the unit must be a quoted text such as 'day'`);
  const u = node.v.toLowerCase().replace(/s$/, '');
  if (u !== 'millisecond' && !DATE_UNITS[u]) throw new FormulaError(`${fn}: unknown unit '${node.v}'`);
  return u;
}

/**
 * Compile a parsed formula to an SQLite expression. `ref` resolves a (normalized) reference to the SQL
 * expression of that column; it is responsible for circular-reference detection.
 */
export function compileFormula(node: FNode, ref: (name: string) => Frag): Frag {
  const c = (n: FNode): Frag => compileFormula(n, ref);
  switch (node.k) {
    case 'num':
      // Numeric literals come from the tokenizer's digit pattern, so their canonical text is safe to inline
      // (and keeps integers as INTEGER, which bound JS numbers would not).
      return raw(Number.isFinite(node.v) ? String(node.v) : "NULL");
    case 'str':
      return val(node.v);
    case 'bool':
      return raw(node.v ? '1' : '0');
    case 'ref':
      return sql`(${ref(node.name)})`;
    case 'neg':
      return sql`(-${c(node.e)})`;
    case 'bin': {
      const l = c(node.l);
      const r = c(node.r);
      switch (node.op) {
        case '/':
          return sql`(${l} * 1.0 / NULLIF(${r}, 0))`;
        case '%':
          return sql`(${l} % NULLIF(${r}, 0))`;
        case '&':
          return sql`(COALESCE(${l}, '') || COALESCE(${r}, ''))`;
        case '==':
          return sql`(${l} = ${r})`;
        case '<>':
          return sql`(${l} != ${r})`;
        case '&&':
          return sql`(${l} AND ${r})`;
        case '||':
          return sql`(${l} OR ${r})`;
        default:
          return sql`(${l} ${raw(node.op)} ${r})`;
      }
    }
    case 'call':
      return compileCall(node.fn, node.args, c);
  }
}

function compileCall(fn: string, nodes: FNode[], c: (n: FNode) => Frag): Frag {
  const a = () => nodes.map(c);
  switch (fn) {
    case 'IF': {
      const [cond, t, f] = a();
      return sql`(CASE WHEN ${cond} THEN ${t} ELSE ${f ?? raw('NULL')} END)`;
    }
    case 'AND':
      return sql`(${join(a(), ' AND ')})`;
    case 'OR':
      return sql`(${join(a(), ' OR ')})`;
    case 'NOT':
      return sql`(NOT ${a()[0]})`;
    case 'SWITCH': {
      const [subject, ...rest] = a();
      const parts: Frag[] = [];
      for (let i = 0; i + 1 < rest.length; i += 2) parts.push(sql`WHEN ${rest[i]} THEN ${rest[i + 1]}`);
      const dflt = rest.length % 2 === 1 ? sql` ELSE ${rest[rest.length - 1]}` : raw('');
      return sql`(CASE ${subject} ${join(parts, ' ')}${dflt} END)`;
    }
    case 'CONCAT':
      return sql`(${join(
        a().map((x) => sql`COALESCE(${x}, '')`),
        ' || ',
      )})`;
    case 'UPPER':
      return sql`upper(${a()[0]})`;
    case 'LOWER':
      return sql`lower(${a()[0]})`;
    case 'TRIM':
      return sql`trim(${a()[0]})`;
    case 'LEN':
      return sql`length(${a()[0]})`;
    case 'LEFT': {
      const [s, n] = a();
      return sql`substr(${s}, 1, ${n})`;
    }
    case 'RIGHT': {
      const [s, n] = a();
      return sql`(CASE WHEN ${n} <= 0 THEN '' ELSE substr(${s}, -(${n})) END)`;
    }
    case 'MID': {
      const [s, start, n] = a();
      return sql`substr(${s}, ${start}, ${n})`;
    }
    case 'SUBSTITUTE':
    case 'REPLACE': {
      const [s, from, to] = a();
      return sql`replace(${s}, ${from}, ${to})`;
    }
    case 'ROUND': {
      const [x, p] = a();
      return sql`round(${x}, ${p ?? raw('0')})`;
    }
    case 'FLOOR':
      return sql`floor(${a()[0]})`;
    case 'CEILING':
      return sql`ceil(${a()[0]})`;
    case 'ABS':
      return sql`abs(${a()[0]})`;
    case 'MIN':
    case 'MAX': {
      const args = a();
      if (args.length === 1) return args[0];
      return sql`${raw(fn.toLowerCase())}(${join(args, ', ')})`;
    }
    case 'MOD': {
      const [x, y] = a();
      return sql`(${x} % NULLIF(${y}, 0))`;
    }
    case 'POWER': {
      const [x, y] = a();
      return sql`pow(${x}, ${y})`;
    }
    case 'SQRT':
      return sql`sqrt(${a()[0]})`;
    case 'BLANK':
      return raw('NULL');
    case 'ISBLANK': {
      const x = a()[0];
      return sql`(${x} IS NULL OR CAST(${x} AS TEXT) IN ('', '[]'))`;
    }
    case 'NOW':
      return isoNow;
    case 'TODAY':
      return raw(`date('now')`);
    case 'DATEADD': {
      const [d, n] = a();
      const unit = dateUnit(nodes[2], 'DATEADD');
      if (unit === 'millisecond') throw new FormulaError(`DATEADD: unknown unit 'millisecond'`);
      const [mod, mult] = DATE_UNITS[unit];
      const amount = mult === 1 ? sql`CAST(${n} AS INTEGER)` : sql`CAST(${n} AS INTEGER) * ${raw(String(mult))}`;
      const m = sql`printf('%+d ${raw(mod)}', ${amount})`;
      return sql`(CASE WHEN ${d} IS NULL THEN NULL WHEN length(${d}) <= 10 THEN date(${d}, ${m}) ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${d}, ${m}) END)`;
    }
    case 'DATETIME_DIFF': {
      const [d1, d2] = a();
      const unit = nodes[2] ? dateUnit(nodes[2], 'DATETIME_DIFF') : 'second';
      if (unit === 'month' || unit === 'year') {
        const months = sql`((CAST(strftime('%Y', ${d1}) AS INTEGER) - CAST(strftime('%Y', ${d2}) AS INTEGER)) * 12 + CAST(strftime('%m', ${d1}) AS INTEGER) - CAST(strftime('%m', ${d2}) AS INTEGER))`;
        return unit === 'month' ? months : sql`CAST(${months} / 12 AS INTEGER)`;
      }
      const factor: Record<string, number> = { millisecond: 86400000, second: 86400, minute: 1440, hour: 24, day: 1, week: 1 / 7 };
      return sql`CAST(round((julianday(${d1}) - julianday(${d2})) * ${raw(String(factor[unit]))}, 6) AS INTEGER)`;
    }
    case 'YEAR':
      return sql`CAST(strftime('%Y', ${a()[0]}) AS INTEGER)`;
    case 'MONTH':
      return sql`CAST(strftime('%m', ${a()[0]}) AS INTEGER)`;
    case 'DAY':
      return sql`CAST(strftime('%d', ${a()[0]}) AS INTEGER)`;
    case 'WEEKDAY':
      // 0 = Monday ... 6 = Sunday (NocoDB convention)
      return sql`((CAST(strftime('%w', ${a()[0]}) AS INTEGER) + 6) % 7)`;
    case 'VALUE': {
      const x = a()[0];
      return sql`(CASE WHEN trim(CAST(${x} AS TEXT)) GLOB '*[0-9]*' THEN CAST(replace(trim(CAST(${x} AS TEXT)), ',', '') AS REAL) END)`;
    }
    case 'TEXT':
      return sql`CAST(${a()[0]} AS TEXT)`;
  }
  throw new FormulaError(`Unknown function ${fn}`);
}
