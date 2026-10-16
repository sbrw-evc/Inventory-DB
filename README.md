# Ledger

*Formerly **Inventory DB**. Ledger, part of the Umbrella family: inventory (DCIM/IPAM) and spreadsheet databases.*

The other members of the family: [Keystone](https://github.com/sbrw-evc/keystone) (sign-in and access; formerly SPA),
[Beacon](https://github.com/sbrw-evc/beacon) (alerts from monitoring systems become incidents, paging and response;
formerly Umbrella Monitoring), [Current](https://github.com/sbrw-evc/current) (network traffic and network devices;
formerly Umbrella Flow) and Network Control.

A NocoDB-style "spreadsheet on top of a database" app, focused on inventory management.

Features:

- **Spreadsheet database (NocoDB-style):** bases, tables, 24 field types including links, lookup, rollup and
  formula; grid, form, gallery, kanban and calendar views with nested filters, sorts, grouping and search.
- **Collaboration:** base members with owner/editor/commenter/viewer roles, comments, audit history, API
  tokens (`xc-token`), webhooks, public shared views and forms.
- **Data in/out:** CSV/XLSX/JSON import with type inference, CSV/XLSX export, an Inventory starter template,
  and **Migrate from NocoDB** (copies a whole base from a NocoDB instance via its API).
- **DCIM/IPAM (NetBox core):** sites, racks with elevation, devices, interfaces, cables with trace, prefixes
  with utilisation and next free IP, IP addresses, VLANs, VRFs, tenants, tags, custom fields, change log, and a
  NetBox-compatible REST API ([docs/netbox.md](docs/netbox.md)).
- **Sign-in and access are managed in Keystone**: Ledger keeps no passwords,
  passkeys or directory settings; people sign in with Keystone and get their DCIM/IPAM role there
  ([docs/keystone.md](docs/keystone.md)).
- **Settings (administrators):** system status, the Keystone connection with its users, PostgreSQL connection, statistics
  and moving to another server, and the OpenBao secret store ([docs/settings.md](docs/settings.md)).
- **Integrations:** Beacon (CMDB feed, alert states on devices) and Current (traffic on devices,
  interfaces and circuits with 24 h sparklines and 95th percentile vs commit, active addresses of prefixes, signed
  change notifications) — [docs/integrations.md](docs/integrations.md).
- UI follows the Beacon design ([docs/design.md](docs/design.md)), in English and Russian.
- Swagger UI at `/api/v1/docs`.

See [docs/plan.md](docs/plan.md) for the feature plan and [docs/api.md](docs/api.md) for the REST API.
Business processes inside Ledger: [docs/processes.md](docs/processes.md); between the applications of the family: [family.md](https://github.com/sbrw-evc/current/blob/HEAD/docs/family.md).

## Development

The app stores everything in PostgreSQL (14 or newer). For development, start one with the default credentials:

```bash
docker run -d --name inventory-pg -p 5432:5432 \
  -e POSTGRES_USER=inventory -e POSTGRES_PASSWORD=inventory -e POSTGRES_DB=inventory postgres:16-alpine
npm install
npm run dev        # API on :8080, web on :5173 (proxies /api)
npm test           # each test file runs in its own temporary schema
npm run build && npm start   # serves the built web app from the API server
```

Environment: `DATABASE_URL` (`postgres://inventory:inventory@localhost:5432/inventory`), `TEST_DATABASE_URL`
(tests; defaults to `DATABASE_URL`), `PORT` (8080), `SPA_CONNECTION_KEY` / `SPA_CONNECTION_KEY_FILE` and
`SPA_PUBLIC_URL` (sign-in with Keystone, [docs/keystone.md](docs/keystone.md)), `SESSION_HOURS` (12), `JWT_SECRET` (set in production), `UPLOAD_DIR` (`data/uploads`),
`WEBHOOK_ALLOW_PRIVATE=1` (let webhooks call private/internal addresses; off by default), `CONFIG_DIR`
(`data/config`, the settings file), and the `OPENBAO_*` variables of [docs/settings.md](docs/settings.md).

The schema is created and migrated on startup.

## Deployment (Docker Compose)

```bash
cp .env.example .env               # set POSTGRES_PASSWORD
docker compose up -d --build       # app on http://localhost:8080 (INVENTORY_PORT to change)
docker compose logs -f ledger
```

Compose runs four containers:

- `postgres` (PostgreSQL 16, not published outside the Compose network);
- `openbao` (OpenBao 2.7, the secret store; its UI and API on `127.0.0.1:8200`, see `OPENBAO_BIND`);
- `openbao-init`, which initialises OpenBao on the first start, unseals it after every restart, enables the KV v2
  mount `inventory` and AppRole, and hands Ledger its AppRole `role_id` / `secret_id`;
- `ledger`, which builds the server and the web app and serves both.

The database lives in the named volume `postgres-data`, OpenBao's data in `openbao-data`, uploaded attachments
(`/data/uploads`) and the settings file (`/data/config`) in `inventory-data`, so all survive `docker compose down`,
rebuilds and upgrades; only `docker compose down -v` deletes them.

**OpenBao's unseal keys and root token are written to `secrets/openbao/init.txt`.** Back that folder up and keep
it private: without it OpenBao cannot be unsealed and every secret is lost. To unseal by hand instead, set
`OPENBAO_AUTO_UNSEAL=false`.

## Sign-in and access

Sign-in and access are managed in Keystone — [sbrw-evc/keystone](https://github.com/sbrw-evc/keystone)
(contract: its [docs/protocol.md](https://github.com/sbrw-evc/keystone/blob/HEAD/docs/protocol.md)).
To connect: in Keystone open **Applications → Connect an application**, choose **Ledger**, enter its address and give
its roles (`admin`, `editor`, `viewer`) to people or groups; put the connection key (`spa1.…`) into
`SPA_CONNECTION_KEY` in `.env` and run `docker compose up -d`. People with Keystone's `admin` role for Ledger see the
**Settings** group of the menu. Details: [docs/keystone.md](docs/keystone.md).

Upgrade: `git pull && docker compose up -d --build`.

Backup and restore:

```bash
docker compose exec -T postgres pg_dump -U inventory -Fc inventory > inventory.dump
docker compose exec -T postgres pg_restore -U inventory -d inventory --clean --if-exists < inventory.dump
```

Back up `secrets/openbao/` and the `openbao-data` volume together with the database.


## Compatibility after the rename

Ledger was called Inventory DB. The product, the npm packages (`ledger`, `@ledger/shared`, `@ledger/server`,
`@ledger/web`), the Docker image (`ledger`), the compose project and service (`ledger`) carry the new name, and the
other apps are called Keystone, Beacon and Current. These identifiers keep the old spelling on purpose, because
existing installations and the other apps depend on them:

| kept | why |
| --- | --- |
| the Keystone protocol: `SPA_CONNECTION_KEY`, `SPA_CONNECTION_KEY_FILE`, `SPA_PUBLIC_URL`, the key prefix `spa1.`, `/api/auth/spa/start`, `/api/auth/spa/callback`, `/api/auth/spa/logout`, the OpenBao key `spa` → `connection_key` | the wire format between Keystone and its applications (Keystone's `docs/protocol.md`) |
| environment variables `INVENTORY_PORT`, `OPENBAO_*`, `DATABASE_URL`, `TEST_DATABASE_URL`, … | existing deployments |
| the PostgreSQL database and user `inventory`, table names, the compose volumes `inventory-db_postgres-data`, `inventory-db_inventory-data`, `inventory-db_openbao-data`, `inventory-db_openbao-approle` | existing data |
| the OpenBao mount `inventory`, the policy and AppRole `inventory-db` (`deploy/openbao`) | existing secrets |
| the settings file `inventory.json`, the cookie `idb_spa`, API tokens `xc-token`, the `localStorage` keys `inventorydb.*` | existing settings, sessions, tokens and preferences |
| HTTP headers `x-inventory-signature`, `x-inventory-timestamp`, `x-umbrella-signature`, `x-umbrella-timestamp` | signed webhooks and alert states already configured in Beacon and Current |
| the source references `inventory-db:…` and `"source": "inventory-db"` of the CMDB feed | CIs stored in Beacon and Current |
| the API paths `/api/v1/integrations/umbrella/*`, `/api/v1/integrations/:id/umbrella/*`, `/api/v1/integrations/flow/*`, `/api/integrations/inventory-db/*` (in Current), `/api/v1/settings/spa*`; the JSON fields `umbrellaUrl` and the other integration settings | Beacon, Current and API clients |

The settings page `/settings/spa` moved to `/settings/keystone`; the old address redirects. The webhook user agent is now
`Ledger-Webhook/1.0`. The GitHub repository is to be renamed to `sbrw-evc/ledger`; GitHub redirects the old address.
