import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { api, useAction, useApi } from './api';
import Dashboard from './pages/Dashboard';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import Floor from './pages/Floor';
import Quality from './pages/Quality';
import Inventory from './pages/Inventory';
import Recipes from './pages/Recipes';
import Alerts from './pages/Alerts';

const NAV = [
  ['/', 'Dashboard'],
  ['/floor', 'Production floor'],
  ['/orders', 'Orders'],
  ['/quality', 'Quality (QC)'],
  ['/inventory', 'Inventory'],
  ['/recipes', 'Dye recipes'],
  ['/alerts', 'Alerts'],
] as const;

export default function App() {
  const alerts = useApi<unknown[]>('/alerts');
  const step = useAction(() => api('/simulation/step', { method: 'POST' }));
  const [autoSim, setAutoSim] = useState(false);

  useEffect(() => {
    if (!autoSim) return;
    const t = setInterval(() => step.mutate(), 4000);
    return () => clearInterval(t);
  }, [autoSim]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>AutoTextile</span>
        </div>
        <nav>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              {label}
              {to === '/alerts' && !!alerts.data?.length && <span className="nav-count">{alerts.data.length}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sim">
          <p className="sim-title">Simulation</p>
          <p className="muted small">Completes every running stage with realistic losses and QC results.</p>
          <button onClick={() => step.mutate()} disabled={step.isPending}>Run one step</button>
          <label className="toggle">
            <input type="checkbox" checked={autoSim} onChange={(e) => setAutoSim(e.target.checked)} />
            Auto-run every 4 s
          </label>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/floor" element={<Floor />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/quality" element={<Quality />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/recipes" element={<Recipes />} />
          <Route path="/alerts" element={<Alerts />} />
        </Routes>
      </main>
    </div>
  );
}
