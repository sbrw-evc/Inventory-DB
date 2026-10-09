import { useLocation } from 'react-router-dom';

/** Base/table/view ids from the current URL (works in layouts above the routes that define them). */
export function useRouteIds(): { baseId?: string; tableId?: string; viewId?: string } {
  const { pathname } = useLocation();
  const m = /^\/base\/([^/]+)(?:\/table\/([^/]+)(?:\/view\/([^/]+))?)?/.exec(pathname);
  return { baseId: m?.[1], tableId: m?.[2], viewId: m?.[3] };
}
