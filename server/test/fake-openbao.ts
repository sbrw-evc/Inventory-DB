/** A stand-in OpenBao for tests: token / AppRole sign-in, health and a KV v2 engine kept in memory. */
import Fastify, { type FastifyInstance } from 'fastify';

export interface FakeOpenBao {
  url: string;
  token: string;
  roleId: string;
  secretId: string;
  /** mount -> path -> data */
  store: Map<string, Map<string, Record<string, string>>>;
  close(): Promise<void>;
}

export async function startFakeOpenBao(opts: { mounts?: string[]; token?: string } = {}): Promise<FakeOpenBao> {
  const token = opts.token ?? 'root-token';
  const roleId = 'role-1';
  const secretId = 'secret-1';
  const issued = new Set([token]);
  const store = new Map((opts.mounts ?? ['inventory']).map((m) => [m, new Map<string, Record<string, string>>()]));
  const app: FastifyInstance = Fastify();
  const authed = (h: unknown) => typeof h === 'string' && issued.has(h);

  app.get('/v1/sys/health', async () => ({ initialized: true, sealed: false, standby: false, version: '2.7.1', cluster_name: 'fake' }));
  app.post('/v1/auth/approle/login', async (req, reply) => {
    const b = req.body as { role_id?: string; secret_id?: string };
    if (b.role_id !== roleId || b.secret_id !== secretId) return reply.status(400).send({ errors: ['invalid role or secret ID'] });
    const t = `s.approle-${issued.size}`;
    issued.add(t);
    return { auth: { client_token: t, lease_duration: 3600, renewable: true, policies: ['default', 'inventory'] } };
  });
  app.get('/v1/auth/token/lookup-self', async (req, reply) => {
    if (!authed(req.headers['x-vault-token'])) return reply.status(403).send({ errors: ['permission denied'] });
    return { data: { ttl: 3600, renewable: true, policies: ['default', 'inventory'] } };
  });
  app.post('/v1/auth/token/renew-self', async (req, reply) => {
    if (!authed(req.headers['x-vault-token'])) return reply.status(403).send({ errors: ['permission denied'] });
    return { auth: { lease_duration: 3600, renewable: true } };
  });

  const route = (url: string) => {
    const m = /^\/v1\/([^/]+)\/(data|metadata)\/?(.*?)(\?.*)?$/.exec(url);
    if (!m) return null;
    return { mount: m[1], kind: m[2], path: decodeURIComponent(m[3]).replace(/\/+$/, ''), list: (m[4] ?? '').includes('list=true') };
  };
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/v1/*',
    handler: async (req, reply) => {
      if (!authed(req.headers['x-vault-token'])) return reply.status(403).send({ errors: ['permission denied'] });
      const r = route(req.url);
      const mount = r && store.get(r.mount);
      if (!r || !mount) return reply.status(404).send({ errors: [`no handler for route "${req.url}"`] });
      if (r.kind === 'data' && req.method === 'GET') {
        const data = mount.get(r.path);
        return data ? { data: { data, metadata: { version: 1 } } } : reply.status(404).send({ errors: [] });
      }
      if (r.kind === 'data' && req.method === 'POST') {
        mount.set(r.path, { ...(req.body as { data: Record<string, string> }).data });
        return { data: { version: 1 } };
      }
      if (r.kind === 'metadata' && req.method === 'DELETE') {
        mount.delete(r.path);
        return reply.status(204).send();
      }
      if (r.kind === 'metadata' && r.list) {
        const prefix = r.path ? `${r.path}/` : '';
        const keys = new Set<string>();
        for (const p of mount.keys()) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          keys.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
        }
        return keys.size ? { data: { keys: [...keys].sort() } } : reply.status(404).send({ errors: [] });
      }
      return reply.status(405).send({ errors: ['unsupported'] });
    },
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { url, token, roleId, secretId, store, close: () => app.close() };
}
