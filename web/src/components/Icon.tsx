import * as L from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FieldType, ViewType } from '@shared';

/**
 * Icons are lucide-react, the set the Umbrella app uses. `Icon` keeps the old name-based API so
 * every caller stays the same; unknown names fall back to the text glyph.
 */
const ICONS: Record<string, LucideIcon> = {
  plus: L.Plus,
  x: L.X,
  check: L.Check,
  chevronDown: L.ChevronDown,
  chevronRight: L.ChevronRight,
  chevronLeft: L.ChevronLeft,
  more: L.Ellipsis,
  search: L.Search,
  filter: L.ListFilter,
  sort: L.ArrowUpDown,
  group: L.Rows3,
  eye: L.Eye,
  eyeOff: L.EyeOff,
  rowHeight: L.Rows2,
  lock: L.Lock,
  unlock: L.LockOpen,
  share: L.Share2,
  download: L.Download,
  upload: L.Upload,
  webhook: L.Webhook,
  expand: L.Maximize2,
  trash: L.Trash2,
  edit: L.Pencil,
  copy: L.Copy,
  grid: L.Sheet,
  form: L.ClipboardList,
  gallery: L.LayoutGrid,
  kanban: L.SquareKanban,
  calendar: L.CalendarDays,
  table: L.Table2,
  database: L.Database,
  settings: L.Settings,
  users: L.Users,
  key: L.KeyRound,
  history: L.History,
  comment: L.MessageSquare,
  logout: L.LogOut,
  migrate: L.ArrowRightLeft,
  template: L.LayoutTemplate,
  link: L.Link2,
  drag: L.GripVertical,
  star: L.Star,
  arrowLeft: L.ArrowLeft,
  arrowRight: L.ArrowRight,
  arrowUp: L.ArrowUp,
  arrowDown: L.ArrowDown,
  insertLeft: L.BetweenVerticalStart,
  insertRight: L.BetweenVerticalEnd,
  paperclip: L.Paperclip,
  play: L.Play,
  refresh: L.RefreshCw,
  text: L.Type,
  longText: L.AlignLeft,
  hash: L.Hash,
  decimal: L.Binary,
  currency: L.DollarSign,
  percent: L.Percent,
  checkSquare: L.SquareCheckBig,
  clock: L.Clock,
  mail: L.Mail,
  globe: L.Globe,
  phone: L.Phone,
  circleDot: L.CircleDot,
  list: L.List,
  braces: L.Braces,
  lookup: L.TextSearch,
  sigma: L.Sigma,
  function: L.SquareFunction,
  idKey: L.Fingerprint,
  home: L.House,
  server: L.Server,
  network: L.Network,
  plug: L.Plug,
  info: L.Info,
  alert: L.TriangleAlert,
  map: L.MapPin,
};

export function Icon({ name, size = 16, className, title }: { name: string; size?: number; className?: string; title?: string }) {
  const Glyph = ICONS[name] ?? L.Type;
  return (
    <Glyph
      className={`icon ${className ?? ''}`}
      size={size}
      strokeWidth={2}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    />
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
};

export const VIEW_LABELS: Record<ViewType, string> = {
  grid: 'Grid',
  form: 'Form',
  gallery: 'Gallery',
  kanban: 'Kanban',
  calendar: 'Calendar',
};

export function ViewIcon({ type, size = 15 }: { type: ViewType; size?: number }) {
  return <Icon name={VIEW_ICONS[type]} size={size} className={`view-icon view-icon-${type}`} />;
}
