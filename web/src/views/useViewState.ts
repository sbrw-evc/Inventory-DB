import { useCallback, useEffect, useRef, useState } from 'react';
import type { View } from '@shared';
import { metaApi, type ViewPatch } from '../api/endpoints';
import { useBaseCache } from '../api/hooks';
import { toastError } from '../lib/toast';

const DEBOUNCE_MS = 600;

/**
 * Local, immediately-applied copy of a view's settings. When `canPersist`, changes are PATCHed
 * (debounced, merged) and the saved view replaces the cached one; otherwise they stay local.
 */
export function useViewState(baseId: string | null, view: View, canPersist: boolean) {
  const [draft, setDraftState] = useState<View>(view);
  const draftRef = useRef<View>(view);
  const setDraft = useCallback((v: View) => {
    draftRef.current = v;
    setDraftState(v);
  }, []);
  const pending = useRef<ViewPatch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewIdRef = useRef(view.id);
  const cache = useBaseCache();
  const [saving, setSaving] = useState(false);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    const viewId = viewIdRef.current;
    if (!Object.keys(patch).length) return;
    pending.current = {};
    setSaving(true);
    try {
      const saved = await metaApi.updateView(viewId, patch);
      if (baseId && saved) cache.setView(baseId, saved);
    } catch (e) {
      toastError(e);
      if (baseId) void cache.invalidateBase(baseId);
    } finally {
      setSaving(false);
    }
  }, [baseId, cache]);

  // Switching to another view: save what's pending for the old one, then reset.
  useEffect(() => {
    if (viewIdRef.current !== view.id) {
      void flush();
      viewIdRef.current = view.id;
      setDraft(view);
    }
  }, [view, flush, setDraft]);

  // Server-side changes (e.g. after a save, or another tab) replace the draft when nothing is pending.
  useEffect(() => {
    if (!Object.keys(pending.current).length && !timer.current) setDraft(view);
  }, [view, setDraft]);

  useEffect(() => () => void flush(), [flush]);

  const update = useCallback(
    (patch: ViewPatch, opts: { immediate?: boolean } = {}) => {
      const d = draftRef.current;
      const next = { ...d, ...patch, meta: patch.meta ? { ...d.meta, ...patch.meta } : d.meta } as View;
      setDraft(next);
      if (!canPersist) return;
      // The server replaces `meta` as a whole, so always send the merged object.
      pending.current = { ...pending.current, ...patch, ...(patch.meta ? { meta: next.meta } : {}) };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), opts.immediate ? 0 : DEBOUNCE_MS);
    },
    [canPersist, flush, setDraft],
  );

  return { draft, update, saving, flush };
}
