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

```bash
npm install
npm run dev        # API on :8080, web on :5173 (proxies /api)
npm test
npm run build && npm start   # serves the built web app from the API server
```

Environment: `PORT` (8080), `DB_PATH` (`data/inventory.db`), `JWT_SECRET` (set in production),
`UPLOAD_DIR` (`data/uploads`), `WEBHOOK_ALLOW_PRIVATE=1` (let webhooks call private/internal addresses; off by default).

## Deployment (Docker Compose)

```bash
cp .env.example .env               # set JWT_SECRET (openssl rand -hex 32)
docker compose up -d --build       # app on http://localhost:8080 (INVENTORY_PORT to change)
docker compose logs -f inventory-db
```

The image builds the server and the web app and serves both from one container. The SQLite database
(`/data/inventory.db` plus its WAL files) and uploaded attachments (`/data/uploads`) live in the named volume
`inventory-data`, so they survive `docker compose down`, rebuilds and upgrades; only `docker compose down -v`
deletes them.

Upgrade: `git pull && docker compose up -d --build`.

Backup (consistent copy while the app runs):

```bash
docker compose exec inventory-db node -e "new (require('better-sqlite3'))('/data/inventory.db').backup('/data/backup.db').then(()=>console.log('ok'))"
docker compose cp inventory-db:/data/backup.db ./inventory-backup.db
```

