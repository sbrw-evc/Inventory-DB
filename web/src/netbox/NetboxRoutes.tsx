/**
 * DCIM/IPAM routes. Mount in the main router (react-router-dom v7):
 *
 *   <Route path="/dcim/*" element={<DcimRoutes />} />
 *   <Route path="/ipam/*" element={<IpamRoutes />} />
 *   <Route path="/tenancy/*" element={<TenancyRoutes />} />
 *   <Route path="/extras/*" element={<ExtrasRoutes />} />
 *
 * or, equivalently, `<Route path="/*" element={<NetboxRoutes />} />` for the four prefixes. Object links use
 * `/<app>/<path>/<id>` (the `display_url` the API returns), so all four prefixes must be mounted.
 */
import { Route, Routes } from 'react-router-dom';
import './netbox.css';
import { ObjectListPage } from './ObjectListPage';
import { DevicePage, PrefixPage, RackPage, SearchPage, SectionHome, SitePage, TracePage } from './pages';

export function DcimRoutes() {
  return (
    <Routes>
      <Route index element={<SectionHome section="dcim" />} />
      <Route path="search" element={<SearchPage />} />
      <Route path="sites/:id" element={<SitePage />} />
      <Route path="racks/:id" element={<RackPage />} />
      <Route path="devices/:id" element={<DevicePage />} />
      <Route path="interfaces/:id/trace" element={<TracePage />} />
      <Route path=":path" element={<ObjectListPage app="dcim" />} />
      <Route path=":path/:id" element={<ObjectListPage app="dcim" />} />
    </Routes>
  );
}

export function IpamRoutes() {
  return (
    <Routes>
      <Route index element={<SectionHome section="ipam" />} />
      <Route path="search" element={<SearchPage />} />
      <Route path="prefixes/:id" element={<PrefixPage />} />
      <Route path=":path" element={<ObjectListPage app="ipam" />} />
      <Route path=":path/:id" element={<ObjectListPage app="ipam" />} />
    </Routes>
  );
}

function AppRoutes({ app }: { app: 'tenancy' | 'extras' }) {
  return (
    <Routes>
      <Route index element={<ObjectListPage app={app} />} />
      <Route path=":path" element={<ObjectListPage app={app} />} />
      <Route path=":path/:id" element={<ObjectListPage app={app} />} />
    </Routes>
  );
}

export const TenancyRoutes = () => <AppRoutes app="tenancy" />;
export const ExtrasRoutes = () => <AppRoutes app="extras" />;

/** All DCIM/IPAM routes; mount at `/*` (or use the per-prefix components above). */
export function NetboxRoutes() {
  return (
    <Routes>
      <Route path="dcim/*" element={<DcimRoutes />} />
      <Route path="ipam/*" element={<IpamRoutes />} />
      <Route path="tenancy/*" element={<TenancyRoutes />} />
      <Route path="extras/*" element={<ExtrasRoutes />} />
    </Routes>
  );
}

/** Paths the main app should route to the components above. */
export const NETBOX_MOUNTS = ['/dcim/*', '/ipam/*', '/tenancy/*', '/extras/*'] as const;
