import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { isConfigured } from './lib/supabase';
import Layout from './components/Layout';
import { Notice } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Contacts from './pages/Contacts';
import ImportContacts from './pages/ImportContacts';
import Unsubscribes from './pages/Unsubscribes';
import Templates from './pages/Templates';
import Campaigns from './pages/Campaigns';
import CampaignEditor from './pages/CampaignEditor';
import CampaignDetail from './pages/CampaignDetail';
import Settings from './pages/Settings';

export default function App() {
  const { session, role, loading, signOut } = useAuth();

  if (!isConfigured) {
    return (
      <div className="login"><div className="card">
        <Notice kind="error">Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in, then restart the dev server.</Notice>
      </div></div>
    );
  }
  if (loading) return <div className="login"><div className="card">Loading…</div></div>;
  if (!session) return <Login />;
  if (!role) {
    return (
      <div className="login"><div className="card">
        <Notice kind="error">Your account is signed in but has not been given access. Ask an administrator to add you to the staff table.</Notice>
        <button className="btn" onClick={signOut}>Sign out</button>
      </div></div>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="import" element={<ImportContacts />} />
        <Route path="unsubscribes" element={<Unsubscribes />} />
        <Route path="templates" element={<Templates />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="campaigns/new" element={<CampaignEditor />} />
        <Route path="campaigns/:id" element={<CampaignDetail />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
