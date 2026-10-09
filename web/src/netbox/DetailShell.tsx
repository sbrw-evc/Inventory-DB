import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, nb, type ModelSchema, type NbObject } from './api';
import { ErrorBox, Layout, StatusChip } from './components';
import { objectRoute } from './config';
import { findModel, useAsync, useMe, useSchema } from './hooks';
import { t, typeLabel } from './i18n';
import { SidePanel } from './SidePanel';

export interface DetailContext {
  obj: NbObject;
  model: ModelSchema;
  schema: ModelSchema[];
  reload: () => void;
  canWrite: boolean;
  /** Opens the side panel to create an object of another type with presets. */
  openCreate: (objectType: string, presets: Record<string, unknown>) => void;
}

/** Title bar, edit/history side panel and data loading shared by the dedicated detail pages. */
export function DetailShell({ objectType, extra, children }: { objectType: string; extra?: (c: DetailContext) => ReactNode; children: (c: DetailContext) => ReactNode }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: schema, error: schemaError } = useSchema();
  const { data: me } = useMe();
  const model = findModel(schema, objectType);
  const { data: obj, error, reload } = useAsync(() => (model ? nb.get(model, id) : Promise.resolve(undefined)), [model?.object_type, id]);
  const [panel, setPanel] = useState<{ type: string; id: number | 'new'; presets?: Record<string, unknown> } | null>(null);
  const canWrite = !!me?.can_write;

  if (schemaError || error) {
    const e = schemaError ?? error;
    return (
      <Layout>
        <ErrorBox error={e instanceof ApiError && e.status === 401 ? t('signInRequired') : e} />
      </Layout>
    );
  }
  if (!schema || !model || !obj) return <Layout><div className="nb-empty">{t('loading')}</div></Layout>;

  const ctx: DetailContext = {
    obj,
    model,
    schema,
    reload,
    canWrite,
    openCreate: (type, presets) => setPanel({ type, id: 'new', presets }),
  };
  const panelModel = panel ? findModel(schema, panel.type) : undefined;

  return (
    <Layout
      panel={
        panel && panelModel ? (
          <SidePanel
            key={`${panel.type}-${panel.id}`}
            model={panelModel}
            id={panel.id}
            presets={panel.presets}
            onClose={() => setPanel(null)}
            onChanged={(o) => {
              if (!o && panel.type === objectType && panel.id === obj.id) navigate(objectRoute(model.app, model.path));
              else reload();
            }}
          />
        ) : undefined
      }
    >
      <div className="nb-breadcrumb">
        <Link to={objectRoute(model.app, model.path)}>{typeLabel(`${model.app}/${model.path}`, model.verbose_name_plural)}</Link> / {obj.display}
      </div>
      <div className="nb-title">
        <h1>{obj.display}</h1>
        {'status' in obj && <StatusChip value={obj.status as never} />}
        {extra?.(ctx)}
        <span style={{ flex: 1 }} />
        <button className="nb-btn primary" onClick={() => setPanel({ type: objectType, id: obj.id })}>
          {canWrite ? `${t('edit')} · ${t('history')}` : t('history')}
        </button>
      </div>
      {children(ctx)}
    </Layout>
  );
}
