/**
 * Formula language: tokenizer, parser, reference normalisation and a compiler to PostgreSQL.
 *
 * Users write `{Field Title}` references; the stored form uses `{columnId}` so renames never break a formula.
 * Literals are always bound as parameters (see sql.ts).
 */
import { type Frag, type SqlType, join, raw, sql, typed, val } from './sql.js';

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

const DATE_UNITS: Record<string, [string, number]> = {
  second: ['second', 1],
  minute: ['minute', 1],
  hour: ['hour', 1],
  day: ['day', 1],
  week: ['day', 7],
  month: ['month', 1],
  year: ['year', 1],
};
function dateUnit(node: FNode, fn: string): string {
  if (node.k !== 'str') throw new FormulaError(`${fn}: the unit must be a quoted text such as 'day'`);
  const u = node.v.toLowerCase().replace(/s$/, '');
  if (u !== 'millisecond' && !DATE_UNITS[u]) throw new FormulaError(`${fn}: unknown unit '${node.v}'`);
  return u;
}

// ---------------------------------------------------------------------------------------------------------------
// Type coercion. Formulas are dynamically typed (like spreadsheet cells); PostgreSQL is not, so every operand is
// converted to the type its operator needs. Text that isn't a number becomes NULL in arithmetic.

const NULL_FRAG = raw('NULL');
const isNull = (f: Frag) => f.sql === 'NULL';
/** A bare bound parameter has no type PostgreSQL could infer from an operator. */
const isParam = (f: Frag) => f.sql === '?' || f.sql === 'CAST(? AS DOUBLE PRECISION)';

export function asNum(f: Frag): Frag {
  if (isNull(f)) return raw('CAST(NULL AS DOUBLE PRECISION)', 'num');
  switch (f.type) {
    case 'num':
      return f.sql === '?' ? typed(sql`CAST(${f} AS DOUBLE PRECISION)`, 'num') : f;
    case 'bool':
      return typed(sql`CAST(${f} AS INTEGER)`, 'num');
    default:
      return typed(sql`nc_num(${asText(f)})`, 'num');
  }
}

export function asText(f: Frag): Frag {
  if (isNull(f)) return raw('CAST(NULL AS TEXT)', 'text');
  switch (f.type) {
    case 'text':
      return isParam(f) ? typed(sql`CAST(${f} AS TEXT)`, 'text') : f;
    case 'bool':
      return typed(sql`CAST(CAST(${f} AS INTEGER) AS TEXT)`, 'text');
    default:
      return typed(sql`CAST(${f} AS TEXT)`, 'text');
  }
}

export function asBool(f: Frag): Frag {
  if (isNull(f)) return raw('CAST(NULL AS BOOLEAN)', 'bool');
  switch (f.type) {
    case 'bool':
      return f;
    case 'num':
      return typed(sql`(${asNum(f)} <> 0)`, 'bool');
    default:
      return typed(sql`(nc_num(${asText(f)}) <> 0)`, 'bool');
  }
}

/** Common type of several values (CASE branches, LEAST/GREATEST args); mixed numbers and text become text. */
function unify(frags: Frag[]): { type: SqlType; frags: Frag[] } {
  const types = new Set(frags.filter((f) => !isNull(f)).map((f) => f.type ?? 'text'));
  const type: SqlType = types.size === 0 ? 'text' : types.has('text') ? 'text' : types.has('num') ? 'num' : 'bool';
  const conv = type === 'text' ? asText : type === 'num' ? asNum : asBool;
  return { type, frags: frags.map(conv) };
}

/** Operands of a comparison: text with text compares as text, anything involving a number compares numerically. */
function comparable(l: Frag, r: Frag): [Frag, Frag] {
  const lt = isNull(l) ? r.type : l.type;
  const rt = isNull(r) ? l.type : r.type;
  if ((lt ?? 'text') === 'text' && (rt ?? 'text') === 'text') return [asText(l), asText(r)];
  if (lt === 'bool' && rt === 'bool') return [l, r];
  return [asNum(l), asNum(r)];
}

const int = (f: Frag) => sql`CAST(trunc(${asNum(f)}) AS INTEGER)`;
const float = (f: Frag) => sql`CAST(${asNum(f)} AS DOUBLE PRECISION)`;
const numeric = (f: Frag) => sql`CAST(${asNum(f)} AS NUMERIC)`;
const ts = (f: Frag) => sql`nc_ts(${asText(f)})`;
const num = (f: Frag) => typed(f, 'num');
const text = (f: Frag) => typed(f, 'text');
const bool = (f: Frag) => typed(f, 'bool');

