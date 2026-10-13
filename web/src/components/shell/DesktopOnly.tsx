import { Monitor, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useT } from '../../i18n';

// Umbrella's DesktopOnly (app/web/src/app/mobile/DesktopOnly.tsx).

const KEY = 'inventory.mobile.forced';

/** The pages the user chose to open on the phone anyway, for this tab of the browser. */
export function forcedPages(): Set<string> {
  try {
    return new Set(JSON.parse(window.sessionStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function force(path: string) {
  const s = forcedPages();
  s.add(path);
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    // The choice then lasts until the page is rendered again.
  }
}

/** DesktopOnly stands in for a page made for a computer when it is opened on a phone. */
export function DesktopOnly({ id, label, icon: Icon, onOpen }: { id: string; label: string; icon: LucideIcon; onOpen: () => void }) {
  const t = useT();
  return (
    <main className="page">
      <div className="card m-desk">
        <span className="m-desk-icon">
          <Icon size={26} aria-hidden />
          <Monitor size={16} aria-hidden className="m-desk-badge" />
        </span>
        <h2>{t('The «{page}» section is made for a computer', { page: label })}</h2>
        <p className="muted">{t('The page has wide tables or long forms that do not fit a phone screen. Open it on a computer, or open it here anyway.')}</p>
        <div className="m-desk-actions">
          <Link to="/" className="btn btn-primary">
            {t('Home')}
          </Link>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              force(id);
              onOpen();
            }}
          >
            {t('Open anyway')}
          </button>
        </div>
      </div>
    </main>
  );
}
