# REST API contract

All endpoints are under `/api/v1`, JSON in and out. Errors: `{ error, message, details? }` with HTTP status
400/401/403/404/409/500. Types referenced below live in `shared/src/types.ts`.

Auth: `Authorization: Bearer <jwt>` (or `xc-auth: <jwt>`) from sign-in, or `xc-token: <api token>`.
Roles per base: owner > editor > commenter > viewer. "min role" is the minimum required.

Owners in brackets are the module that implements the endpoint.

## Auth [core, done]
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /auth/signup | `{email,password,name?}` | `{user, token}` |
| POST | /auth/signin | `{email,password}` | `{user, token}` |
| GET | /auth/me | | `{user}` |

## Meta [data engine]
| Method | Path | Min role | Body / query | Returns |
|---|---|---|---|---|
| GET | /bases | any user | | `Base[]` (with `role`) |
| POST | /bases | any user | `{title, description?, color?}` (creator becomes owner) | `Base` |
| GET | /bases/:baseId | viewer | | `Base & { tables: Table[] }` (tables include columns and views) |
| PATCH | /bases/:baseId | owner | `{title?, description?, color?, order?}` | `Base` |
| DELETE | /bases/:baseId | owner | | `{ok:true}` |
| POST | /bases/:baseId/tables | editor | `{title, columns?: ColumnInput[]}` creates ID + primary "Title" column if none given, and a default grid view | `Table` |
| GET | /tables/:tableId | viewer | | `Table` (columns + views) |
| PATCH | /tables/:tableId | editor | `{title?, description?, order?}` | `Table` |
| DELETE | /tables/:tableId | editor | | `{ok:true}` |
| POST | /tables/:tableId/columns | editor | `ColumnInput = {title, type, options?, required?, defaultValue?, description?, primary?}` | `Column` (Links also creates the symmetric column on the related table) |
| PATCH | /columns/:columnId | editor | partial `ColumnInput` (type changes convert data best-effort) | `Column` |
| DELETE | /columns/:columnId | editor | | `{ok:true}` |
| POST | /tables/:tableId/views | editor | `{title, type, copyFromViewId?}` | `View` |
| PATCH | /views/:viewId | editor (viewer can't; locked views need owner) | partial `{title, order, locked, filter, sorts, columns, meta}` | `View` |
| DELETE | /views/:viewId | editor | | `{ok:true}` (the last view of a table cannot be deleted) |
| GET | /columns/:columnId | viewer | | `Column` |
| GET | /views/:viewId | viewer | | `View` |

Meta notes:
- Table creation: an `ID` field, `CreatedAt` (CreatedTime) and `UpdatedAt` (LastModifiedTime) system fields (hidden in
  new views) are always added. The primary field is the column flagged `primary`, else the first stored, eligible
  column given, else a new SingleLineText "Title".
- Field and view titles are unique per table, table titles per base (case-insensitive) → 400.
- Select choices get a server-assigned `id`; send it back on PATCH so a renamed choice also renames stored values.
- Links `options: {relatedTableId, relation?: 'mm'|'hm'|'bt'}` creates the symmetric Links field on the related table
  (`symmetricColumnId` on both). `bt` = at most one link per record; `hm` = each linked record has one parent.
  Deleting either side deletes both, plus Lookup/Rollup fields that depend on them. Deleting a table deletes Links
  fields pointing at it.
- Formula `options.formula` is returned with current field titles; it is stored by column id, so renames are safe.
  Unknown fields/functions, syntax errors and circular references → 400 with a message.
- Type changes convert data best-effort (invalid → empty). Virtual → stored materialises the computed values.
- PATCH `columns` on a view may be the full list or a subset (others keep their settings).
- Locked views: editors may lock a view; changing, unlocking or deleting a locked view requires owner.

## Data [data engine]
Record keys are **column ids**; `id` is the row id. Select values are option titles (MultiSelect = string[]),
Attachment = `Attachment[]`, Checkbox = boolean, Links = number of linked records in list responses.
| Method | Path | Min role | Body / query | Returns |
|---|---|---|---|---|
| GET | /tables/:tableId/records | viewer | query: `viewId, offset, limit (default 25, max 1000), search, searchColumnId, fields (comma ids), filter (JSON FilterGroup), sorts (JSON Sort[])` | `ListResult` |
| GET | /tables/:tableId/records/:id | viewer | | `RecordData` |
| POST | /tables/:tableId/records | editor | one object or array of objects | created `RecordData` or array |
| PATCH | /tables/:tableId/records | editor | array of objects each with `id` | updated array |
| PATCH | /tables/:tableId/records/:id | editor | object | `RecordData` |
| DELETE | /tables/:tableId/records | editor | `{ids:number[]}` | `{deleted:n}` |
| DELETE | /tables/:tableId/records/:id | editor | | `{deleted:1}` |
| GET | /tables/:tableId/groups | viewer | query: `viewId, columnId, filter, search` | `GroupResult[]` |
| GET | /tables/:tableId/records/:id/links/:columnId | viewer | query: `offset, limit, search, notLinked?` (`notLinked=true` lists related records NOT linked, for a picker) | `ListResult` of the related table |
| POST | /tables/:tableId/records/:id/links/:columnId | editor | `{ids:number[]}` | `{ok:true}` |
| DELETE | /tables/:tableId/records/:id/links/:columnId | editor | `{ids:number[]}` | `{ok:true}` |

Data notes:
- Write bodies may key fields by column id **or title** (ids win on conflict); unknown keys are ignored.
  An explicit positive integer `id` on insert is honoured (409 if taken) — useful for importers.
- Links values on insert/update are arrays of record ids (or `{id}` objects); on update they replace the link set.
- Single-record responses (GET by id, insert, update) return Links as `[{id, display}]` (max 25); lists return counts.
  Lookup = array of values, Rollup = number, Formula = computed value.
- Unknown SingleSelect/MultiSelect values are added to the field's choices. Required fields → 400 when empty.
- Filter conditions with an empty value are ignored; unknown fields/ops in a request filter → 400.
  Date filters accept `YYYY-MM-DD`, ISO date-times, or `today`/`tomorrow`/`yesterday`.
- `viewId` applies the view's filter and sorts (query `sorts` override them); it does not hide fields — use `fields`.

## Platform [platform]
| Method | Path | Min role | Notes |
|---|---|---|---|
| GET/POST | /bases/:baseId/members | viewer / owner | invite by `{email, role}` (user must exist) |
| PATCH/DELETE | /bases/:baseId/members/:userId | owner | `{role}`; the last owner can't be removed/demoted |
| GET/POST | /tokens | user | create returns the token once |
| DELETE | /tokens/:tokenId | user | |
| POST | /views/:viewId/share | editor | `{password?: string \| null}` → `{shareUuid}` |
| DELETE | /views/:viewId/share | editor | disables sharing |
| GET | /public/views/:shareUuid | none | header `xc-password` if protected → `{view, table}` (only shown columns) |
| GET | /public/views/:shareUuid/records | none | same query params as records list |
| POST | /public/views/:shareUuid/submit | none | shared form submission → `RecordData` |
| GET/POST | /tables/:tableId/hooks | editor | `Webhook` CRUD |
| PATCH/DELETE | /hooks/:hookId | editor | |
| POST | /hooks/:hookId/test | editor | sends a sample payload |
| GET | /hooks/:hookId/logs | editor | `WebhookLog[]` newest first |
| GET/POST | /tables/:tableId/records/:id/comments | viewer / commenter | `Comment[]` / `{body}` |
| DELETE | /comments/:commentId | author or owner | |
| GET | /tables/:tableId/records/:id/audit | viewer | `AuditEntry[]` |
| GET | /bases/:baseId/audit | owner | query `offset, limit` |
| POST | /bases/:baseId/import | editor | multipart `file` (.csv/.xlsx) + fields `tableTitle?` or `tableId?` + `columnMap?` (JSON) → `{table, inserted}` |
| POST | /bases/:baseId/import/preview | editor | multipart file → `{sheets:[{name, headers, sampleRows, inferredTypes}]}` |
| GET | /views/:viewId/export?format=csv\|xlsx | viewer | file download; respects view filters/sorts/hidden fields |
| POST | /bases/templates/inventory | any user | creates the Inventory base → `Base` |
| POST | /files | editor of any base | multipart upload → `Attachment` (served from `/api/v1/files/:id`) |
| GET | /docs | none | Swagger UI; `/docs/json` OpenAPI |

## NocoDB migration [migration]
| Method | Path | Notes |
|---|---|---|
| POST | /migrate/nocodb/bases | `{url, token}` → list NocoDB bases `{id,title}[]` (validates the connection) |
| POST | /migrate/nocodb | `{url, token, nocoBaseId, targetTitle?}` → `Job` (runs in background, creator becomes owner) |
| GET | /jobs/:jobId | `Job` (progress, log, result `{baseId, tables, records, links, views, skipped[], converted[]}`) |

Any signed-in user may call these. `url` is the NocoDB instance (cloud or self-hosted; `https://` is added when
missing, and a pasted dashboard URL is trimmed to its origin); `token` is a NocoDB API token, sent only as NocoDB's
`xc-token` header and never stored (not in the job, its log or result). NocoDB failures (bad token, unreachable
host, unknown base) return `400 {error:'NOCODB_ERROR', message}` from `/bases`, and end the job with
`status:'failed'` and the message for `/migrate/nocodb` (the partially created base is removed).

NocoDB endpoints used: `GET /api/v2/meta/workspaces`, `/meta/workspaces/{id}/bases` (cloud) or `/meta/bases`
(self-hosted), `/meta/bases/{baseId}`, `/meta/bases/{baseId}/tables`, `/meta/tables/{tableId}`,
`/meta/tables/{tableId}/views`, `/meta/views/{viewId}/filters|sorts|columns`, `/meta/filters/{groupId}/children`,
`/meta/kanbans|galleries|forms|calendars/{viewId}`, `/tables/{tableId}/records?offset&limit`,
`/tables/{tableId}/links/{linkFieldId}/records/{recordId}`.

## Integrations [integrations]
Details and the Umbrella-side setup: [integrations.md](integrations.md).
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /integrations | user | the caller's integrations |
| POST | /integrations | user | `{kind:'umbrella', title, active?, umbrellaUrl?, inventoryUrl?}` → `{integration, secret}` (secret shown once) |
| GET/PATCH/DELETE | /integrations/:id | creator | |
| POST | /integrations/:id/rotate-secret | creator | → `{secret}` |
| GET | /integrations/:id/umbrella/ci | user | CMDB feed: `query offset, limit (≤5000)` → `UmbrellaCiFeed` built from the DCIM/IPAM API as the caller |
| POST | /integrations/:id/umbrella/alerts | HMAC | `UmbrellaAlertEvent` or an array (≤500); headers `x-umbrella-timestamp`, `x-umbrella-signature` → 202 `{results:[{alert_id, matched}]}` |
| GET | /integrations/:id/umbrella/unmatched | creator | alerts whose CI matched no device |
| GET | /integrations/umbrella/status | user | `query object_type (dcim.device), ids?` → `MonitoringStatus[]` |
| GET | /integrations/umbrella/status/:objectType/:objectId | user | `MonitoringStatus & {history}` |
