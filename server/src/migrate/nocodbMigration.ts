/**
 * Copies one NocoDB base into a new Inventory DB base: tables, fields, select options, records, links and views.
 * Runs as a background job; progress and a report of anything skipped/converted go to the job.
 *
 * The NocoDB API token is only handed to the client; it is never written to the job log, message or result.
 */
import type { Column, ColumnOptions, FieldType, FilterGroup, Sort, View, ViewColumn, ViewMeta } from '../../../shared/src/index.js';
import { linkRecords, insertRecords } from '../data/records.js';
import { addColumn, createBase, createTable, createView, deleteBase, getTable, getView, updateColumn, updateView } from '../meta/service.js';
import { updateJob } from '../platform/jobs.js';
import {
  convertValue,
  formulaRefs,
  isLinkColumn,
  mapFilters,
  mapSorts,
  mapViewType,
  parseMeta,
  parseWidth,
  planColumn,
  relationKey,
  rewriteFormula,
  uniqueTitle,
  viewTypeName,
  type ColumnPlan,
  type MappedColumnRef,
  type RelationType,
} from './mapping.js';
import {
  mapConcurrent,
  NocoDBClient,
  type NocoColumn,
  type NocoDBClientOptions,
  type NocoRecord,
  type NocoTable,
  type NocoView,
  type NocoViewColumn,
} from './nocodbClient.js';

export interface MigrationInput {
  url: string;
  token: string;
  nocoBaseId: string;
  targetTitle?: string;
  userId: string;
  jobId: string;
  /** Test hooks: fetch implementation, retry timing, page size... */
  client?: Partial<Omit<NocoDBClientOptions, 'url' | 'token'>>;
}

export interface MigrationResult {
  baseId: string;
  tables: number;
  records: number;
  links: number;
  views: number;
  /** Things not migrated, as "Table.Field: reason". */
  skipped: string[];
  /** Things migrated with a change of type/behaviour. */
  converted: string[];
}

interface NewColumn {
  title: string;
  type: FieldType;
  options?: ColumnOptions;
  primary?: boolean;
  description?: string | null;
}

interface StoredField {
  nocoTitle: string;
  ourId: string;
  type: FieldType;
  sourceUidt: string;
}

interface TableState {
  noco: NocoTable;
  ourId: string;
  pkTitle: string;
  plans: Map<string, ColumnPlan>;
  /** NocoDB title → our title, when it had to change */
  renames: Map<string, string>;
  stored: StoredField[];
  /** String(NocoDB primary key) → our row id */
  rowMap: Map<string, number>;
}

interface Relation {
  table: TableState;
  col: NocoColumn;
  relation: RelationType;
  related: TableState;
  ourColumnId: string;
  /** Link hints captured while copying records: NocoDB pk → cell value of the link field */
  hints: Map<string, unknown>;
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/** Removes any accidental occurrence of the token from text that may be shown or stored. */
function redact(text: string, token: string): string {
  const t = token.trim();
  return t.length >= 4 ? text.split(t).join('***') : text;
}

/** Runs the migration and records the outcome on the job. Never throws. */
export async function runMigration(input: MigrationInput): Promise<MigrationResult | null> {
  const m = new Migration(input);
  try {
    const result = await m.run();
    updateJob(input.jobId, {
      status: 'done',
      progress: 1,
      message: `Migrated ${result.tables} tables and ${result.records} records`,
      appendLog: `Done: ${result.tables} tables, ${result.records} records, ${result.links} links, ${result.views} views` +
        (result.skipped.length ? `; ${result.skipped.length} items skipped` : ''),
      result,
    });
    return result;
  } catch (err) {
    const message = redact((err as Error)?.message || String(err), input.token);
    let cleanup = '';
    if (m.baseId) {
      try {
        deleteBase(m.baseId);
        cleanup = ' (the partially created base was removed)';
      } catch {
        /* keep the partial base */
      }
    }
    try {
      updateJob(input.jobId, { status: 'failed', message, appendLog: `Failed: ${message}${cleanup}` });
    } catch {
      /* job store unavailable; nothing more we can do */
    }
    return null;
  }
}

class Migration {
  private client: NocoDBClient;
  baseId: string | null = null;
  private tables = new Map<string, TableState>();
  /** NocoDB column id → our column (id + type) */
  private colMap = new Map<string, MappedColumnRef>();
  private relations: Relation[] = [];
  private skipped: string[] = [];
  private converted: string[] = [];
  private ctx: { userId: string };
  private counts = { records: 0, links: 0, views: 0 };

