# Design guidelines

Inventory DB follows the visual language and application guidelines of the Umbrella monitoring app
(github.com/sbrw-evc/Umbrella-Monitoring, see `target/docs/03-c4.md` "Web interface" and the incident
dashboard mockup `target/diagrams/06-mdash.png`). Both apps should feel like one product family.

## Layout
- **App header**: full-width dark navy bar (`--header-bg`) with the product name at left, horizontal
  section links (current one underlined, white text), a wide global search field in the middle, and the
  user name + role menu at right. Inventory DB sections: Bases, DCIM, IPAM, Integrations, Administration.
- **Toolbar row** under the header: presets/saved views dropdown, "Save view", "Copy link with filters",
  "Export CSV", "Group by" dropdown, live-update indicator (green dot + text) at the right.
- **Filter row(s)**: compact dropdown fields laid out in a grid, labelled `Field: value ▾`.
- **Counters**: rounded tiles with a big number and label, coloured by status (see status colours),
  optionally beside a small bar chart (`--chart-bar`).
- **Bulk action bar**: "Selected: N" + secondary buttons; actions the role can't perform are hidden.
- **Table**: gray header row with bold labels and sort arrow, white cells, 1px light borders, checkbox
  column, row hover/selected `--row-hover`, status shown as rounded chips.
- **Side panel** (record / incident details) docked on the right with a gray title bar, tabs
  (Details · History · Comments …), and primary + secondary buttons at the bottom.
- The left sidebar (bases → tables → views) sits under the header for the spreadsheet area.

## Tokens
```css
:root {
  --header-bg: #0B4884;      /* app header, C4 "system" dark */
  --header-fg: #FFFFFF;
  --primary: #1168BD;        /* primary button, links */
  --primary-hover: #0B4884;
  --accent: #438DD5;
  --accent-light: #85BBF0;
  --chart-bar: #7EB6F0;
  --bg: #FFFFFF;
  --surface: #F5F5F5;        /* panels, page background areas */
  --table-header: #E0E0E0;
  --row-hover: #EAF2FD;
  --border: #CCCCCC;
  --border-strong: #9E9E9E;
  --button-bg: #E6E6E6;      /* secondary button */
  --button-border: #B3B3B3;
  --text: #222222;
  --text-muted: #555555;
  --success: #2E7D32;        /* live indicator */
  /* status chips: fill / border (from the Umbrella legend) */
  --critical-bg: #F8CECC; --critical-border: #B85450;
  --error-bg: #FFE6CC;    --error-border: #D79B00;
  --warning-bg: #FFF2CC;  --warning-border: #D6B656;
  --info-bg: #DAE8FC;     --info-border: #6C8EBF;
  --ok-bg: #D5E8D4;       --ok-border: #82B366;
  --neutral-bg: #F5F5F5;  --neutral-border: #666666;
  --radius: 6px;
  --radius-chip: 10px;
  --font: Arial, "Helvetica Neue", Helvetica, sans-serif;
  --font-size: 13px;
}
```
Select-option colours in the spreadsheet use the chip palette above first (info, ok, warning, error,
critical, neutral, plus the purple `#E1D5E7/#9673A6`), so data colours match Umbrella's legend.
Status mapping for DCIM/IPAM objects: active → ok, planned → info, staged/reserved → warning,
failed/deprecated → critical, offline/decommissioning → neutral.

## Application guidelines (from Umbrella's architecture docs)
- The web UI stores no data or secrets; everything goes through the REST API with the user's token.
- Sections and actions the role can't use are hidden, but permissions are always enforced by the API.
- REST API under `/api/v1`, described by OpenAPI; filters of list pages live in the URL so links
  reproduce a view ("Copy link with filters").
- Every change is written to the audit log before the response.
- Service health at `/api/v1/health`, metrics in OpenMetrics format at `/metrics`.
- No paid proprietary components; open-source dependencies only.
- UI language: English and Russian (Umbrella's UI language), switchable in the user menu.
