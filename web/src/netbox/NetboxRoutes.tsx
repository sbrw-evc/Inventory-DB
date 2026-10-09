/**
 * DCIM/IPAM routes. Mount in the main router (react-router-dom v7):
 *
 *   <Route path="/dcim/*" element={<DcimRoutes />} />
 *   <Route path="/ipam/*" element={<IpamRoutes />} />
 *   <Route path="/circuits/*" element={<CircuitsRoutes />} />
 *   <Route path="/virtualization/*" element={<VirtualizationRoutes />} />
 *   <Route path="/tenancy/*" element={<TenancyRoutes />} />
 *   <Route path="/extras/*" element={<ExtrasRoutes />} />
 *
 * or, equivalently, `<Route path="/*" element={<NetboxRoutes />} />` for all prefixes. Object links use
 * `/<app>/<path>/<id>` (the `display_url` the API returns), so every prefix must be mounted.
 */
import { Route, Routes } from 'react-router-dom';
import './netbox.css';
import { ObjectListPage } from './ObjectListPage';
import { CircuitPage, ClusterPage, TracePage, VirtualMachinePage } from './morePages';
import { DevicePage, PrefixPage, RackPage, SearchPage, SectionHome, SitePage } from './pages';

export function DcimRoutes() {
  return (
    <Routes>
      <Route index element={<SectionHome section="dcim" />} />
      <Route path="search" element={<SearchPage />} />
      <Route path="sites/:id" element={<SitePage />} />
      <Route path="racks/:id" element={<RackPage />} />
      <Route path="devices/:id" element={<DevicePage />} />
      <Route path=":path/:id/trace" element={<TracePage app="dcim" />} />
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

export function CircuitsRoutes() {
  return (
    <Routes>
      <Route index element={<SectionHome section="circuits" />} />
      <Route path="circuits/:id" element={<CircuitPage />} />
      <Route path=":path/:id/trace" element={<TracePage app="circuits" />} />
      <Route path=":path" element={<ObjectListPage app="circuits" />} />
      <Route path=":path/:id" element={<ObjectListPage app="circuits" />} />
    </Routes>
  );
}

export function VirtualizationRoutes() {
  return (
    <Routes>
      <Route index element={<SectionHome section="virtualization" />} />
      <Route path="clusters/:id" element={<ClusterPage />} />
      <Route path="virtual-machines/:id" element={<VirtualMachinePage />} />
      <Route path=":path" element={<ObjectListPage app="virtualization" />} />
      <Route path=":path/:id" element={<ObjectListPage app="virtualization" />} />
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
      <Route path="circuits/*" element={<CircuitsRoutes />} />
      <Route path="virtualization/*" element={<VirtualizationRoutes />} />
      <Route path="tenancy/*" element={<TenancyRoutes />} />
      <Route path="extras/*" element={<ExtrasRoutes />} />
    </Routes>
  );
}

/** Paths the main app should route to the components above. */
export const NETBOX_MOUNTS = ['/dcim/*', '/ipam/*', '/circuits/*', '/virtualization/*', '/tenancy/*', '/extras/*'] as const;
