import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { Notice } from '../components/ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setError('Sign-in failed. Check your email and password.');
    setBusy(false);
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand"><span className="mark">A</span><div><strong>Aixoniq Technologies</strong><small>WhatsApp Platform</small></div></div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="field"><label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="pw">Password</label>
          <input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <button className="btn primary" disabled={busy} style={{ width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
