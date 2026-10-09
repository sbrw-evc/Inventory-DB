import { useSyncExternalStore } from 'react';

/** The phone layout (Umbrella's breakpoint): below this width the app shows the mobile shell. */
export const MOBILE_QUERY = '(max-width: 860px)';

function subscribe(notify: () => void) {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener('change', notify);
  return () => mq.removeEventListener('change', notify);
}

export function useMobile() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}