  constructor(private input: MigrationInput) {
    this.client = new NocoDBClient({ ...input.client, url: input.url, token: input.token });
    this.ctx = { userId: input.userId };
  }

  private log(line: string, progress?: number, message?: string) {
    updateJob(this.input.jobId, {
      appendLog: redact(line, this.input.token),
      ...(progress !== undefined ? { progress: Math.max(0, Math.min(0.99, progress)) } : {}),
      ...(message ? { message } : {}),
    });
  }

  private skip(where: string, reason: string) {
    this.skipped.push(`${where}: ${reason}`);
  }

  async run(): Promise<MigrationResult> {
    updateJob(this.input.jobId, { status: 'running', progress: 0.01, message: 'Connecting to NocoDB', appendLog: `Connecting to ${this.client.baseUrl}` });

    // ---- read NocoDB schema
    let title = this.input.targetTitle?.trim();
    if (!title) {
      try {
        title = (await this.client.getBase(this.input.nocoBaseId)).title;
      } catch {
        title = (await this.client.listBases()).find((b) => b.id === this.input.nocoBaseId)?.title;
      }
    }
    const summaries = await this.client.listTables(this.input.nocoBaseId);
    const tableSummaries = summaries
      .filter((t) => {
        if (truthy(t.mm)) return false; // hidden junction tables of many-to-many links
        if (t.type && t.type !== 'table') {
          this.skip(t.title, `database ${t.type} is not migrated`);
          return false;
        }
        return true;
      })
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const nocoTables = await mapConcurrent(tableSummaries, 4, (t) => this.client.getTable(t.id));
    this.log(`Found ${nocoTables.length} tables`, 0.05, 'Creating tables');

    // ---- create base + tables with stored fields
    const base = createBase(this.input.userId, { title: title || 'NocoDB import' });
    this.baseId = base.id;
    for (const t of nocoTables) this.createTableWithStoredColumns(t);
    this.log(`Created ${this.tables.size} tables`, 0.12, 'Creating links');

    // ---- links, then lookups/rollups/formulas
    this.createLinks();
    this.createVirtualColumns();
    this.log('Created fields', 0.2, 'Copying records');

    // ---- records
    const states = [...this.tables.values()];
    for (const [i, t] of states.entries()) {
      await this.copyRecords(t);
      this.log(`${t.noco.title}: ${t.rowMap.size} records`, 0.2 + (0.5 * (i + 1)) / states.length);
    }

    // ---- links between records
    this.log('Copying links', 0.7, 'Copying links');
    for (const [i, r] of this.relations.entries()) {
      await this.copyLinks(r);
      this.log(`${r.table.noco.title}.${r.col.title}: links copied`, 0.7 + (0.2 * (i + 1)) / this.relations.length);
    }

    // ---- views
    this.log('Copying views', 0.9, 'Copying views');
    for (const t of states) await this.copyViews(t);

    return {
      baseId: base.id,
      tables: this.tables.size,
      records: this.counts.records,
      links: this.counts.links,
      views: this.counts.views,
      skipped: this.skipped,
      converted: this.converted,
    };
  }

  // ------------------------------------------------------------ schema

  private takenTitles(ourTableId: string): Set<string> {
    return new Set(getTable(ourTableId).columns.map((c) => c.title.toLowerCase()));
  }

