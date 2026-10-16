# Ledger: business processes

Ledger is the inventory of the Umbrella family: what exists, where it is and how it is connected (DCIM / IPAM with a
NetBox-compatible API), plus spreadsheet-style tables for any other inventory. How Ledger works with Keystone, Beacon
and Current is in [family.md](https://github.com/sbrw-evc/current/blob/HEAD/docs/family.md); this page is about the processes inside Ledger.

## Roles in the processes

| Who | Ledger role (given in Keystone) | Does |
| --- | --- | --- |
| Administrator | `admin` | settings, integrations, API tokens of others |
| Engineer | `editor` | creates and changes inventory objects and tables |
| Reader | `viewer` | reads inventory |
| Base owner / editor / commenter / viewer | base membership in Ledger | works with one spreadsheet base |
| Beacon, Current, scripts | API token (`xc-token`) | read and, where allowed, write inventory |

## L1. Install

1. The administrator sets the PostgreSQL password in `.env` and runs `docker compose up -d`.
2. OpenBao is initialized and unsealed; the schema is migrated on start.
3. The administrator connects Ledger in Keystone, puts the connection key into Ledger and restarts it.
4. Ledger publishes its roles (`admin`, `editor`, `viewer`); whoever Keystone gives `admin` is the administrator.

## L2. Record what exists

1. An engineer creates sites, racks, devices, interfaces, cables, circuits, prefixes, IP addresses and VLANs by hand,
   by CSV import, or through the NetBox-compatible API.
2. Ledger checks references (a device's site, an interface's device, a prefix's VRF) and computes what can be
   derived: rack elevation, cable trace, prefix utilisation, the next free address.
3. Every change goes to the change log with who and when.
4. Changes that matter to Current (devices, interfaces, prefixes, circuits) are sent to Current at once as a signed
   hook.

## L3. Keep other inventory in tables

1. A team creates a base and tables (24 field types, links, lookups, rollups, formulas) or starts from the
   Inventory template, or imports CSV / XLSX / JSON, or migrates a base from NocoDB.
2. The base owner invites members with owner, editor, commenter or viewer rights.
3. People work in grid, form, gallery, kanban, calendar, timeline or map views; comments and history are kept per
   record.
4. Public shared views and forms collect data from people without accounts; webhooks notify other systems.

## L4. Feed Beacon and show its alerts

1. The administrator creates a Beacon integration and a read-only API token.
2. Beacon reads the CI feed every 15 minutes and sends signed alert state every 30 seconds.
3. Ledger matches alerts to devices (reference, hostname, FQDN, IP) and shows status chips and alert lists on
   device pages; unmatched alerts are listed for the administrator.

## L5. Show traffic from Current

1. The administrator creates a Current integration with its address and token.
2. Device, interface and circuit pages show traffic, sparklines and the 95th percentile from Current; prefix pages
   show the addresses seen in traffic.
3. From Current, an engineer can create an IP address in Ledger that Current saw but Ledger does not know.

## L6. Operate

1. Settings → Status shows the health of the database, OpenBao and Keystone.
2. The database can be moved to another PostgreSQL and secrets to another OpenBao.
3. Backups are `pg_dump` plus the OpenBao data; upgrades are `git pull` and `docker compose up -d --build`.
4. A person disabled in Keystone is disabled in Ledger at the next synchronization and their API tokens are
   suspended (restored when Keystone enables them again).