/**
 * Compile a parsed formula to a PostgreSQL expression. `ref` resolves a (normalized) reference to the SQL
 * expression of that column (with its `type`); it is responsible for circular-reference detection.
 * The result is typed; boolean results are left as booleans (callers that store/display them convert to 0/1).
 */
export function compileFormula(node: FNode, ref: (name: string) => Frag): Frag {
  const c = (n: FNode): Frag => compileFormula(n, ref);
  switch (node.k) {
    case 'num':
      // Numeric literals come from the tokenizer's digit pattern, so their canonical text is safe to inline.
      return Number.isFinite(node.v) ? raw(Number.isInteger(node.v) ? String(node.v) : `CAST(${node.v} AS DOUBLE PRECISION)`, 'num') : NULL_FRAG;
    case 'str':
      return val(node.v);
    case 'bool':
      return raw(node.v ? 'TRUE' : 'FALSE', 'bool');
    case 'ref': {
      const r = ref(node.name);
      if (isParam(r)) return r.type === 'num' ? asNum(r) : asText(r);
      return typed(sql`(${r})`, r.type);
    }
    case 'neg':
      return num(sql`(-${asNum(c(node.e))})`);
    case 'bin': {
      const l = c(node.l);
      const r = c(node.r);
      switch (node.op) {
        case '+':
        case '-':
        case '*':
          return num(sql`(${asNum(l)} ${raw(node.op)} ${asNum(r)})`);
        case '/':
          return num(sql`(${float(l)} / NULLIF(${float(r)}, 0))`);
        case '%':
          return num(sql`CAST(mod(${numeric(l)}, NULLIF(${numeric(r)}, 0)) AS DOUBLE PRECISION)`);
        case '&':
          return text(sql`(COALESCE(${asText(l)}, '') || COALESCE(${asText(r)}, ''))`);
        case '&&':
          return bool(sql`(${asBool(l)} AND ${asBool(r)})`);
        case '||':
          return bool(sql`(${asBool(l)} OR ${asBool(r)})`);
        default: {
          const op = node.op === '==' ? '=' : node.op === '!=' ? '<>' : node.op;
          const [a, b] = comparable(l, r);
          return bool(sql`(${a} ${raw(op)} ${b})`);
        }
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
      const u = unify([t, f ?? NULL_FRAG]);
      return typed(sql`(CASE WHEN ${asBool(cond)} THEN ${u.frags[0]} ELSE ${u.frags[1]} END)`, u.type);
    }
    case 'AND':
      return bool(sql`(${join(a().map(asBool), ' AND ')})`);
    case 'OR':
      return bool(sql`(${join(a().map(asBool), ' OR ')})`);
    case 'NOT':
      return bool(sql`(NOT ${asBool(a()[0])})`);
    case 'SWITCH': {
      const [subject, ...rest] = a();
      const pairs = Math.floor(rest.length / 2);
      const keys = unify([subject, ...Array.from({ length: pairs }, (_, i) => rest[i * 2])]).frags;
      const results = unify([...Array.from({ length: pairs }, (_, i) => rest[i * 2 + 1]), rest.length % 2 === 1 ? rest[rest.length - 1] : NULL_FRAG]);
      const parts: Frag[] = [];
      for (let i = 0; i < pairs; i++) parts.push(sql`WHEN ${keys[i + 1]} THEN ${results.frags[i]}`);
      return typed(sql`(CASE ${keys[0]} ${join(parts, ' ')} ELSE ${results.frags[pairs]} END)`, results.type);
    }
    case 'CONCAT':
      return text(
        sql`(${join(
          a().map((x) => sql`COALESCE(${asText(x)}, '')`),
          ' || ',
        )})`,
      );
    case 'UPPER':
      return text(sql`upper(${asText(a()[0])})`);
    case 'LOWER':
      return text(sql`lower(${asText(a()[0])})`);
    case 'TRIM':
      return text(sql`trim(${asText(a()[0])})`);
    case 'LEN':
      return num(sql`length(${asText(a()[0])})`);
    case 'LEFT': {
      const [s, n] = a();
      return text(sql`left(${asText(s)}, GREATEST(${int(n)}, 0))`);
    }
    case 'RIGHT': {
      const [s, n] = a();
      return text(sql`right(${asText(s)}, GREATEST(${int(n)}, 0))`);
    }
    case 'MID': {
      const [s, start, n] = a();
      return text(sql`substr(${asText(s)}, ${int(start)}, GREATEST(${int(n)}, 0))`);
    }
    case 'SUBSTITUTE':
    case 'REPLACE': {
      const [s, from, to] = a();
      return text(sql`replace(${asText(s)}, ${asText(from)}, ${asText(to)})`);
    }
    case 'ROUND': {
      const [x, p] = a();
      return num(sql`CAST(round(${numeric(x)}, ${p ? int(p) : raw('0')}) AS DOUBLE PRECISION)`);
    }
    case 'FLOOR':
      return num(sql`floor(${asNum(a()[0])})`);
    case 'CEILING':
      return num(sql`ceil(${asNum(a()[0])})`);
    case 'ABS':
      return num(sql`abs(${asNum(a()[0])})`);
    case 'MIN':
    case 'MAX': {
      const args = a();
      if (args.length === 1) return args[0];
      const u = unify(args);
      return typed(sql`${raw(fn === 'MIN' ? 'LEAST' : 'GREATEST')}(${join(u.frags, ', ')})`, u.type);
    }
    case 'MOD': {
      const [x, y] = a();
      return num(sql`CAST(mod(${numeric(x)}, NULLIF(${numeric(y)}, 0)) AS DOUBLE PRECISION)`);
    }
    case 'POWER': {
      const [x, y] = a();
      // Cases PostgreSQL rejects (complex results, division by zero) are NULL, like other invalid input.
      return num(
        sql`(CASE WHEN ${float(x)} < 0 AND ${float(y)} <> trunc(${float(y)}) THEN NULL WHEN ${float(x)} = 0 AND ${float(y)} < 0 THEN NULL ELSE power(${float(x)}, ${float(y)}) END)`,
      );
    }
    case 'SQRT': {
      const x = float(a()[0]);
      return num(sql`(CASE WHEN ${x} < 0 THEN NULL ELSE sqrt(${x}) END)`);
    }
    case 'BLANK':
      return NULL_FRAG;
    case 'ISBLANK': {
      const x = asText(a()[0]);
      return bool(sql`(${x} IS NULL OR ${x} IN ('', '[]'))`);
    }
    case 'NOW':
      return raw('nc_iso(now())', 'text');
    case 'TODAY':
      return raw(`to_char(CURRENT_DATE, 'YYYY-MM-DD')`, 'text');
    case 'DATEADD': {
      const [d0, n] = a();
      const d = asText(d0);
      const unit = dateUnit(nodes[2], 'DATEADD');
      if (unit === 'millisecond') throw new FormulaError(`DATEADD: unknown unit 'millisecond'`);
      const [iv, mult] = DATE_UNITS[unit];
      const amount = mult === 1 ? int(n) : sql`${int(n)} * ${raw(String(mult))}`;
      const delta = sql`(${amount} * INTERVAL '1 ${raw(iv)}')`;
      return text(
        sql`(CASE WHEN ${d} IS NULL THEN NULL WHEN length(${d}) <= 10 THEN to_char(nc_date(${d}) + ${delta}, 'YYYY-MM-DD') ELSE nc_iso(${ts(d)} + ${delta}) END)`,
      );
    }
    case 'DATETIME_DIFF': {
      const [d1, d2] = a();
      const unit = nodes[2] ? dateUnit(nodes[2], 'DATETIME_DIFF') : 'second';
      if (unit === 'month' || unit === 'year') {
        const part = (p: string, d: Frag) => sql`extract(${raw(p)} from ${ts(d)})`;
        const months = sql`((${part('year', d1)} - ${part('year', d2)}) * 12 + ${part('month', d1)} - ${part('month', d2)})`;
        return num(unit === 'month' ? sql`CAST(${months} AS INTEGER)` : sql`CAST(trunc(${months} / 12) AS INTEGER)`);
      }
      const seconds: Record<string, string> = { millisecond: '0.001', second: '1', minute: '60', hour: '3600', day: '86400', week: '604800' };
      return num(sql`CAST(trunc(round(extract(epoch from (${ts(d1)} - ${ts(d2)})) / ${raw(seconds[unit])}, 6)) AS BIGINT)`);
    }
    case 'YEAR':
      return num(sql`CAST(extract(year from ${ts(a()[0])}) AS INTEGER)`);
    case 'MONTH':
      return num(sql`CAST(extract(month from ${ts(a()[0])}) AS INTEGER)`);
    case 'DAY':
      return num(sql`CAST(extract(day from ${ts(a()[0])}) AS INTEGER)`);
    case 'WEEKDAY':
      // 0 = Monday ... 6 = Sunday (NocoDB convention)
      return num(sql`CAST(extract(isodow from ${ts(a()[0])}) - 1 AS INTEGER)`);
    case 'VALUE':
      return num(sql`nc_num(replace(trim(${asText(a()[0])}), ',', ''))`);
    case 'TEXT':
      return asText(a()[0]);
  }
  throw new FormulaError(`Unknown function ${fn}`);
}