  private createTableWithStoredColumns(noco: NocoTable) {
    const cols = [...noco.columns].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const plans = new Map(cols.map((c) => [c.id, planColumn(c)] as const));
    const pk = cols.find((c) => truthy(c.pk));
    const where = (c: NocoColumn) => `${noco.title}.${c.title}`;

    // Primary (display) column: NocoDB's pv when it's a stored field, else the first text-like stored field.
    const storedCols = cols.filter((c) => plans.get(c.id)!.kind === 'stored');
    const textual: FieldType[] = ['SingleLineText', 'LongText', 'Email', 'URL', 'PhoneNumber'];
    const primary =
      storedCols.find((c) => truthy(c.pv)) ??
      storedCols.find((c) => {
        const p = plans.get(c.id)!;
        return p.kind === 'stored' && textual.includes(p.type);
      });

    const toInput = (c: NocoColumn, title: string, isPrimary = false): NewColumn => {
      const p = plans.get(c.id) as Extract<ColumnPlan, { kind: 'stored' }>;
      return {
        title,
        type: p.type,
        options: p.options,
        ...(isPrimary ? { primary: true } : {}),
        ...(c.description ? { description: c.description } : {}),
      };
    };

    const table = createTable(this.baseId!, { title: noco.title, columns: primary ? [toInput(primary, primary.title, true)] : [] });
    const state: TableState = {
      noco,
      ourId: table.id,
      pkTitle: pk?.title ?? 'Id',
      plans,
      renames: new Map(),
      stored: [],
      rowMap: new Map(),
    };
    this.tables.set(noco.id, state);

    const systemCol = (type: FieldType) => table.columns.find((c) => c.type === type);
    if (primary) {
      const ours = table.columns.find((c) => c.primary) ?? table.columns.find((c) => c.title === primary.title);
      if (ours) this.mapStored(state, primary, ours);
    }

    for (const c of cols) {
      const p = plans.get(c.id)!;
      if (p.kind === 'skip') {
        if (p.systemTarget) {
          const sys = systemCol(p.systemTarget);
          if (sys) this.colMap.set(c.id, { id: sys.id, type: sys.type });
        }
        if (!p.silent) this.skip(where(c), p.reason);
        continue;
      }
      if (p.kind !== 'stored' || c === primary) continue;
      const title = uniqueTitle(c.title, this.takenTitles(state.ourId));
      if (title !== c.title) {
        state.renames.set(c.title, title);
        this.converted.push(`${where(c)}: renamed to "${title}" (name already used)`);
      }
      try {
        const ours = addColumn(state.ourId, toInput(c, title));
        this.mapStored(state, c, ours);
        if (p.note) this.converted.push(`${where(c)}: ${p.note}`);
      } catch (err) {
        this.skip(where(c), `could not create field (${(err as Error).message})`);
      }
    }
  }

  private mapStored(state: TableState, c: NocoColumn, ours: Column) {
    this.colMap.set(c.id, { id: ours.id, type: ours.type });
    state.stored.push({ nocoTitle: c.title, ourId: ours.id, type: ours.type, sourceUidt: c.uidt });
  }

