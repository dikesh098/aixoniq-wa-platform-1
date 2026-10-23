import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../hooks/useSettings';

const NAV = [
  ['/', 'Dashboard'], ['/contacts', 'Contacts'], ['/import', 'Import CSV'], ['/unsubscribes', 'Unsubscribes'],
  ['/templates', 'Templates'], ['/campaigns', 'Campaigns'], ['/settings', 'Settings'],
] as const;

export default function Layout() {
  const { signOut, name, role, session } = useAuth();
  const { settings } = useSettings();
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="mark">A</span><div><strong>Aixoniq</strong><small>WhatsApp Platform</small></div></div>
        <nav>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>
          ))}
        </nav>
        <div className="who">
          <div>{name ?? session?.user.email}</div>
          <small>{role}</small>
          <button className="btn ghost light" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {settings?.test_mode && (
          <div className="testbar">Test mode is on. Campaigns are simulated and nothing is sent to WhatsApp.</div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
