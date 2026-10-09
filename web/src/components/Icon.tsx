import type { FieldType, ViewType } from '@shared';

/** Minimal stroke icon set (24x24 viewBox, 1.8 stroke). */
const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z',
  sort: 'M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3',
  group: 'M4 6h16M4 12h10M4 18h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.6 6.6C3.8 8.3 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.3-1',
  rowHeight: 'M4 6h16M4 12h16M4 18h16',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 1 1 8 0v3',
  unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2',
  share: 'M4 12v7h16v-7M12 3v12M8 7l4-4 4 4',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  upload: 'M12 20V8M7 13l5-5 5 5M4 4h16',
  webhook: 'M12 4a4 4 0 0 0-3.5 6l-3 5M8 18a4 4 0 1 0 6.5-3H20M16 12a4 4 0 1 0 3 6.5',
  expand: 'M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  grid: 'M4 4h16v16H4zM4 10h16M4 15h16M10 4v16',
  form: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  gallery: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  kanban: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v5M16 3v5',
  table: 'M4 5h16v14H4zM4 10h16M10 10v9',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.6-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.6 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.6H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.4z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.1a4 4 0 0 1 0 7.8M22 21v-1a6 6 0 0 0-4-5.7',
  key: 'M15 7a4 4 0 1 1-3.5 6L4 20.5V17h3v-3h3l1.5-1.5A4 4 0 0 1 15 7z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  comment: 'M4 5h16v11H9l-5 4z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  migrate: 'M4 7h12l-3-3M20 17H8l3 3',
  template: 'M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  insertLeft: 'M14 4h6v16h-6zM4 12h7M7.5 8.5v7',
  insertRight: 'M4 4h6v16H4zM13 12h7M16.5 8.5v7',
  paperclip: 'M20 11l-8 8a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7L10 16.5a1.7 1.7 0 0 1-2.4-2.4L15 7',
  play: 'M7 4l12 8-12 8z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  // field type glyphs
  text: 'M5 6h14M12 6v13',
  longText: 'M4 6h16M4 10h16M4 14h16M4 18h10',
  hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
  decimal: 'M6 18h.01M10 6a4 6 0 1 1 0 12 4 6 0 0 1 0-12zM18 6a3 6 0 1 1 0 12 3 6 0 0 1 0-12z',
  currency: 'M12 3v18M16 7c0-1.5-1.8-2.5-4-2.5S8 5.5 8 7.5 10 10 12 10.5s4 1.3 4 3.5-1.8 3.5-4 3.5-4-1-4-2.5',
  percent: 'M19 5L5 19M7 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  checkSquare: 'M4 4h16v16H4zM8 12l3 3 5-6',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  circleDot: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  braces: 'M8 4c-2 0-2 1-2 3s-1 4-2 5c1 1 2 3 2 5s0 3 2 3M16 4c2 0 2 1 2 3s1 4 2 5c-1 1-2 3-2 5s0 3-2 3',
  lookup: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-5.5-5.5M7 10h6',
  sigma: 'M18 5H6l6 7-6 7h12',
  function: 'M14 4c-3 0-3 3-3.5 6S9 20 6 20M7 10h8M14 14l5 5M19 14l-5 5',
  idKey: 'M4 6h16v12H4zM8 10v4M12 10v4h2a2 2 0 0 0 0-4z',
  mapPin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  timeline: 'M4 5h9M8 10h10M6 15h8M10 20h10',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
};

export function Icon({ name, size = 16, className, title }: { name: string; size?: number; className?: string; title?: string }) {
  const d = PATHS[name] ?? PATHS.text;
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}

const FIELD_ICONS: Record<FieldType, string> = {
  ID: 'idKey',
  SingleLineText: 'text',
  LongText: 'longText',
  Number: 'hash',
  Decimal: 'decimal',
  Currency: 'currency',
  Percent: 'percent',
  Rating: 'star',
  Checkbox: 'checkSquare',
  Date: 'calendar',
  DateTime: 'clock',
  Email: 'mail',
  URL: 'globe',
  PhoneNumber: 'phone',
  SingleSelect: 'circleDot',
  MultiSelect: 'list',
  Attachment: 'paperclip',
  JSON: 'braces',
  CreatedTime: 'clock',
  LastModifiedTime: 'history',
  Links: 'link',
  Lookup: 'lookup',
  Rollup: 'sigma',
  Formula: 'function',
  GeoData: 'mapPin',
};

export const FIELD_LABELS: Record<FieldType, string> = {
  ID: 'ID',
  SingleLineText: 'Single line text',
  LongText: 'Long text',
  Number: 'Number',
  Decimal: 'Decimal',
  Currency: 'Currency',
  Percent: 'Percent',
  Rating: 'Rating',
  Checkbox: 'Checkbox',
  Date: 'Date',
  DateTime: 'Date time',
  Email: 'Email',
  URL: 'URL',
  PhoneNumber: 'Phone number',
  SingleSelect: 'Single select',
  MultiSelect: 'Multi select',
  Attachment: 'Attachment',
  JSON: 'JSON',
  CreatedTime: 'Created time',
  LastModifiedTime: 'Last modified time',
  Links: 'Links',
  Lookup: 'Lookup',
  Rollup: 'Rollup',
  Formula: 'Formula',
  GeoData: 'Geo data',
};

export function FieldIcon({ type, size = 14 }: { type: FieldType; size?: number }) {
  return <Icon name={FIELD_ICONS[type] ?? 'text'} size={size} className="field-icon" />;
}

export const VIEW_ICONS: Record<ViewType, string> = {
  grid: 'grid',
  form: 'form',
  gallery: 'gallery',
  kanban: 'kanban',
  calendar: 'calendar',
  timeline: 'timeline',
  map: 'map',
};

export const VIEW_LABELS: Record<ViewType, string> = {
  grid: 'Grid',
  form: 'Form',
  gallery: 'Gallery',
  kanban: 'Kanban',
  calendar: 'Calendar',
  timeline: 'Timeline',
  map: 'Map',
};

export function ViewIcon({ type, size = 15 }: { type: ViewType; size?: number }) {
  return <Icon name={VIEW_ICONS[type]} size={size} className={`view-icon view-icon-${type}`} />;
}