  private createLinks() {
    type Side = { table: TableState; col: NocoColumn; relation: RelationType; related: TableState; note?: string };
    const sides: Side[] = [];
    for (const t of this.tables.values()) {
      for (const c of t.noco.columns) {
        const p = t.plans.get(c.id);
        if (p?.kind !== 'link') continue;
        const related = this.tables.get(p.relatedTableId);
        if (!related) {
          this.skip(`${t.noco.title}.${c.title}`, 'links to a table that was not migrated');
          continue;
        }
        sides.push({ table: t, col: c, relation: p.relation, related, note: p.note });
      }
    }

    // Pair the two sides of each relation.
    const complement: Record<RelationType, RelationType> = { mm: 'mm', hm: 'bt', bt: 'hm' };
    const groups: Side[][] = [];
    const byKey = new Map<string, Side[]>();
    const unkeyed: Side[] = [];
    for (const s of sides) {
      const k = relationKey(s.col);
      if (k) byKey.set(k, [...(byKey.get(k) ?? []), s]);
      else unkeyed.push(s);
    }
    groups.push(...byKey.values());
    const used = new Set<Side>();
    for (const s of unkeyed) {
      if (used.has(s)) continue;
      used.add(s);
      const other = unkeyed.find(
        (o) => !used.has(o) && o.table === s.related && o.related === s.table && o.relation === complement[s.relation] && o.col !== s.col,
      );
      if (other) used.add(other);
      groups.push(other ? [s, other] : [s]);
    }

    for (const g of groups) {
      // Create from the has-many / many-to-many side; our engine adds the symmetric column.
      const creator = g.find((s) => s.relation === 'hm') ?? g.find((s) => s.relation === 'mm') ?? g[0]!;
      const other = g.find((s) => s !== creator && s.table === creator.related);
      const where = `${creator.table.noco.title}.${creator.col.title}`;
      const title = uniqueTitle(creator.col.title, this.takenTitles(creator.table.ourId));
      if (title !== creator.col.title) creator.table.renames.set(creator.col.title, title);
      let ours: Column;
      try {
        ours = addColumn(creator.table.ourId, {
          title,
          type: 'Links',
          options: { relatedTableId: creator.related.ourId, relation: creator.relation },
        });
      } catch (err) {
        this.skip(where, `could not create link (${(err as Error).message})`);
        continue;
      }
      if (creator.note) this.converted.push(`${where}: ${creator.note}`);
      this.colMap.set(creator.col.id, { id: ours.id, type: 'Links' });
      this.relations.push({ ...creator, ourColumnId: ours.id, hints: new Map() });

      const symId = ours.options?.symmetricColumnId;
      if (other && symId) {
        this.colMap.set(other.col.id, { id: symId, type: 'Links' });
        const sym = getTable(other.table.ourId).columns.find((c) => c.id === symId);
        if (sym && sym.title !== other.col.title) {
          const taken = this.takenTitles(other.table.ourId);
          taken.delete(sym.title.toLowerCase());
          const symTitle = uniqueTitle(other.col.title, taken);
          try {
            updateColumn(symId, { title: symTitle });
            if (symTitle !== other.col.title) other.table.renames.set(other.col.title, symTitle);
          } catch {
            other.table.renames.set(other.col.title, sym.title);
          }
        }
      }
    }
  }

