# Sign-in and access are managed in Keystone

Ledger keeps no passwords, no password policy, no passkeys and no directory or sign-in provider settings.
People sign in with **Keystone**
([sbrw-evc/keystone](https://github.com/sbrw-evc/keystone)),
which also decides who may use Ledger and with which role. The contract is Keystone's
[docs/protocol.md](https://github.com/sbrw-evc/keystone/blob/HEAD/docs/protocol.md); this
page says how Ledger follows it. Keystone was called SPA before; the Keystone protocol keeps that historical spelling
in its identifiers (`spa1.`, `SPA_CONNECTION_KEY`, `SPA_PUBLIC_URL`, `/api/auth/spa/*`, the OpenBao key
`spa/connection_key`), and so do the routes of Ledger built on it.

## Connecting

1. In Keystone: **Applications → Connect an application**, type **Ledger**, the address people open Ledger at
   (`https://inventory.example.com`). The redirect address is `<address>/api/auth/spa/callback`, the address after
   sign-out is `<address>/`.
2. Give Ledger's roles to people or groups (rules *user or group → role*). People without a role cannot sign in.
3. Copy the **connection key** (`spa1.…`, shown once) and give it to Ledger, one of:
   - the environment variable `SPA_CONNECTION_KEY` (`.env` / `docker-compose.yml`);
   - a file named by `SPA_CONNECTION_KEY_FILE`;
   - the secret store: OpenBao path `spa`, key `connection_key` (in the `inventory` mount).

   Optional: `SPA_PUBLIC_URL` — the address of Ledger when it differs from the request address (behind a proxy
   that does not send `X-Forwarded-Host` / `X-Forwarded-Proto`).

Until it is connected, the sign-in page says "This application is not connected to Keystone" with these steps. There is no
"first administrator" of Ledger any more: administrators are the people Keystone gives the `admin` role. **Issue a
new key** in Keystone replaces the old one at once; put the new key in place and restart Ledger.

## Roles

Ledger publishes its role catalogue to Keystone (`PUT /api/spa/v1/roles`) at start and with **Synchronize now**:

| role | |
| --- | --- |
| `admin` | everything in DCIM/IPAM, integrations and the Settings section |
| `editor` | creates and changes DCIM/IPAM objects |
| `viewer` | reads DCIM/IPAM (the suggested default) |

When Keystone gives several of them, the highest counts. Base membership (owner / editor / commenter / viewer of each
base) is data of Ledger and stays here: base owners share their bases as before.

## Sign-in

- `GET /api/auth/spa/start?return=<path>` (optional `login_hint`, `idp_hint`, `prompt=login`) — creates `state`,
  `nonce` and a PKCE verifier, keeps the verifier in an HttpOnly cookie (`SameSite=Lax`, `Secure` on https, path
  `/api/auth/spa/`, 10 minutes) bound to the signed state and goes to Keystone's `/oauth2/authorize` with
  `scope=openid profile email groups roles` and `code_challenge_method=S256`.
- `GET /api/auth/spa/callback` — checks the state (signed, single use) against the cookie, redeems the code with the
  verifier, verifies the ID token (RS256 signature from the issuer's JWKS, `iss`, `aud`, `exp`, `nonce`), finds or
  creates the user bound to `sub` and starts Ledger's own session (a JWT, `SESSION_HOURS`, 12 by default).
  Errors go to the sign-in page as `/signin?sso_error=…`.
- The sign-in page has one button, **Sign in with Keystone**, and goes to Keystone by itself when there is no session (not
  right after signing out, and not when Keystone sent an error).
- **Sign out** (user menu) ends the session here and goes to `GET /api/auth/spa/logout`, which redirects to Keystone's
  `sign_out_url` with `post_logout_redirect_uri=<address>/`.
- **Account and security** in the user menu opens Keystone's `account_url`: passwords and passkeys are changed there.

## Users

Every 5 minutes (one replica: the one holding a PostgreSQL advisory lock), at start and with **Synchronize now** on
*Settings → Keystone*, Ledger reads `GET /api/spa/v1/config` and `GET /api/spa/v1/users` (with ETags) and:

- creates or updates the user bound to Keystone's user ID (`source = 'spa'`, `external_id`), with user name, name, e-mail
  and the DCIM/IPAM role from `roles`;
- disables users Keystone marks disabled, users without a role of Ledger and users missing from the list — their
  sessions end and their API tokens are **suspended** (kept, refused while the person is disabled; see below);
- users from before Keystone (local, LDAP, Entra ID, Beacon accounts) keep their IDs, base memberships, ownership and
  history: each is bound **once**, on the first synchronization or Keystone sign-in, by **user name only**
  (case-insensitive), as Keystone's protocol and Current and Beacon do; from then on only by `sub`.
  E-mail is never used for binding — it is not verified as unique across the sources Keystone reads — so an old record
  without a user name, or whose user name differs from the one in Keystone, is not bound: it is disabled by the first
  successful synchronization, and the person gets a new record (base memberships are shared again by the owners).

The first sign-in of a person the synchronization has not seen yet creates the user from the ID token. Users are
read-only in Ledger (*Settings → Keystone* lists them, "Managed in Keystone"); `POST/PUT /api/v1/netbox/roles` answer
409 `MANAGED_IN_SPA`.

API tokens (`xc-token`) stay in Ledger for scripts and integrations; each belongs to a person from Keystone. When Keystone
disables that person, takes away their role here or drops them from the list, their tokens are **suspended**, not
deleted: requests with them answer 401 while the person is disabled, and the same tokens work again once Keystone enables
the person (with a role here) and the next synchronization or Keystone sign-in sees it. Sessions are different: they stay
ended, the person signs in again. `GET /api/v1/tokens` returns `suspended` (and `suspendedAt`) for each token, the
*API tokens* page shows *Suspended*, and *Settings → Keystone → Users* shows each user's tokens and how many are
suspended. A token is deleted only when its owner deletes it.

## Settings → Keystone

Issuer, application, client ID, where the key comes from, the redirect address, sign-in methods, the account page,
when the role catalogue was published, the last synchronization and its counts and errors, **Synchronize now**, and
the users with their roles. API: `GET /api/v1/settings/spa`, `POST /api/v1/settings/spa/sync`,
`GET /api/v1/settings/spa/users` (admin role); public: `GET /api/v1/auth/spa` (`{connected, issuer, application}`).

## Upgrading from built-in sign-in

The migration that comes with this version drops password hashes, password history, passkeys and the LDAP, Entra
ID, Google / Apple / OpenID Connect and Umbrella Identity settings (and their secrets kept in the database; delete
`directory/*` and `identity/*` from OpenBao by hand if you used it). Existing sessions end: everyone signs in again
with Keystone.
