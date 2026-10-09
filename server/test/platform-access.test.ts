import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { authPlugin } from '../src/auth/plugin.js';
import { getDb } from '../src/db/index.js';
import { registerDocs } from '../src/platform/docs.js';
import { platformRoutes } from '../src/routes/platform.js';
import { createTestApp, signUpUser } from './helpers.js';
import { addMember, multipart, seedBase } from './platform-fixtures.js';

beforeAll(() => {
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'invdb-uploads-'));
});

describe('members', () => {
  it('lists, invites, changes roles and protects the last owner', async () => {
    const app = await createTestApp();
    const owner = await signUpUser(app, 'owner@example.com');
    const other = await signUpUser(app, 'other@example.com');
    const { baseId } = seedBase(owner.userId);
    const url = `/api/v1/bases/${baseId}/members`;

    const missing = await app.inject({ method: 'POST', url, headers: owner.headers, payload: { email: 'nobody@example.com', role: 'editor' } });
    expect(missing.statusCode).toBe(404);

    const inv = await app.inject({ method: 'POST', url, headers: owner.headers, payload: { email: 'OTHER@example.com', role: 'viewer' } });
    expect(inv.statusCode).toBe(200);
    expect(inv.json()).toMatchObject({ userId: other.userId, role: 'viewer' });
    const dup = await app.inject({ method: 'POST', url, headers: owner.headers, payload: { email: 'other@example.com', role: 'viewer' } });
    expect(dup.statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url, headers: other.headers });
    expect(list.json().map((m: { email: string }) => m.email)).toEqual(['owner@example.com', 'other@example.com']);

    // viewers can't manage members
    const denied = await app.inject({ method: 'PATCH', url: `${url}/${owner.userId}`, headers: other.headers, payload: { role: 'viewer' } });
    expect(denied.statusCode).toBe(403);

    // last owner can't be demoted or removed
    const demote = await app.inject({ method: 'PATCH', url: `${url}/${owner.userId}`, headers: owner.headers, payload: { role: 'editor' } });
    expect(demote.statusCode).toBe(400);
    expect(demote.json().error).toBe('LAST_OWNER');
    const remove = await app.inject({ method: 'DELETE', url: `${url}/${owner.userId}`, headers: owner.headers });
    expect(remove.statusCode).toBe(400);

    // promote the other user, then demoting the first owner is allowed
    const promote = await app.inject({ method: 'PATCH', url: `${url}/${other.userId}`, headers: owner.headers, payload: { role: 'owner' } });
    expect(promote.json().role).toBe('owner');
    const demote2 = await app.inject({ method: 'PATCH', url: `${url}/${owner.userId}`, headers: owner.headers, payload: { role: 'editor' } });
    expect(demote2.json().role).toBe('editor');

    // a member can leave by themselves
    const leave = await app.inject({ method: 'DELETE', url: `${url}/${owner.userId}`, headers: owner.headers });
    expect(leave.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url, headers: owner.headers });
    expect(after.statusCode).toBe(404);
  });
});