  private createVirtualColumns() {
    type Pending = { table: TableState; col: NocoColumn; plan: Extract<ColumnPlan, { kind: 'lookup' | 'rollup' | 'formula' }> };
    let pending: Pending[] = [];
    for (const t of this.tables.values()) {
      for (const c of [...t.noco.columns].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
        const p = t.plans.get(c.id);
        if (p && (p.kind === 'lookup' || p.kind === 'rollup' || p.kind === 'formula')) pending.push({ table: t, col: c, plan: p });
      }
    }
    const pendingIds = () => new Set(pending.map((p) => p.col.id));
    const where = (p: Pending) => `${p.table.noco.title}.${p.col.title}`;

    const add = (p: Pending, input: NewColumn): Column | null => {
      const title = uniqueTitle(p.col.title, this.takenTitles(p.table.ourId));
      if (title !== p.col.title) p.table.renames.set(p.col.title, title);
      try {
        const ours = addColumn(p.table.ourId, { ...input, title });
        this.colMap.set(p.col.id, { id: ours.id, type: ours.type });
        return ours;
      } catch (err) {
        if (title !== p.col.title) p.table.renames.delete(p.col.title);
        throw err;
      }
    };

    /** Formulas our engine rejects keep NocoDB's computed values as text. */
    const formulaFallback = (p: Pending, reason: string) => {
      try {
        const ours = add(p, { title: p.col.title, type: 'LongText' });
        if (ours) p.table.stored.push({ nocoTitle: p.col.title, ourId: ours.id, type: 'LongText', sourceUidt: 'Formula' });
        this.converted.push(`${where(p)}: formula kept as text of its current values (${reason})`);
      } catch (err) {
        this.skip(where(p), `could not create field (${(err as Error).message})`);
      }
    };

    for (let round = 0; pending.length && round < 50; round++) {
      const next: Pending[] = [];
      const waiting = pendingIds();
      let progressed = false;
      for (const p of pending) {
        if (p.plan.kind === 'lookup' || p.plan.kind === 'rollup') {
          const target = p.plan.kind === 'lookup' ? p.plan.lookupColumnId : p.plan.rollupColumnId;
          const rel = this.colMap.get(p.plan.relationColumnId);
          const tgt = this.colMap.get(target);
          if (rel && tgt) {
            try {
              add(p, {
                title: p.col.title,
                type: p.plan.kind === 'lookup' ? 'Lookup' : 'Rollup',
                options:
                  p.plan.kind === 'lookup'
                    ? { linkColumnId: rel.id, targetColumnId: tgt.id }
                    : { linkColumnId: rel.id, targetColumnId: tgt.id, rollupFunction: p.plan.rollupFunction },
              });
              if (p.plan.kind === 'rollup' && p.plan.note) this.converted.push(`${where(p)}: ${p.plan.note}`);
            } catch (err) {
              this.skip(where(p), `could not create ${p.plan.kind} (${(err as Error).message})`);
            }
            progressed = true;
          } else if ((!rel && !waiting.has(p.plan.relationColumnId)) || (!tgt && !waiting.has(target))) {
            this.skip(where(p), `${p.plan.kind} depends on a field that was not migrated`);
            progressed = true;
          } else next.push(p);
          continue;
        }
        // Formula: wait while it references a field that is still pending.
        const byTitle = new Map(p.table.noco.columns.map((c) => [c.title, c.id] as const));
        const deps = formulaRefs(p.plan.formula).map((r) => byTitle.get(r) ?? r.replace(/^\{|\}$/g, ''));
        if (deps.some((id) => id !== p.col.id && waiting.has(id))) {
          next.push(p);
          continue;
        }
        progressed = true;
        const titleById = new Map(p.table.noco.columns.map((c) => [c.id, c.title] as const));
        const formula = rewriteFormula(p.plan.formula, titleById, p.table.renames);
        try {
          add(p, { title: p.col.title, type: 'Formula', options: { formula } });
        } catch (err) {
          formulaFallback(p, (err as Error).message);
        }
      }
      pending = next;
      if (!progressed) break;
    }
    // Whatever is left depends on itself or on each other.
    for (const p of pending) {
      if (p.plan.kind === 'formula') formulaFallback(p, 'circular reference');
      else this.skip(where(p), `${p.plan.kind} has a circular dependency`);
    }
  }

  // ------------------------------------------------------------ records

  private pkOf(row: NocoRecord, pkTitle: string): string | null {
    const v = row[pkTitle] ?? row.Id ?? row.id ?? row.ID;
    return v === undefined || v === null ? null : String(v);
  }

  private async copyRecords(t: TableState) {
    const ctx = { baseUrl: this.client.baseUrl };
    const rels = this.relations.filter((r) => r.table === t);
    for await (const page of this.client.iterateRecords(t.noco.id)) {
      const rows = page.map((rec) => {
        const row: Record<string, unknown> = {};
        for (const f of t.stored) {
          const v = convertValue(f.sourceUidt, f.type, rec[f.nocoTitle], ctx);
          if (v !== undefined) row[f.ourId] = v;
        }
        return row;
      });
      const created = insertRecords(t.ourId, rows, this.ctx);
      page.forEach((rec, i) => {
        const pk = this.pkOf(rec, t.pkTitle);
        const ours = created[i];
        if (pk === null || !ours) return;
        t.rowMap.set(pk, ours.id);
        for (const r of rels) if (r.col.title in rec) r.hints.set(pk, rec[r.col.title]);
      });
      this.counts.records += created.length;
    }
  }

