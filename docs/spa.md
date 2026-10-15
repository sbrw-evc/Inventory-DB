# Sign-in and access are managed in SPA

Inventory DB keeps no passwords, no password policy, no passkeys and no directory or sign-in provider settings.
People sign in with **SPA — Single Point of Authorization**
([sbrw-evc/SPA-Single-point-of-authorization-](https://github.com/sbrw-evc/SPA-Single-point-of-authorization-)),
which also decides who may use Inventory DB and with which role. The contract is SPA's
[docs/protocol.md](https://github.com/sbrw-evc/SPA-Single-point-of-authorization-/blob/main/docs/protocol.md); this
page says how Inventory DB follows it.

## Connecting

1. In SPA: **Applications → Connect an application**, type **Inventory DB**, the address people open Inventory DB at
   (`https://inventory.example.com`). The redirect address is `<address>/api/auth/spa/callback`, the address after
   sign-out is `<address>/`.
2. Give Inventory DB's roles to people or groups (rules *user or group → role*). People without a role cannot sign in.
3. Copy the **connection key** (`spa1.…`, shown once) and give it to Inventory DB, one of:
   - the environment variable `SPA_CONNECTION_KEY` (`.env` / `docker-compose.yml`);
   - a file named by `SPA_CONNECTION_KEY_FILE`;
   - the secret store: OpenBao path `spa`, key `connection_key` (in the `inventory` mount).

   Optional: `SPA_PUBLIC_URL` — the address of Inventory DB when it differs from the request address (behind a proxy
   that does not send `X-Forwarded-Host` / `X-Forwarded-Proto`).

Until it is connected, the sign-in page says "This application is not connected to SPA" with these steps. There is no
"first administrator" of Inventory DB any more: administrators are the people SPA gives the `admin` role. **Issue a
new key** in SPA replaces the old one at once; put the new key in place and restart Inventory DB.

## Roles

Inventory DB publishes its role catalogue to SPA (`PUT /api/spa/v1/roles`) at start and with **Synchronize now**:

| role | |
| --- | --- |
| `admin` | everything in DCIM/IPAM, integrations and the Settings section |
| `editor` | creates and changes DCIM/IPAM objects |
| `viewer` | reads DCIM/IPAM (the suggested default) |

When SPA gives several of them, the highest counts. Base membership (owner / editor / commenter / viewer of each
base) is data of Inventory DB and stays here: base owners share their bases as before.

## Sign-in

- `GET /api/auth/spa/start?return=<path>` (optional `login_hint`, `idp_hint`, `prompt=login`) — creates `state`,
  `nonce` and a PKCE verifier, keeps the verifier in an HttpOnly cookie (`SameSite=Lax`, `Secure` on https, path
  `/api/auth/spa/`, 10 minutes) bound to the signed state and goes to SPA's `/oauth2/authorize` with
  `scope=openid profile email groups roles` and `code_challenge_method=S256`.
- `GET /api/auth/spa/callback` — checks the state (signed, single use) against the cookie, redeems the code with the
  verifier, verifies the ID token (RS256 signature from the issuer's JWKS, `iss`, `aud`, `exp`, `nonce`), finds or
  creates the user bound to `sub` and starts Inventory DB's own session (a JWT, `SESSION_HOURS`, 12 by default).
  Errors go to the sign-in page as `/signin?sso_error=…`.
- The sign-in page has one button, **Sign in with SPA**, and goes to SPA by itself when there is no session (not
  right after signing out, and not when SPA sent an error).
- **Sign out** (user menu) ends the session here and goes to `GET /api/auth/spa/logout`, which redirects to SPA's
  `sign_out_url` with `post_logout_redirect_uri=<address>/`.
- **Account and security** in the user menu opens SPA's `account_url`: passwords and passkeys are changed there.

## Users

Every 5 minutes (one replica: the one holding a PostgreSQL advisory lock), at start and with **Synchronize now** on
*Settings → SPA*, Inventory DB reads `GET /api/spa/v1/config` and `GET /api/spa/v1/users` (with ETags) and:

- creates or updates the user bound to SPA's user ID (`source = 'spa'`, `external_id`), with user name, name, e-mail
  and the DCIM/IPAM role from `roles`;
- disables users SPA marks disabled, users without a role of Inventory DB and users missing from the list — their
  sessions end and their API tokens are revoked;
- users from before SPA (local, LDAP, Entra ID, Umbrella accounts) keep their IDs, base memberships, ownership and
  history: each is bound **once**, on the first synchronization or SPA sign-in, by user name and then by e-mail; from
  then on only by `sub`. Old users no SPA user matched are disabled by the first successful synchronization.

The first sign-in of a person the synchronization has not seen yet creates the user from the ID token. Users are
read-only in Inventory DB (*Settings → SPA* lists them, "Managed in SPA"); `POST/PUT /api/v1/netbox/roles` answer
409 `MANAGED_IN_SPA`.

API tokens (`xc-token`) stay in Inventory DB for scripts and integrations; each belongs to a person from SPA and stops
working when SPA disables that person.

## Settings → SPA

Issuer, application, client ID, where the key comes from, the redirect address, sign-in methods, the account page,
when the role catalogue was published, the last synchronization and its counts and errors, **Synchronize now**, and
the users with their roles. API: `GET /api/v1/settings/spa`, `POST /api/v1/settings/spa/sync`,
`GET /api/v1/settings/spa/users` (admin role); public: `GET /api/v1/auth/spa` (`{connected, issuer, application}`).

## Upgrading from built-in sign-in

The migration that comes with this version drops password hashes, password history, passkeys and the LDAP, Entra
ID, Google / Apple / OpenID Connect and Umbrella Identity settings (and their secrets kept in the database; delete
`directory/*` and `identity/*` from OpenBao by hand if you used it). Existing sessions end: everyone signs in again
with SPA.
