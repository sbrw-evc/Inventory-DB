import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Attachment } from '../../../shared/src/index.js';
import { requireUser } from '../auth/plugin.js';
import { getDb, newId, now } from '../db/index.js';
import { badRequest, forbidden, HttpError, notFound } from '../errors.js';
import { doc } from './docs.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const uploadDir = () => resolve(process.env.UPLOAD_DIR ?? 'data/uploads');

interface FileRow {
  id: string;
  title: string;
  mimetype: string | null;
  size: number | null;
  path: string;
  created_at: string;
}

export const fileUrl = (id: string) => `/api/v1/files/${id}`;

/** Types a browser could execute if served inline from our origin. */
const ACTIVE_CONTENT = /html|xml|svg|javascript|ecmascript/i;

export async function fileRoutes(app: FastifyInstance) {
  app.post('/api/v1/files', { schema: doc('Files', 'Upload a file (multipart field "file", max 50MB) → Attachment') }, async (req) => {
    const user = requireUser(req);
    const canEdit = getDb()
      .prepare("SELECT 1 FROM nc_base_members WHERE user_id = ? AND role IN ('owner','editor') LIMIT 1")
      .get(user.id);
    if (!canEdit) throw forbidden('Uploading requires editor access to a base');

    const part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!part) throw badRequest('Missing file');
    const id = newId('fil');
    const dir = uploadDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, id);
    try {
      await pipeline(part.file, createWriteStream(path));
    } catch (err) {
      rmSync(path, { force: true });
      throw err;
    }
    if (part.file.truncated) {
      rmSync(path, { force: true });
      throw new HttpError(413, 'FILE_TOO_LARGE', 'File exceeds the 50MB limit');
    }
    const size = part.file.bytesRead;
    const row: FileRow = {
      id,
      title: basename(part.filename || 'file'),
      mimetype: part.mimetype || 'application/octet-stream',
      size,
      path: id,
      created_at: now(),
    };
    getDb()
      .prepare('INSERT INTO nc_files (id, title, mimetype, size, path, created_at) VALUES (@id, @title, @mimetype, @size, @path, @created_at)')
      .run(row);
    const att: Attachment = { url: fileUrl(id), title: row.title, mimetype: row.mimetype ?? undefined, size };
    return att;
  });

  app.get<{ Params: { fileId: string } }>(
    '/api/v1/files/:fileId',
    { schema: doc('Files', 'Download an uploaded file (public; ids are unguessable)') },
    async (req, reply) => {
      const row = getDb().prepare('SELECT * FROM nc_files WHERE id = ?').get(req.params.fileId) as FileRow | undefined;
      if (!row) throw notFound('File');
      const full = join(uploadDir(), basename(row.path));
      if (!existsSync(full)) throw notFound('File');
      const mime = row.mimetype || 'application/octet-stream';
      const active = ACTIVE_CONTENT.test(mime);
      const name = encodeURIComponent(row.title);
      reply
        .header('Content-Type', active ? 'application/octet-stream' : mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('Content-Disposition', `${active ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`);
      if (row.size != null) reply.header('Content-Length', row.size);
      return reply.send(createReadStream(full));
    },
  );
}