  /** NocoDB pks of linked records known from the list response, or null when they must be fetched. */
  private linkedFromHint(hint: unknown, relatedPk: string): string[] | null {
    if (hint === undefined) return null;
    if (hint === null || hint === '' || hint === 0 || hint === '0') return [];
    if (typeof hint === 'number' || typeof hint === 'string') return null; // a count
    const list = Array.isArray(hint) ? hint : [hint];
    const pks: string[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') return null;
      const pk = this.pkOf(item as NocoRecord, relatedPk);
      if (pk === null) return null;
      pks.push(pk);
    }
    return pks;
  }

  private async copyLinks(r: Relation) {
    const entries = [...r.table.rowMap.entries()];
    await mapConcurrent(entries, 4, async ([nocoPk, ourId]) => {
      let pks = this.linkedFromHint(r.hints.get(nocoPk), r.related.pkTitle);
      if (pks === null) {
        const linked = await this.client.listLinks(r.table.noco.id, r.col.id, nocoPk);
        pks = linked.map((rec) => this.pkOf(rec, r.related.pkTitle)).filter((v): v is string => v !== null);
      }
      const ids = pks.map((pk) => r.related.rowMap.get(pk)).filter((v): v is number => v !== undefined);
      if (!ids.length) return;
      linkRecords(r.ourColumnId, ourId, r.relation === 'bt' ? ids.slice(0, 1) : ids, this.ctx);
      this.counts.links += ids.length;
    });
  }

  // ------------------------------------------------------------ views

  private async copyViews(t: TableState) {
    let views: NocoView[];
    try {
      views = await this.client.listViews(t.noco.id);
    } catch (err) {
      this.skip(`${t.noco.title} views`, (err as Error).message);
      return;
    }
    views = [...views].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const defaultNoco = views.find((v) => truthy(v.is_default)) ?? views.find((v) => mapViewType(v.type) === 'grid');
    let defaultOurs = getTable(t.ourId).views?.find((v) => v.type === 'grid');

    for (const v of views) {
      const where = `${t.noco.title} / view "${v.title}"`;
      const type = mapViewType(v.type);
      if (!type) {
        this.skip(where, `${viewTypeName(v.type)} views are not supported`);
        continue;
      }
      try {
        let ours: View;
        if (v === defaultNoco && defaultOurs && type === 'grid') {
          ours = defaultOurs;
          defaultOurs = undefined;
        } else {
          ours = createView(t.ourId, { title: v.title, type });
        }
        await this.applyView(t, v, type, ours, where);
        this.counts.views++;
      } catch (err) {
        this.skip(where, (err as Error).message);
      }
    }
  }

