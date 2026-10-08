import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dataColumnName, dataTableName, getDb, newId, now, q } from '../src/db/index.js';

/**
 * Seeds a base/table/columns/view straight into the meta tables (no data engine needed),
 * plus a physical data table so record-existence checks work.
 */
export function seedBase(ownerId: string, opts: { columns?: { title: string; type: string }[] } = {}) {
  const db = getDb();
  const baseId = newId('b');
  const tableId = newId('tbl');
  const viewId = newId('vw');
  db.prepare('INSERT INTO nc_bases (id, title, created_at) VALUES (?, ?, ?)').run(baseId, 'Test base', now());
  db.prepare("INSERT INTO nc_base_members (base_id, user_id, role) VALUES (?, ?, 'owner')").run(baseId, ownerId);
  db.prepare('INSERT INTO nc_tables (id, base_id, title, created_at) VALUES (?, ?, ?, ?)').run(tableId, baseId, 'Products', now());
  const defs = opts.columns ?? [
    { title: 'Name', type: 'SingleLineText' },
    { title: 'Qty', type: 'Number' },
    { title: 'Status', type: 'SingleSelect' },
    { title: 'Updated', type: 'LastModifiedTime' },
  ];
  const columns = defs.map((d, i) => {
    const id = newId('col');
    db.prepare('INSERT INTO nc_columns (id, table_id, title, type, is_primary, "order", created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      tableId,
      d.title,
      d.type,
      i === 0 ? 1 : 0,
      i,
      now(),
    );
    return { id, ...d };
  });
  db.prepare("INSERT INTO nc_views (id, table_id, title, type, created_at) VALUES (?, ?, 'Grid', 'grid', ?)").run(viewId, tableId, now());
  db.exec(`CREATE TABLE ${q(dataTableName(tableId))} (id INTEGER PRIMARY KEY, ${columns.map((c) => `${q(dataColumnName(c.id))} TEXT`).join(', ')})`);
  const insertRow = (id: number) => db.prepare(`INSERT INTO ${q(dataTableName(tableId))} (id) VALUES (?)`).run(id);
  const col = (title: string) => columns.find((c) => c.title === title)!.id;
  return { baseId, tableId, viewId, columns, col, insertRow };
}

export function addMember(baseId: string, userId: string, role: string) {
  getDb().prepare('INSERT INTO nc_base_members (base_id, user_id, role) VALUES (?, ?, ?)').run(baseId, userId, role);
}

export interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** Local HTTP receiver on an ephemeral port. `respond` controls the status code. */
export async function startReceiver(respond: (r: Received) => number = () => 200) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const r: Received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: data ? JSON.parse(data) : null };
      received.push(r);
      res.statusCode = respond(r);
      res.end('ok from receiver');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Builds a multipart/form-data body for `app.inject`. */
export function multipart(fields: Record<string, string>, file?: { name: string; content: Buffer | string; type?: string; field?: string }) {
  const boundary = `----test${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
