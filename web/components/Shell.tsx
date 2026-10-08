'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { todayISO, fromISO } from '@/lib/dates';

const TABS = [
  { href: '/log', label: 'Log', admin: false },
  { href: '/calendar', label: 'Calendar', admin: false },
  { href: '/players', label: 'Players', admin: false },
  { href: '/enquiries', label: 'Enquiries', admin: false },
  { href: '/week', label: 'My week', admin: false },
  { href: '/admin', label: 'Admin', admin: true },
  { href: '/stats', label: 'Stats', admin: true },
  { href: '/team', label: 'Team', admin: true },
];

export function Shell({ children }: { children: ReactNode }) {
  const { loading, session, coach, isAdmin } = useAuth();
  const path = usePathname();
  const router = useRouter();
  const isLogin = path === '/login';
  const [newEnquiries, setNewEnquiries] = useState(0);
  const [invoicesWaiting, setInvoicesWaiting] = useState(0);
  const [invoiceDue, setInvoiceDue] = useState(0);

  // Reminder for coaches: from Sunday 5pm (Sydney) until the invoice is sent, if there is anything to invoice.
  useEffect(() => {
    if (!coach || coach.salaried) return;
    const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const dow = fromISO(todayISO()).getDay(); // 0 = Sunday, 1 = Monday
    if (!((dow === 0 && hour >= 17) || dow === 1)) { setInvoiceDue(0); return; }
    let alive = true;
    supabase.rpc('invoice_draft', { p_coach_id: coach.id, p_until: todayISO() }).then(({ data }) => {
      const total = ((data as { amount: number }[]) ?? []).reduce((t, l) => t + Number(l.amount), 0);
      if (alive) setInvoiceDue(total > 0 ? total : 0);
    });
    return () => { alive = false; };
  }, [coach, path]);

  // Jan sees how many enquiries still need a coach; a coach sees how many are waiting for them.
  useEffect(() => {
    if (!coach) return;
    let alive = true;
    const q = supabase.from('enquiries').select('id', { count: 'exact', head: true });
    (isAdmin ? q.or('status.eq.new,and(status.eq.done,outcome.eq.handover)') : q.eq('status', 'assigned'))
      .then(({ count }) => { if (alive) setNewEnquiries(count ?? 0); });
    return () => { alive = false; };
  }, [coach, isAdmin, path]);

  // Jan sees how many coach invoices have been sent and are waiting to be paid.
  useEffect(() => {
    if (!coach || !isAdmin) return;
    let alive = true;
    supabase.from('coach_invoices').select('id', { count: 'exact', head: true }).eq('status', 'submitted')
      .then(({ count }) => { if (alive) setInvoicesWaiting(count ?? 0); });
    return () => { alive = false; };
  }, [coach, isAdmin, path]);

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
      <div className="topbar-wrap">
        <header className="topbar">
          <Link href="/log" className="brand" aria-label="Eleade, back to Log"><img src="/eleade-logo-white.svg" alt="eleade" /></Link>
          <Link href="/account" className="who" aria-label="Account and password">{coach.name}</Link>
        </header>
      </div>
      <main className="page">
        {!session.user.user_metadata?.password_set && path !== '/account' && (
          <div className="notice warn">
            Set a password so you can sign in without waiting for an email. <Link href="/account">Set password</Link>
          </div>
        )}
        {invoiceDue > 0 && path !== '/week' && (
          <div className="notice warn">
            Time to send your invoice for this week. <Link href="/week">Review and send</Link>
          </div>
        )}
        {children}
      </main>
      <nav className="tabs" aria-label="Main">
        {TABS.filter((t) => !t.admin || isAdmin).map((t) => (
          <Link key={t.href} href={t.href} className={path.startsWith(t.href) ? 'tab on' : 'tab'}
                aria-current={path.startsWith(t.href) ? 'page' : undefined}>
            {t.label}
            {t.href === '/admin' && invoicesWaiting > 0 && <span className="tab-badge" aria-label={`${invoicesWaiting} invoices waiting`}>{invoicesWaiting}</span>}
            {t.href === '/enquiries' && newEnquiries > 0 && <span className="tab-badge" aria-label={`${newEnquiries} waiting`}>{newEnquiries}</span>}
          </Link>
        ))}
      </nav>
    </div>
  );
}
