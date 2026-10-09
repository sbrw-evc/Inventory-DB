# Design guidelines

Inventory DB looks and behaves like the Umbrella monitoring web app: the `app/web` package on the
`dev` branch of github.com/sbrw-evc/umbrella-monitoring (React + Vite, lucide icons, `motion`,
OverlayScrollbars). The two apps should read as one product family: same shell, same tokens, same
controls, same light and dark themes, same phone layout. Reference screenshots of both apps are kept
next to each other in `nocodb-plan/screenshots/` (`umbrella/`, `inventory/`, `compare-*.png`).

## Shell
- **Chrome**: the window background is `--chrome`. The top bar sits on it with no bar of its own:
  the side toggle (PanelLeftClose/PanelLeftOpen), the brand (red rounded logo tile + "Inventory DB"),
  then on the right the global search (pill field, `/` focuses it), the role pill of the current
  base and the user menu.
- **Page block**: the page sits in a rounded panel (`.app-main`, radius 12px, 1px `--border`,
  background `--bg`) to the right of the sidebar. It scrolls on its own with OverlayScrollbars.
- **Sidebar** (`components/shell/AppSidebar.tsx`, `nav.ts`): groups are accordions with a lucide
  icon and a chevron. The current page is marked by a pill (`--accent-soft`, accent text) that
  slides between links (`motion` `layoutId`). Groups: **Bases** (the base → table → view tree),
  **DCIM**, **Circuits**, **Virtualization**, **IPAM**, **Integrations** (Integrations, Import &
  migration), **Administration** (API tokens, tags, custom fields, change log). DCIM/IPAM pages come
  from `netbox/nav.ts`, so a new NetBox object type shows up in the menu by adding it there.
  The sidebar is 280px wide, can be dragged between 232 and 440px (double-click restores it) and
  collapses into an icon rail with tooltips; the open groups, width and collapse state are kept in
  `localStorage` (`inventorydb.sidebar.*`).
- **Page**: a centred column 1100px wide with 24px padding (NetBox list pages use 1400px).
  It starts with a **PageHead** (`components/shell/PageHead.tsx`): a 22px semibold title, a muted
  subtitle under it and the actions on the right. Route changes fade and lift the page by a few px.
- **User menu**: avatar with initials (colour from the name), name and e-mail; the dropdown has the
  API tokens link, Language (English/Русский) and Theme (Light/Dark) accordions and Sign out.
- **Sign-in**: a centred card with the brand, an EN/RU segmented control and the theme toggle on
  top, then the form; the password field has a show/hide button.

## Surfaces and controls
- **Cards** (`.card`, `.table-card`, toolbar cards, counter tiles): `--surface`, 1px `--border`,
  radius 14px (`--radius-card`), `--shadow`. Tables live inside a card: the header row is
  `--surface-2` with muted 12.5px semibold labels, rows are separated by 1px lines.
- **Buttons**: 38px high, radius 9px. Primary is solid blue with a soft shadow; secondary is white
  with a grey border; ghost has no border; danger is red; `-sm` is 30px.
- **Inputs and selects**: 38px, radius 9px, `--input-border`, focus ring `--focus`. Native selects
  get a chevron; checkboxes, radios and switches are drawn with the `--check-*`/`--switch-*` tokens.
- **Badges** are pills: a soft fill with coloured text, no border (`.pill`, `.status-chip`).
  Priorities: P1 and P2 `--error`, P3 `--warn`, P4 `--low`, P5 `--info` (`.tone-p1` … `.tone-p5`).
- **Segmented controls** (EN/RU, view switches): a `--segment-bg` track with a white pill that
  slides to the chosen option.
- **Dialogs** (`components/Modal.tsx`): a blurred `--backdrop`, a card with radius 14px that springs
  in; the record drawer slides in from the right. The title row and footer have no grey bands.
  Confirmations show a warning icon and "This cannot be undone." for destructive actions.
- **Toasts**: bottom right, a card with a 4px left border in the tone colour, an icon, the message
  and a close button.
- **Scrollbars**: OverlayScrollbars (`lib/scrollbars.ts`) on the sidebar, page, dialogs and side
  panels, with thumbs in `--scrollbar-thumb`; the grid, kanban, calendar and timeline keep native
  scrolling (thin themed scrollbars).
- **Icons**: lucide-react everywhere, 2px stroke; `components/Icon.tsx` maps the old icon names.
  View icons keep a colour per view type.
- **Motion**: springs (stiffness 420, damping 30) for pills and chevrons, short fades for menus.
  Everything respects `prefers-reduced-motion`. Switching the theme reveals the new theme in a
  circle from the toggle (View Transitions) where the browser supports it.

