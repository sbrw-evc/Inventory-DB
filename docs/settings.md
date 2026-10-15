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

Every secret goes through one store: integration signing secrets and Umbrella Flow API tokens, the LDAP service account password, the Entra ID
client secret, the PostgreSQL password (once the database was moved from the PostgreSQL page) and the session signing
key (unless `JWT_SECRET` is set).

- With OpenBao configured, secrets live in its KV v2 mount (`inventory` by default), at paths such as
  `integrations/<id>` (`signing_secret`, plus `flow_token` for Umbrella Flow), `directory/ldap`, `directory/entra`, `system/postgres`, `system/jwt`.
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

Register an application (App registrations → New registration), add the redirect URI shown on the Directories page
(`https://<host>/api/v1/auth/entra/callback`) as a Web platform URI and create a client secret. Sign-in uses the
authorization code flow with PKCE; group membership comes from the token's `groups` claim or, for users in many
groups, from Microsoft Graph (needs `GroupMember.Read.All`). An optional users group limits who may sign in.

A directory account never takes over a local account with the same email (and the reverse).

## Single sign-in (Umbrella Identity)

*Settings → Single sign-in* joins Inventory DB to the Umbrella family: Umbrella Monitoring is the identity hub, and
Umbrella Flow, Inventory DB and Network Control share its users, password policy and passkeys
([identity-federation.md](identity-federation.md) is the protocol).

1. **Address of Inventory DB** — the address people open; providers and Umbrella send people back to it.
2. **Umbrella single sign-in** — in Umbrella Monitoring connect Inventory DB (*Settings → Sign-in and Umbrella
   Identity → Connected applications*), copy the connection key and go through the three steps here: paste the key
   (Inventory DB checks the hub, the client secret and the token), map Umbrella roles and groups to the
   administrator / editor / viewer roles, connect. Every 5 minutes (and with **Synchronise now**) accounts are
   created, updated and disabled as in Umbrella; the password policy and passkeys come from the hub when those
   options are on. The sign-in page shows **Sign in with Umbrella** and a button for every method of the hub (passkey,
   Active Directory, Microsoft, Google, Apple…). Disconnecting disables the accounts from Umbrella.
3. **Passkeys** — sign-in with Windows Hello (face, fingerprint, iris, PIN), Touch ID / Face ID, Android biometrics
   or a security key (WebAuthn with user verification). People add passkeys in the account menu → **Passkeys**. A
   parent domain as the passkey domain lets the same passkeys work on its subdomains; with Umbrella connected on a
   subdomain of the hub's passkey domain, the passkeys registered in Umbrella work here too.
4. **Google, Apple, OpenID Connect** — the redirect address to register is shown on each card; secrets (client secret,
   Apple `.p8` key) go to the secret store. Google and Apple need the allowed e-mail domains (or "only existing
   accounts"); an OpenID Connect provider (Keycloak, ADFS, Okta, Authentik…) can map an administrators group from
   a groups claim. A person is bound to the provider's subject; an existing account with the same verified e-mail is
   signed in.

## Password policy

Minimum length, digits, special characters, upper and lower case, allowed alphabets, blocking of common passwords,
password history, maximum age with a warning before expiry, and account lockout after wrong passwords — the same
policy JSON as in Umbrella Monitoring, Umbrella Flow and Network Control. The defaults are Umbrella's (12 characters
with a digit, a special character and both cases, Latin letters, the last 5 passwords, lockout for 15 minutes after
10 wrong passwords). The policy applies to local accounts when a password is set or changed. A user whose password
expired is asked for a new one at sign-in; the user menu has **Change password** and warns before expiry. With
Umbrella connected and "Use the password policy of Umbrella" on, the page is read-only and shows the hub's policy.

## PostgreSQL

The page shows the connection and live counters (pg_stat_database, table sizes, running operations and, with
`pg_stat_statements`, the top statements). **Move to another database** checks the target, copies all tables in one
transaction (Inventory DB does not answer requests while it copies), saves the connection to the settings file and
switches over. The previous database is left unchanged.
