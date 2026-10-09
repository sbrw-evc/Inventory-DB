# Inventory DB

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
- UI follows the Umbrella monitoring design ([docs/design.md](docs/design.md)), in English and Russian.
- Swagger UI at `/api/v1/docs`.

See [docs/plan.md](docs/plan.md) for the feature plan and [docs/api.md](docs/api.md) for the REST API.

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
(tests; defaults to `DATABASE_URL`), `PORT` (8080), `JWT_SECRET` (set in production), `UPLOAD_DIR` (`data/uploads`),
`WEBHOOK_ALLOW_PRIVATE=1` (let webhooks call private/internal addresses; off by default).

The schema is created and migrated on startup.

## Deployment (Docker Compose)

```bash
cp .env.example .env               # set JWT_SECRET and POSTGRES_PASSWORD
docker compose up -d --build       # app on http://localhost:8080 (INVENTORY_PORT to change)
docker compose logs -f inventory-db
```

Compose runs two containers: `postgres` (PostgreSQL 16, not published outside the Compose network) and
`inventory-db`, which builds the server and the web app and serves both. The database lives in the named volume
`postgres-data` and uploaded attachments (`/data/uploads`) in `inventory-data`, so both survive
`docker compose down`, rebuilds and upgrades; only `docker compose down -v` deletes them.

Upgrade: `git pull && docker compose up -d --build`.

Backup and restore:

```bash
docker compose exec -T postgres pg_dump -U inventory -Fc inventory > inventory.dump
docker compose exec -T postgres pg_restore -U inventory -d inventory --clean --if-exists < inventory.dump
```

