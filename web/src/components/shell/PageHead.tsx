import type { ReactNode } from 'react';

/** Page title with a muted subtitle and optional actions on the right (Umbrella PageHead). */
export function PageHead({ title, subtitle, actions, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>
          {icon}
          {title}
        </h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}