## Phone (≤ 860px)
`components/shell/MobileFrame.tsx`: a top bar with the logo, the title of the current page and the
avatar; the page below it (the page's own title is hidden, it is already in the top bar); a bottom
tab bar (Bases, DCIM, IPAM, Integrations, More) whose current tab has a sliding pill. "More" opens
the whole menu in a bottom sheet. Counter tiles go two per row, filters stack.

## Themes
The theme is `data-theme="light|dark"` on `<html>`, kept in `localStorage` (`inventorydb.theme`)
and applied before the first paint by a script in `index.html`; without a saved choice it follows
the system. All colours come from the tokens below (`web/src/styles/app.css`); older names used by
feature code (`--primary`, `--text-muted`, `--row-hover`, `--info-bg`, …) are aliases of them.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--chrome` | `#e9edf2` | `#070b14` | window background around the page block |
| `--bg` | `#f4f6f9` | `#0b1220` | page block background |
| `--surface` | `#ffffff` | `#121a2b` | cards, dialogs, menus |
| `--surface-2` | `#f8fafc` | `#172036` | table headers, hover |
| `--text` | `#0f172a` | `#e5e9f2` | text |
| `--muted` | `#5b6475` | `#9aa4b8` | secondary text, labels |
| `--border` | `#dde3eb` | `#26324a` | card and table lines |
| `--accent` | `#2563eb` | `#5b8cff` | links, focus, current page |
| `--accent-soft` | `#e8efff` | `#1b2a4d` | sidebar pill, selected rows |
| `--ok` / `--ok-soft` | `#15803d` / `#e9f7ee` | `#4ade80` / `#13291d` | active, success |
| `--warn` / `--warn-soft` | `#a16207` / `#fdf6e3` | `#facc15` / `#2b2510` | P3, staging, warnings |
| `--low` / `--low-soft` | `#0f766e` / `#e6f5f3` | `#5eead4` / `#0f2a28` | P4 |
| `--error` / `--error-soft` | `#b91c1c` / `#fdecec` | `#f87171` / `#2d1416` | P1, P2, failures, danger |
| `--info` / `--info-soft` | `#1d4ed8` / `#eaf1ff` | `#93b4ff` / `#17233f` | P5, planned, info |
| `--orange` / `--purple` (+ `-soft`) | `#c2410c` / `#7e22ce` | `#fb923c` / `#c084fc` | extra chip colours |
| `--btn-primary-bg` | `#2563eb` | `#4f7fff` | primary buttons |
| `--control-height` / `--control-radius` | 38px / 9px | same | buttons, inputs, selects |
| `--radius` / `--radius-card` | 10px / 14px | same | controls / cards |
| `--shadow` | soft 1px + 24px blur | darker | cards, menus |
| `--backdrop` | `rgba(8,12,22,.45)` | same | dialog backdrop |
| `--font` / `--font-size` | system-ui / 14px | same | all text |

Select-option colours in the spreadsheet map to these tones (info, ok, warning, error → orange,
critical → error, neutral, purple), so data colours match Umbrella's badges in both themes.
Status mapping for DCIM/IPAM objects: active → ok, planned → info, staged/reserved → warn,
failed/deprecated → error, offline/decommissioning → neutral.

## Language
English and Russian. The language is kept in `localStorage` (`lang`), switched on the sign-in card
or in the user menu, and the app re-renders in place. English strings are the keys
(`web/src/i18n/ru.ts`, `ruFeatures.ts`; NetBox pages use `netbox/i18n.ts`).

## Deliberate differences from Umbrella
- The top bar holds a global search of bases, tables and views instead of incident lights and the
  notification centre (Inventory DB has no incidents).
- The logo is Umbrella's red tile with a database glyph instead of the umbrella.
- NetBox sections have sub-headings inside their sidebar group (Organization, Racks, Devices…)
  because they have many pages; NetBox list pages are wider (1400px).
- The spreadsheet grid uses 13.5px text and tighter rows than Umbrella's tables.
- Selects are styled native `<select>` elements rather than Headless UI listboxes.

## Application guidelines (from Umbrella's architecture docs)
- The web UI stores no data or secrets; everything goes through the REST API with the user's token.
- Sections and actions the role can't use are hidden, but permissions are always enforced by the API.
- REST API under `/api/v1`, described by OpenAPI; filters of list pages live in the URL so links
  reproduce a view ("Copy link with filters").
- Every change is written to the audit log before the response.
- Service health at `/api/v1/health`, metrics in OpenMetrics format at `/metrics`.
- No paid proprietary components; open-source dependencies only.
- UI language: English and Russian (Umbrella's UI language), switchable in the user menu.
