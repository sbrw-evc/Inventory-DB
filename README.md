# Inventory DB

A NocoDB-style "spreadsheet on top of a database" app, focused on inventory management.

See [docs/plan.md](docs/plan.md) for the feature plan and [docs/api.md](docs/api.md) for the REST API.

## Development

```bash
npm install
npm run dev        # API on :8080, web on :5173 (proxies /api)
npm test
npm run build && npm start   # serves the built web app from the API server
```

Environment: `PORT` (8080), `DB_PATH` (`data/inventory.db`), `JWT_SECRET` (set in production),
`UPLOAD_DIR` (`data/uploads`).
