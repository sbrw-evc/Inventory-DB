# Settings

The **Settings** group of the menu is for DCIM/IPAM administrators (the first account that signs in becomes one).
It follows the settings section of Umbrella Monitoring and has five pages.

| Page | Path | What it does |
| --- | --- | --- |
| System status | `/settings/status` | Version, runtime, OpenBao, PostgreSQL, LDAP / AD, Entra ID, integrations, counts, password policy and the latest warnings and errors. |
| Sign-in | `/settings/directory` | LDAP / Active Directory and Microsoft Entra ID sign-in. |
| Password policy | `/settings/password-policy` | Rules for local account passwords. |
| PostgreSQL | `/settings/postgresql` | The connection, live statistics and moving all data to another PostgreSQL. |
| OpenBao | `/settings/openbao` | The secret store, the stored secrets (names only) and moving to another OpenBao. |

The API behind them is under `/api/v1/settings/*` and `GET /api/v1/system/status`; all of it needs the admin role.

## Secrets and OpenBao

Every secret goes through one store: integration signing secrets, the LDAP service account password, the Entra ID
client secret, the PostgreSQL password (once the database was moved from the PostgreSQL page) and the session signing
key (unless `JWT_SECRET` is set).

- With OpenBao configured, secrets live in its KV v2 mount (`inventory` by default), at paths such as
  `integrations/<id>`, `directory/ldap`, `directory/entra`, `system/postgres`, `system/jwt`.
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

## LDAP / Active Directory

The service account binds, searches the user under the search base with the user filter (`{username}` is replaced
with the escaped name typed at sign-in), then the user's own password is checked with a second bind. Members of the
administrators group (nested groups are followed on AD) get the admin role; it is taken back when they leave the
group, unless it was given by hand. The sign-in field accepts an email of a local account or a directory user name;
local accounts are checked first.

## Microsoft Entra ID

Register an application (App registrations → New registration), add the redirect URI shown on the Sign-in page
(`https://<host>/api/v1/auth/entra/callback`) as a Web platform URI and create a client secret. Sign-in uses the
authorization code flow with PKCE; group membership comes from the token's `groups` claim or, for users in many
groups, from Microsoft Graph (needs `GroupMember.Read.All`). An optional users group limits who may sign in.

A directory account never takes over a local account with the same email (and the reverse).

## Password policy

Minimum length, digits, special characters, upper and lower case, allowed alphabets, maximum age and a warning before
expiry; the defaults are Umbrella's (12 characters with a digit, a special character and both cases, Latin letters).
The policy applies to local accounts when a password is set or changed. A user whose password expired is asked for a
new one at sign-in; the user menu has **Change password** and warns before expiry.

## PostgreSQL

The page shows the connection and live counters (pg_stat_database, table sizes, running operations and, with
`pg_stat_statements`, the top statements). **Move to another database** checks the target, copies all tables in one
transaction (Inventory DB does not answer requests while it copies), saves the connection to the settings file and
switches over. The previous database is left unchanged.
