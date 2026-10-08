import { Icon } from '../components/Icon';
import { t } from '../i18n';

/**
 * Mount point for the DCIM / IPAM / Integrations sections.
 * The DCIM/IPAM pages are built separately (web/src/netbox/); the lead swaps this placeholder for
 * that module's routes component at /dcim/* and /ipam/*.
 */
export function NetboxPlaceholder({ section }: { section: 'DCIM' | 'IPAM' | 'Integrations' }) {
  return (
    <div className="page">
      <div className="empty-state">
        <Icon name={section === 'Integrations' ? 'webhook' : 'database'} size={32} />
        <h3>{t(section)}</h3>
        <p className="muted">{t('This section is coming soon.')}</p>
      </div>
    </div>
  );
}