  private async applyView(t: TableState, v: NocoView, type: View['type'], ours: View, where: string) {
    const [filters, sorts, vcols] = await Promise.all([
      this.client.getFilters(v.id).catch(() => []),
      this.client.getSorts(v.id).catch(() => []),
      this.client.getViewColumns(v.id).catch((): NocoViewColumn[] => []),
    ]);
    const detailKind = ({ kanban: 'kanbans', gallery: 'galleries', form: 'forms', calendar: 'calendars', map: 'maps', grid: null, timeline: null } as const)[type];
    const details = { ...(v.view ?? {}), ...((detailKind ? await this.client.getViewDetails(detailKind, v.id) : null) ?? {}) } as Record<string, unknown>;

    const f = mapFilters(filters, this.colMap);
    const s = mapSorts(sorts, this.colMap);
    for (const note of new Set([...f.skipped, ...s.skipped])) this.skip(where, note);

    // Column visibility / order / width (+ form labels).
    const formCols = Array.isArray(details.columns) ? (details.columns as NocoViewColumn[]) : [];
    const formById = new Map(formCols.map((c) => [c.fk_column_id, c] as const));
    const nocoByOurId = new Map<string, NocoViewColumn>();
    for (const vc of vcols.length ? vcols : formCols) {
      const mapped = this.colMap.get(vc.fk_column_id);
      if (mapped && !nocoByOurId.has(mapped.id)) nocoByOurId.set(mapped.id, { ...formById.get(vc.fk_column_id), ...vc });
    }
    const current = getView(ours.id);
    const existing = current.columns.length ? current.columns : getTable(t.ourId).columns.map((c, i) => ({ columnId: c.id, show: true, order: i }));
    const merged: ViewColumn[] = existing.map((c) => {
      const n = nocoByOurId.get(c.columnId);
      if (!n) return { ...c, order: 100_000 + c.order };
      const out: ViewColumn = { ...c, show: truthy(n.show), order: n.order ?? c.order };
      const width = parseWidth(n.width);
      if (width) out.width = width;
      if (type === 'form') {
        if (n.label) out.label = n.label;
        if (n.description) out.help = n.description;
        if (n.required !== undefined) out.required = truthy(n.required);
      }
      return out;
    });
    merged.sort((a, b) => a.order - b.order).forEach((c, i) => (c.order = i));

    const meta: ViewMeta = { ...current.meta };
    const ref = (id: unknown) => (typeof id === 'string' ? this.colMap.get(id)?.id : undefined);
    if (type === 'grid') {
      const groupBy: Sort[] = vcols
        .filter((c) => truthy(c.group_by) && this.colMap.has(c.fk_column_id))
        .sort((a, b) => (a.group_by_order ?? 0) - (b.group_by_order ?? 0))
        .slice(0, 3)
        .map((c) => ({ columnId: this.colMap.get(c.fk_column_id)!.id, direction: c.group_by_sort === 'desc' ? 'desc' : 'asc' }));
      if (groupBy.length) meta.groupBy = groupBy;
    }
    if (type === 'kanban') {
      const grp = ref(details.fk_grp_col_id);
      if (grp) meta.groupColumnId = grp;
      else this.skip(where, 'kanban grouping field was not migrated');
      const cover = ref(details.fk_cover_image_col_id);
      if (cover) meta.coverColumnId = cover;
      const km = parseMeta(details.meta);
      const stacks = typeof details.fk_grp_col_id === 'string' ? km[details.fk_grp_col_id] : undefined;
      if (Array.isArray(stacks)) {
        const order = (stacks as { title?: string; order?: number }[])
          .filter((x) => typeof x?.title === 'string' && x.title !== 'Uncategorized')
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((x) => x.title!);
        if (order.length) meta.stackOrder = order;
      }
    }
    if (type === 'gallery') {
      const cover = ref(details.fk_cover_image_col_id);
      if (cover) meta.coverColumnId = cover;
    }
    if (type === 'calendar') {
      const range = Array.isArray(details.calendar_range) ? (details.calendar_range as Record<string, unknown>[]) : [];
      const from = ref(range[0]?.fk_from_column_id);
      const to = ref(range[0]?.fk_to_column_id);
      if (from) meta.dateColumnId = from;
      else this.skip(where, 'calendar date field was not migrated');
      if (to) meta.endDateColumnId = to;
    }
    if (type === 'map') {
      const geo = ref(details.fk_geo_data_col_id);
      if (geo) meta.geoColumnId = geo;
      else this.skip(where, 'map location field was not migrated');
    }
    if (type === 'form') {
      if (typeof details.heading === 'string') meta.formHeading = details.heading;
      if (typeof details.subheading === 'string') meta.formSubheading = details.subheading;
      if (typeof details.success_msg === 'string') meta.formSubmitMessage = details.success_msg;
      if (typeof details.redirect_url === 'string' && details.redirect_url) meta.formRedirectUrl = details.redirect_url;
    }

    const patch: { title: string; locked: boolean; filter: FilterGroup | null; sorts: Sort[]; columns: ViewColumn[]; meta: ViewMeta } = {
      title: v.title,
      locked: v.lock_type === 'locked',
      filter: f.filter,
      sorts: s.sorts,
      columns: merged,
      meta,
    };
    try {
      updateView(ours.id, patch);
    } catch (err) {
      // Retry without the type-specific settings, which are the likeliest to be rejected.
      updateView(ours.id, { ...patch, meta: current.meta });
      this.skip(where, `view settings not applied (${(err as Error).message})`);
    }
  }
}
