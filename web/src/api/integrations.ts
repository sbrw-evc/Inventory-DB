import type { Integration, IntegrationInput, UmbrellaAlertEvent } from '@shared';
import { http } from './client';

export interface UnmatchedAlert {
  alertId: string;
  title: string;
  ci: UmbrellaAlertEvent['ci'];
  receivedAt: string;
}

const enc = encodeURIComponent;

/** Integrations admin endpoints (docs/integrations.md). */
export const integrationsApi = {
  list: () => http.get<Integration[]>('/integrations'),
  create: (body: IntegrationInput) => http.post<{ integration: Integration; secret: string }>('/integrations', body),
  update: (id: string, body: Partial<Omit<IntegrationInput, 'kind'>>) => http.patch<Integration>(`/integrations/${enc(id)}`, body),
  remove: (id: string) => http.del<{ ok: true }>(`/integrations/${enc(id)}`),
  rotateSecret: (id: string) => http.post<{ secret: string }>(`/integrations/${enc(id)}/rotate-secret`, {}),
  unmatched: (id: string) => http.get<UnmatchedAlert[]>(`/integrations/${enc(id)}/umbrella/unmatched`),
};

/** Absolute API URL for a path under /api/v1, using the integration's public URL when set. */
export function apiUrl(integration: Integration, path: string): string {
  const base = (integration.inventoryUrl || window.location.origin).replace(/\/+$/, '');
  return `${base}/api/v1${path}`;
}
