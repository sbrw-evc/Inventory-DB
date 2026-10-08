# Inventory DB: NocoDB-style feature plan

Status: approved by default, implementation in progress on branch `claude/project-thread-d8pw1i`.

## 1. Starting point

The repository `sbrw-evc/Inventory-DB` is empty (no commits). The app is therefore built from scratch as a
NocoDB-style "spreadsheet over a database" product, with an inventory starter template
(Products, Warehouses, Suppliers, Stock movements) so it is useful on day one.

## 2. NocoDB feature survey

Source: nocodb.com/docs/product-docs index plus NocoDB's public feature set.

| Area | NocoDB features |
|---|---|
| Structure | Workspaces, bases, tables, fields, records; sidebar folders |
| Field types | SingleLineText, LongText, RichText, Number, Decimal, Currency, Percent, Rating, Checkbox, Date, DateTime, Time, Year, Duration, Email, URL, PhoneNumber, SingleSelect, MultiSelect, Attachment, JSON, User, Links (has-many / many-to-many / belongs-to), Lookup, Rollup, Formula, Barcode, QRCode, AutoNumber, CreatedTime, LastModifiedTime, CreatedBy, LastModifiedBy, GeoData, Button |
| Views | Grid, Form, Gallery, Kanban, Calendar, Timeline/Gantt, List, Map |
| View toolbar | Field show/hide/reorder/width, filters (nested AND/OR groups), sorts, group by, search, row height, row colouring |
| View modes | Collaborative, locked, personal views |
| Records | Inline edit, expanded record, bulk update/delete, copy/paste, undo/redo, comments, record audit history |
| Sharing | Public shared views (optionally password protected), shared form, shared base |
| Access control | Roles at workspace/base level (owner, creator, editor, commenter, viewer), field- and record-level permissions |
| Data in/out | CSV / Excel / JSON import, CSV / Excel export, external DB sources (Postgres, MySQL, ...), snapshots |
| APIs | Auto-generated REST API per table, Swagger docs, API tokens, MCP server |
| Automation | Webhooks (after insert/update/delete), workflows, scripts |
| Extras | Dashboards/charts, interfaces, extensions, AI, docs, sync integrations |

## 3. Scope

### Built in this round (core)
1. **Bases, tables, fields** with CRUD and reordering.
2. **Field types**: SingleLineText, LongText, Number, Decimal, Currency, Percent, Rating, Checkbox,
   Date, DateTime, Email, URL, PhoneNumber, SingleSelect, MultiSelect, Attachment (URL/upload),
   JSON, AutoNumber (id), CreatedTime, LastModifiedTime, Links (many-to-many), Lookup, Rollup, Formula
   (arithmetic, comparison, string and date functions, IF/AND/OR).
3. **Records**: list with pagination, CRUD, bulk insert/update/delete, link/unlink.
4. **Query engine**: nested filter groups (AND/OR) with type-aware operators, multi-sort,
   group by, full-text search; works on lookup/rollup/formula fields too.
5. **Views**: Grid, Form, Gallery, Kanban, Calendar; each with its own filters/sorts/hidden fields/field
   order/widths; collaborative and locked modes.
6. **UI**: sidebar of bases/tables/views, grid with inline editing and keyboard navigation, expanded
   record drawer with comments and history, toolbar (fields, filter, sort, group, search), undo of last edit.
7. **Auth & roles**: email/password sign-up/in (JWT), base members with roles owner / editor /
   commenter / viewer enforced on every route, API tokens (`xc-token` header like NocoDB).
8. **REST API**: `/api/v1/...` meta + data endpoints, OpenAPI JSON + Swagger UI at `/api/docs`.
9. **Import/export**: CSV and XLSX import (new table or into existing table, type inference), CSV and XLSX
   export of a view (respects filters/sorts/hidden fields).
10. **Sharing**: public read-only link for a view, public shared form, optional password.
11. **Webhooks**: after insert/update/delete per table, with a delivery log.
12. **Audit log & comments** per record.
13. **Migrate from NocoDB**: connect to a NocoDB instance (cloud or self-hosted URL + API token), pick a
    base, and copy its tables, field definitions (mapped to our types, unsupported ones become text),
    select options, records, many-to-many/has-many links, and Grid/Form/Gallery/Kanban/Calendar views with
    their filters, sorts and hidden fields. Uses NocoDB's v2 REST API (`/api/v2/meta/...`,
    `/api/v2/tables/{id}/records`, links endpoints). Runs as a background job with progress and a
    report of anything skipped. NocoDB CSV exports also import through the regular CSV importer.
