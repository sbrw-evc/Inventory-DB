import { useQuery } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef } from 'react';
import type { ListQuery, Table, View } from '@shared';
import { parseGeo } from '@shared';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { recordTitle } from '../lib/baseContext';
import { choiceColor } from '../lib/colors';
import { andFilters } from '../lib/filters';
import { formatValue } from '../lib/format';
import type { RecordSource } from '../lib/records';
import type { ResolvedColumn } from '../lib/viewColumns';
import './map.css';

interface Props {
  table: Table;
  view: View;
  resolved: ResolvedColumn[];
  source: RecordSource;
  baseQuery: ListQuery;
  onOpen: (id: number) => void;
}

const MAX_MARKERS = 1000;
const DEFAULT_COLOR = '#438DD5';

/** Map: records placed by a GeoData field on OpenStreetMap tiles; a marker's popup opens the record. */
export function MapView({ table, view, resolved, source, baseQuery, onOpen }: Props) {
  const geo = table.columns.find((c) => c.id === view.meta.geoColumnId && c.type === 'GeoData') ?? table.columns.find((c) => c.type === 'GeoData');
  const colorCol = table.columns.find((c) => c.type === 'SingleSelect');
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.FeatureGroup | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  const filter = geo ? andFilters(baseQuery.filter, { logic: 'and', children: [{ columnId: geo.id, op: 'notblank' }] }) : undefined;
  const query = useQuery({
    queryKey: [...source.key, 'map', geo?.id, JSON.stringify(baseQuery)],
    queryFn: ({ signal }) => source.list({ ...baseQuery, filter, offset: 0, limit: MAX_MARKERS }, signal),
    enabled: !!geo,
  });
  const fields = useMemo(() => resolved.filter((r) => r.show && !r.column.primary && r.column.id !== geo?.id).slice(0, 3), [resolved, geo?.id]);

  useEffect(() => {
    if (!el.current || map.current || !geo) return;
    const m = L.map(el.current, { worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    layer.current = L.featureGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      layer.current = null;
    };
  }, [geo]);

  useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group || !geo) return;
    group.clearLayers();
    for (const r of query.data?.list ?? []) {
      const p = parseGeo(r[geo.id]);
      if (!p) continue;
      const sel = colorCol ? r[colorCol.id] : null;
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: 8,
        weight: 2,
        color: '#0B4884',
        fillColor: sel ? choiceColor(colorCol!, String(sel)) : DEFAULT_COLOR,
        fillOpacity: 0.85,
      });
      // Popup content built with DOM APIs so record values are never parsed as HTML.
      const box = document.createElement('div');
      box.className = 'map-popup';
      const title = document.createElement('div');
      title.className = 'map-popup-title';
      title.textContent = recordTitle(table, r);
      box.appendChild(title);
      for (const f of fields) {
        const text = formatValue(f.column, r[f.column.id]);
        if (!text) continue;
        const line = document.createElement('div');
        line.className = 'map-popup-field';
        const k = document.createElement('span');
        k.className = 'muted';
        k.textContent = `${f.column.title}: `;
        line.append(k, document.createTextNode(text));
        box.appendChild(line);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm btn-primary';
      btn.textContent = t('Open record');
      btn.addEventListener('click', () => {
        m.closePopup();
        openRef.current(r.id);
      });
      box.appendChild(btn);
      marker.bindPopup(box);
      marker.bindTooltip(recordTitle(table, r));
      group.addLayer(marker);
    }
    const bounds = group.getBounds();
    if (bounds.isValid()) m.fitBounds(bounds.pad(0.2), { maxZoom: 14 });
  }, [query.data, geo, colorCol, fields, table]);

  if (!geo) {
    return (
      <div className="empty-state">
        <Icon name="map" size={32} />
        <h3>{t('Map needs a Geo data field')}</h3>
        <p className="muted">{t('Add a Geo data field (latitude;longitude) to this table to place records on the map.')}</p>
      </div>
    );
  }

  const shown = query.data?.list.length ?? 0;
  const total = query.data?.pageInfo.totalRows ?? 0;
  return (
    <div className="map-view">
      <div className="map-status muted small">
        {query.isFetching ? t('Loading…') : t('{n} records on the map', { n: shown })}
        {total > shown && ` · ${t('showing the first {n}', { n: MAX_MARKERS })}`}
      </div>
      <div ref={el} className="map-canvas" />
    </div>
  );
}
