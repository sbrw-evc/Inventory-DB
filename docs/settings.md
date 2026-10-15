# Settings

The **Settings** group of the menu is for DCIM/IPAM administrators — people SPA gives Inventory DB's `admin` role
([spa.md](spa.md)). It follows the settings section of Umbrella Monitoring and has four pages.

| Page | Path | What it does |
| --- | --- | --- |
| System status | `/settings/status` | Version, runtime, OpenBao, PostgreSQL, the SPA connection, integrations, counts and the latest warnings and errors. |
| SPA | `/settings/spa` | The SPA connection (issuer, application, last synchronization, counts, errors), **Synchronize now** and the users from SPA (read-only). |
| PostgreSQL | `/settings/postgresql` | The connection, live statistics and moving all data to another PostgreSQL. |
| OpenBao | `/settings/openbao` | The secret store, the stored secrets (names only) and moving to another OpenBao. |

The API behind them is under `/api/v1/settings/*` and `GET /api/v1/system/status`; all of it needs the admin role.

## Secrets and OpenBao

Every secret goes through one store: integration signing secrets and Umbrella Flow API tokens, the SPA connection key
(when it is not given in the environment), the PostgreSQL password (once the database was moved from the PostgreSQL page) and the session signing
key (unless `JWT_SECRET` is set).

- With OpenBao configured, secrets live in its KV v2 mount (`inventory` by default), at paths such as
  `integrations/<id>` (`signing_secret`, plus `flow_token` for Umbrella Flow), `spa` (`connection_key`), `system/postgres`, `system/jwt`.
- Without OpenBao, they are kept AES-256-GCM encrypted in the `nc_secrets` table under `INTEGRATION_KEY` (or
  `JWT_SECRET`). In production the server refuses to start with neither OpenBao nor one of those keys.
- Secrets kept in the database are moved to OpenBao automatically at startup once OpenBao is configured, and can be
  moved from the OpenBao page.
- When OpenBao is configured but does not answer, startup waits `OPENBAO_WAIT_SECONDS` (120) and then fails rather
  than run without its secrets.

OpenBao is configured by environment variables, or by the settings file once an administrator connects or moves to
another OpenBao from the OpenBao page (the file wins):

| Variable | Meaning |
| --- | --- |
| `OPENBAO_ADDR` | Address, e.g. `http://openbao:8200`. Turns OpenBao on. |
| `OPENBAO_MOUNT` | KV v2 mount (`inventory`). |
| `OPENBAO_NAMESPACE` | Namespace, if any. |
| `OPENBAO_TOKEN` / `OPENBAO_TOKEN_FILE` | Token sign-in. |
| `OPENBAO_ROLE_ID` / `_FILE`, `OPENBAO_SECRET_ID` / `_FILE` | AppRole sign-in (used by Docker Compose). |
| `OPENBAO_APPROLE_PATH` | AppRole mount (`approle`). |
| `OPENBAO_CACERT` / `OPENBAO_CACERT_PEM` | CA certificate (file path / PEM) for an OpenBao on your own CA. |
| `OPENBAO_SKIP_VERIFY=1` | Do not check the certificate (testing only). |

The policy Inventory DB needs is [deploy/openbao/inventory-policy.hcl](../deploy/openbao/inventory-policy.hcl).

## Settings file

`CONFIG_DIR/inventory.json` (`/data/config` in Docker, mode 0600) holds what must be known before the database is
open: the OpenBao connection and the PostgreSQL connection after a move. The PostgreSQL password is in OpenBao
(`system/postgres`) when it is configured, otherwise in the file.

## Sign-in and access

Sign-in and access are managed in SPA (Single Point of Authorization): passwords, the password policy, passkeys,
LDAP / Active Directory, Microsoft Entra ID, Google, Apple and other sign-in providers, and who gets which role in
Inventory DB. See [spa.md](spa.md) for how Inventory DB connects to SPA.

## PostgreSQL

The page shows the connection and live counters (pg_stat_database, table sizes, running operations and, with
`pg_stat_statements`, the top statements). **Move to another database** checks the target, copies all tables in one
transaction (Inventory DB does not answer requests while it copies), saves the connection to the settings file and
switches over. The previous database is left unchanged.