14. **NetBox core (DCIM/IPAM)**: a dedicated module with typed models and REST endpoints under
    `/api/v1/dcim` and `/api/v1/ipam`: regions, sites, locations, racks (with rack elevation), manufacturers,
    device types, device roles, platforms, devices, interfaces, cables (with path trace), tenants, VRFs,
    prefixes (hierarchy, utilisation, next available prefix/IP), IP addresses, IP ranges, VLAN groups and VLANs,
    tags, custom fields, change log, and CSV bulk import. UI pages for lists, detail panels, rack elevation,
    prefix tree, and cable trace.
15. **Design**: UI follows Umbrella's design language and application guidelines (`docs/design.md`):
    navy header, toolbar/filter rows, status chips, right-side detail panel, English/Russian UI,
    `/metrics` endpoint.
16. **Inventory template**: one-click base with Products, Suppliers, Warehouses, Stock movements,
    linked together with rollups (on-hand quantity) and formulas (stock value, low-stock flag).

### Deferred (and why)
- Timeline/Gantt, Map and List views: lower value for inventory; the view framework makes them additive later.
- Field/record-level permissions and personal views: role checks are base-level for now.
- External data sources (Postgres/MySQL connections) and snapshots: app uses its own SQLite database;
  the storage layer is isolated so Postgres can be added later.
- Workflows, scripts, dashboards, interfaces, extensions, AI, docs, sync integrations, MCP server.
- RichText, Barcode/QRCode, User, Duration, GeoData, Button field types.
- Backend language/database: Umbrella's guidelines prefer Go and PostgreSQL; this app stays on
  Node/TypeScript with SQLite for now, with storage isolated so PostgreSQL can be added later.
- NetBox extras: circuits, power, virtualization, wireless, VPN, journaling, config contexts, scripts/reports.
- Integrations between Inventory DB and Umbrella are built in the separate "Umbrella and Inventory integration" thread.
- Real-time collaboration (multi-cursor/websocket updates).

## 4. Architecture

```
/server   Node 22 + TypeScript, Fastify, better-sqlite3, zod, JWT
  src/db        meta schema (migrations) + data table DDL helpers
  src/meta      bases, tables, columns, views services
  src/data      record service, query compiler (filters/sorts/search/group), formula compiler
  src/auth      users, sessions, roles, API tokens
  src/platform  import/export, webhooks, audit, comments, sharing
  src/routes    REST routes + OpenAPI
/web      React 18 + Vite + TypeScript, TanStack Query, plain CSS
  src/api       typed client
  src/views     Grid, Form, Gallery, Kanban, Calendar
  src/components toolbar, cells/editors per field type, expanded record, sidebar
/shared   TypeScript types shared by server and web (field types, filter ops, API DTOs)
```

**Storage model.** Metadata lives in `nc_*` tables. Each user table is a physical SQLite table
`t_<tableId>` with one physical column per stored field (`c_<columnId>`) plus `id`, `created_at`,
`updated_at`, `created_by`. Many-to-many links use junction tables `l_<columnId>(a_id, b_id)`.
Virtual fields (Lookup, Rollup, Formula) are compiled to SQL sub-expressions so they can be filtered
and sorted like stored fields.

## 5. Phases and workers

| Phase | Owner | Deliverable |
|---|---|---|
| 0 | Thread lead | Monorepo scaffold, shared types, meta schema, server bootstrap, API contract (`docs/api.md`) |
| 1a | Worker A: data engine | Field types, records CRUD, query compiler, links/lookup/rollup/formula, tests |
| 1b | Worker B: platform | Auth/roles/tokens, import/export, webhooks, audit, comments, sharing, OpenAPI, template |
| 1d | Worker D: NocoDB migration | NocoDB API client, schema/type mapping, record + link + view copy, job progress, tests with a mocked NocoDB |
| 1e | Worker E: NetBox core | DCIM/IPAM schema, services, REST API, UI pages under web/src/netbox |
| 1c | Worker C: web UI | Sidebar, grid, toolbar, expanded record, form/gallery/kanban/calendar, auth pages, sharing pages |
| 2 | Thread lead | Integration, end-to-end smoke test, CI workflow, README, draft PR |

## 6. Acceptance checks
- `npm test` passes (server unit + API tests).
- `npm run build` builds server and web.
- Smoke: sign up, create inventory template, add a movement, see on-hand rollup update, filter
  low-stock products, export CSV, open public view link, receive webhook, migrate a base from a
  (mocked) NocoDB instance.
