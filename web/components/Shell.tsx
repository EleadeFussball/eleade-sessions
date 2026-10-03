'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

const TABS = [
  { href: '/log', label: 'Log', admin: false },
  { href: '/players', label: 'Players', admin: false },
  { href: '/week', label: 'My week', admin: false },
  { href: '/monday', label: 'Monday', admin: true },
  { href: '/team', label: 'Team', admin: true },
];

export function Shell({ children }: { children: ReactNode }) {
  const { loading, session, coach, isAdmin } = useAuth();
  const path = usePathname();
  const router = useRouter();
  const isLogin = path === '/login';

  useEffect(() => {
    if (!loading && !session && !isLogin) router.replace('/login');
  }, [loading, session, isLogin, router]);

  if (isLogin) return <>{children}</>;
  if (loading || !session) return <div className="boot">Loading</div>;

  if (!coach) {
    return (
      <main className="page narrow">
        <h1>No coach account linked</h1>
        <p>You are signed in as {session.user.email}, but this email is not set up as an Eleade coach. Ask Jan to add it on the Team page.</p>
        <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <Link href="/log" className="brand">eleade</Link>
        <span className="who">{coach.name}</span>
      </header>
      <main className="page">{children}</main>
      <nav className="tabs" aria-label="Main">
        {TABS.filter((t) => !t.admin || isAdmin).map((t) => (
          <Link key={t.href} href={t.href} className={path.startsWith(t.href) ? 'tab on' : 'tab'}
                aria-current={path.startsWith(t.href) ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
