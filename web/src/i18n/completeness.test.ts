// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { models } from '../../../server/src/netbox/registry';
import { dictionaries } from '../netbox/i18n';
import { ru } from './ru';
import { ruFeatures } from './ruFeatures';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Literal keys passed to the main app's `t(...)` (string or template literal without `${}`). */
function translationKeys(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  const keys: string[] = [];
  const re = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$]*)`)/g;
  for (const m of code.matchAll(re)) keys.push((m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, '$1'));
  return keys;
}

const isNetbox = (f: string) => relative(SRC, f).startsWith('netbox');
const files = sourceFiles(SRC).filter((f) => !isNetbox(f));
const netboxFiles = sourceFiles(SRC).filter(isNetbox);
const ruDict = { ...ruFeatures, ...ru };

describe('i18n completeness', () => {
  it('every t() key used by the app has a Russian translation', () => {
    const missing = new Set<string>();
    for (const f of files)
      for (const key of translationKeys(f)) if (!(key in ruDict)) missing.add(`${relative(SRC, f)}: ${key}`);
    expect([...missing]).toEqual([]);
  });

  it('Russian translations keep the {placeholders} of their key', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const broken = Object.entries(ruDict).filter(([k, v]) => vars(k).join() !== vars(v).join());
    expect(broken).toEqual([]);
  });

  it('NetBox dictionaries have a Russian string for every entry', () => {
    const broken = Object.entries(dictionaries).flatMap(([name, dict]) =>
      Object.entries(dict)
        .filter(([, [en, ruText]]) => !en || !ruText)
        .map(([key]) => `${name}.${key}`),
    );
    expect(broken).toEqual([]);
  });

  it('every NetBox t() key exists in the NetBox UI dictionary', () => {
    const missing = netboxFiles.flatMap((f) => translationKeys(f).filter((k) => !(k in dictionaries.ui)).map((k) => `${relative(SRC, f)}: ${k}`));
    expect(missing).toEqual([]);
  });

  it('every NetBox object type, field and worded choice from the server has a translation', () => {
    const { types, fields, values } = dictionaries;
    const missing: string[] = [];
    for (const m of models) {
      if (!types[`${m.app}/${m.path}`] && !types[m.path]) missing.push(`type ${m.app}/${m.path}`);
      for (const f of m.fields) {
        if (!fields[f.name] && !fields[f.name.replace(/_id$/, '')]) missing.push(`field ${m.type}.${f.name}`);
        // Codes such as "SFP+ (10GE)" or "C13" read the same in every language; labels with words need a translation.
        for (const [value, label] of f.choices ?? []) if (/[a-z]{3,}/.test(label) && !values[value]) missing.push(`choice ${m.type}.${f.name}=${value}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