describe('api tokens', () => {
  it('creates a token shown once, authenticates with xc-token, lists and revokes', async () => {
    const app = await createTestApp();
    const u = await signUpUser(app);
    const created = await app.inject({ method: 'POST', url: '/api/v1/tokens', headers: u.headers, payload: { description: 'CI' } });
    const { id, token } = created.json();
    expect(token).toMatch(/^nc_/);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'xc-token': token } });
    expect(me.json().user.id).toBe(u.userId);

    const list = await app.inject({ method: 'GET', url: '/api/v1/tokens', headers: u.headers });
    expect(list.json()).toEqual([{ id, description: 'CI', createdAt: expect.any(String) }]);

    const other = await signUpUser(app);
    const stolen = await app.inject({ method: 'DELETE', url: `/api/v1/tokens/${id}`, headers: other.headers });
    expect(stolen.statusCode).toBe(404);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/tokens/${id}`, headers: u.headers });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'xc-token': token } });
    expect(after.statusCode).toBe(401);
  });
});

describe('files', () => {
  it('uploads and serves a file; requires editor access somewhere', async () => {
    const app = await createTestApp();
    const u = await signUpUser(app);
    const mp = multipart({}, { name: 'hello.txt', content: 'hello world', type: 'text/plain' });

    const noBase = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...u.headers, ...mp.headers }, payload: mp.payload });
    expect(noBase.statusCode).toBe(403);

    seedBase(u.userId);
    const res = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...u.headers, ...mp.headers }, payload: mp.payload });
    expect(res.statusCode).toBe(200);
    const att = res.json();
    expect(att).toMatchObject({ title: 'hello.txt', mimetype: 'text/plain', size: 11 });
    expect(att.url).toMatch(/^\/api\/v1\/files\/fil_/);

    const get = await app.inject({ method: 'GET', url: att.url });
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe('hello world');
    expect(get.headers['content-type']).toContain('text/plain');
    expect(get.headers['x-content-type-options']).toBe('nosniff');

    // HTML is never served inline
    const html = multipart({}, { name: 'x.html', content: '<script>alert(1)</script>', type: 'text/html' });
    const up = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...u.headers, ...html.headers }, payload: html.payload });
    const served = await app.inject({ method: 'GET', url: up.json().url });
    expect(served.headers['content-type']).toBe('application/octet-stream');
    expect(served.headers['content-disposition']).toMatch(/^attachment/);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/files/fil_nope' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('comments', () => {
  it('lists, adds (commenter+) and deletes (author or owner)', async () => {
    const app = await createTestApp();
    const owner = await signUpUser(app);
    const commenter = await signUpUser(app);
    const viewer = await signUpUser(app);
    const s = seedBase(owner.userId);
    addMember(s.baseId, commenter.userId, 'commenter');
    addMember(s.baseId, viewer.userId, 'viewer');
    s.insertRow(1);
    const url = `/api/v1/tables/${s.tableId}/records/1/comments`;

    const byViewer = await app.inject({ method: 'POST', url, headers: viewer.headers, payload: { body: 'hi' } });
    expect(byViewer.statusCode).toBe(403);
    const noRecord = await app.inject({ method: 'POST', url: `/api/v1/tables/${s.tableId}/records/99/comments`, headers: commenter.headers, payload: { body: 'x' } });
    expect(noRecord.statusCode).toBe(404);

    const c1 = (await app.inject({ method: 'POST', url, headers: commenter.headers, payload: { body: 'First' } })).json();
    expect(c1).toMatchObject({ body: 'First', recordId: 1, userId: commenter.userId, userName: expect.any(String) });
    const c2 = (await app.inject({ method: 'POST', url, headers: owner.headers, payload: { body: 'Second' } })).json();

    const list = await app.inject({ method: 'GET', url, headers: viewer.headers });
    expect(list.json().map((c: { body: string }) => c.body)).toEqual(['First', 'Second']);

    const notAuthor = await app.inject({ method: 'DELETE', url: `/api/v1/comments/${c2.id}`, headers: commenter.headers });
    expect(notAuthor.statusCode).toBe(403);
    const byOwner = await app.inject({ method: 'DELETE', url: `/api/v1/comments/${c1.id}`, headers: owner.headers });
    expect(byOwner.statusCode).toBe(200);
    const byAuthor = await app.inject({ method: 'DELETE', url: `/api/v1/comments/${c2.id}`, headers: owner.headers });
    expect(byAuthor.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, headers: viewer.headers })).json()).toEqual([]);
  });
});

describe('sharing (no data engine needed)', () => {
  it('enables/disables sharing and enforces the password before anything else', async () => {
    const app = await createTestApp();
    const owner = await signUpUser(app);
    const viewer = await signUpUser(app);
    const s = seedBase(owner.userId);
    addMember(s.baseId, viewer.userId, 'viewer');
    const url = `/api/v1/views/${s.viewId}/share`;

    expect((await app.inject({ method: 'POST', url, headers: viewer.headers, payload: {} })).statusCode).toBe(403);

    const shared = await app.inject({ method: 'POST', url, headers: owner.headers, payload: { password: 'secret1' } });
    const { shareUuid, passwordSet } = shared.json();
    expect(passwordSet).toBe(true);
    const row = getDb().prepare('SELECT share_password_hash FROM nc_views WHERE id = ?').get(s.viewId) as { share_password_hash: string };
    expect(row.share_password_hash).not.toContain('secret1');

    const noPw = await app.inject({ method: 'GET', url: `/api/v1/public/views/${shareUuid}` });
    expect(noPw.statusCode).toBe(401);
    expect(noPw.json().error).toBe('PASSWORD_REQUIRED');
    const badPw = await app.inject({ method: 'GET', url: `/api/v1/public/views/${shareUuid}/records`, headers: { 'xc-password': 'nope' } });
    expect(badPw.json().error).toBe('PASSWORD_REQUIRED');

    // re-sharing keeps the uuid; null clears the password
    const again = await app.inject({ method: 'POST', url, headers: owner.headers, payload: { password: null } });
    expect(again.json()).toEqual({ shareUuid, passwordSet: false });

    await app.inject({ method: 'DELETE', url, headers: owner.headers });
    const gone = await app.inject({ method: 'GET', url: `/api/v1/public/views/${shareUuid}` });
    expect(gone.statusCode).toBe(404);
  });
  it('locks out a client after repeated wrong share passwords', async () => {
    const app = await createTestApp();
    const owner = await signUpUser(app);
    const s = seedBase(owner.userId);
    const shared = await app.inject({ method: 'POST', url: `/api/v1/views/${s.viewId}/share`, headers: owner.headers, payload: { password: 'secret1' } });
    const meta = `/api/v1/public/views/${shared.json().shareUuid}`;

    const ok = await app.inject({ method: 'GET', url: meta, headers: { 'xc-password': 'secret1' } });
    expect(ok.statusCode).toBe(200);
    for (let i = 0; i < 10; i++) {
      const bad = await app.inject({ method: 'GET', url: meta, headers: { 'xc-password': `wrong${i}` } });
      expect(bad.statusCode).toBe(401);
    }
    const locked = await app.inject({ method: 'GET', url: meta, headers: { 'xc-password': 'secret1' } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe('TOO_MANY_ATTEMPTS');
  });
});

describe('openapi docs', () => {
  it('serves the spec including platform routes with tags', async () => {
    const app = Fastify();
    await registerDocs(app);
    await authPlugin(app);
    await app.register(platformRoutes);
    await app.ready();
    const spec = await app.inject({ method: 'GET', url: '/api/v1/docs/json' });
    expect(spec.statusCode).toBe(200);
    const body = spec.json();
    expect(body.openapi).toMatch(/^3\./);
    expect(body.paths['/api/v1/jobs/{jobId}'].get.tags).toEqual(['Jobs']);
    expect(body.paths['/api/v1/tables/{tableId}/hooks']).toBeDefined();
    const ui = await app.inject({ method: 'GET', url: '/api/v1/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.body).toContain('swagger');
  });
});
