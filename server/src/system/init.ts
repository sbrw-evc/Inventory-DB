/**
 * Startup: connect to OpenBao (when configured), find the database (settings file or DATABASE_URL), move secrets
 * kept by older versions into the secret store and load the session signing key.
 */
import { randomBytes } from 'node:crypto';
import { setJwtSecret } from '../auth/service.js';
import { configureDatabase, getDb } from '../db/index.js';
import { moveLegacySecrets } from '../integrations/store.js';
import { configuredOpenBao, postgresUrl, readConfig } from './config.js';
import { logEvent } from './logbuf.js';
import { PG_PASSWORD_SECRET } from './postgres.js';
import { getSecret, moveLocalSecretsToOpenBao, secretBackend, setSecret, useOpenBao } from './secrets.js';

const JWT_SECRET_PATH = 'system/jwt';

export async function initSystem(log: (msg: string) => void = console.log) {
  const file = readConfig();
  const bao = configuredOpenBao();
  if (bao) {
    const waitMs = Number(process.env.OPENBAO_WAIT_SECONDS ?? 120) * 1000;
    log(`Connecting to OpenBao at ${bao.addr} (mount ${bao.mount})`);
    await useOpenBao(bao, waitMs);
  }
  if (file.postgres) {
    const password = file.postgres.password_in === 'openbao' ? await getSecret(PG_PASSWORD_SECRET, 'password') : (file.postgres.password ?? '');
    if (password === null) throw new Error(`The PostgreSQL password is not in OpenBao (${PG_PASSWORD_SECRET})`);
    configureDatabase(postgresUrl(file.postgres, password));
  }
  getDb();

  const legacy = await moveLegacySecrets();
  if (legacy) logEvent('warn', 'Moved integration secrets into the secret store', { count: legacy, store: secretBackend() });
  if (secretBackend() === 'openbao') await moveLocalSecretsToOpenBao();

  if (process.env.JWT_SECRET) setJwtSecret(process.env.JWT_SECRET);
  else {
    let key = await getSecret(JWT_SECRET_PATH, 'secret');
    if (!key) {
      key = randomBytes(32).toString('hex');
      await setSecret(JWT_SECRET_PATH, { secret: key });
      log(`Generated the session signing key (${secretBackend() === 'openbao' ? 'in OpenBao' : 'in the database'})`);
    }
    setJwtSecret(key);
  }
  if (secretBackend() === 'local') logEvent('warn', 'OpenBao is not configured: secrets are kept encrypted in the database');
}
