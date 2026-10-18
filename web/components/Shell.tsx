'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { addDays, todayISO, fromISO, weekStart } from '@/lib/dates';
import { UploadBar, UploadProvider } from '@/lib/uploads';
import { PitchList } from '@/lib/locations';

const TABS = [
  { href: '/', label: 'Your week', admin: false },
  { href: '/players', label: 'Players', admin: false },
  { href: '/enquiries', label: 'Enquiries', admin: false },
  { href: '/week', label: 'Invoices', admin: false },
  { href: '/admin', label: 'Admin', admin: true },
  { href: '/stats', label: 'Stats', admin: true },
  { href: '/team', label: 'Team', admin: true, desk: true },
];

// "Your week" also covers the calendar and the log page it links to
const isOnPath = (path: string, href: string) =>
  href === '/' ? path === '/' || path.startsWith('/calendar') || path.startsWith('/log') : path.startsWith(href);

export function Shell({ children }: { children: ReactNode }) {
  const { loading, session, coach, isAdmin } = useAuth();
  const path = usePathname();
  const isOn = (href: string) => isOnPath(path, href);
  const router = useRouter();
  const isLogin = path === '/login';
  const [newEnquiries, setNewEnquiries] = useState(0);
  const [invoicesWaiting, setInvoicesWaiting] = useState(0);
  const [invoiceDue, setInvoiceDue] = useState(0);
  const [ownerDue, setOwnerDue] = useState(false);
  const [toInvoice, setToInvoice] = useState(0);

  // Reminder for Jan: from Sunday 5pm until Monday night, if this week's salary and Elle figures are not saved yet.
  useEffect(() => {
    if (!isAdmin) return;
    const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const dow = fromISO(todayISO()).getDay();
    if (!((dow === 0 && hour >= 17) || dow === 1)) { setOwnerDue(false); return; }
    const week = weekStart(dow === 1 ? addDays(todayISO(), -1) : todayISO());
    let alive = true;
    supabase.from('owner_weeks').select('week_start').eq('week_start', week).maybeSingle().then(({ data }) => { if (alive) setOwnerDue(!data); });
    return () => { alive = false; };
  }, [isAdmin, path]);

  // Reminder for Jan: invoices to raise in MYOB
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    supabase.rpc('invoice_reminders').then(({ data }) => {
      if (alive) setToInvoice(((data as { done_at: string | null }[]) ?? []).filter((r) => !r.done_at).length);
    });
    return () => { alive = false; };
  }, [isAdmin, path]);

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

  // Every coach sees how many new enquiries still need a call; Jan also counts his sales calls.
  useEffect(() => {
    if (!coach) return;
    let alive = true;
    const q = supabase.from('enquiries').select('id', { count: 'exact', head: true });
    (isAdmin ? q.or('status.eq.new,and(status.eq.done,outcome.eq.handover)') : q.eq('status', 'new'))
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

  // Your week badge: sessions still to document and training videos due.
  const [todo, setTodo] = useState(0);
  useEffect(() => {
    if (!coach) return;
    let alive = true;
    const count = () => Promise.all([
      supabase.rpc('undocumented_sessions', { p_coach_id: coach.id }),
      supabase.rpc('videos_due', { p_coach_id: coach.id }),
    ]).then(([d, v]) => {
      const today = todayISO();
      if (alive) setTodo(((d.data as unknown[]) ?? []).length + ((v.data as { due_on: string }[]) ?? []).filter((x) => x.due_on <= today).length);
    });
    count();
    window.addEventListener('eleade:docs-changed', count);
    window.addEventListener('eleade:clip-saved', count);
    return () => { alive = false; window.removeEventListener('eleade:docs-changed', count); window.removeEventListener('eleade:clip-saved', count); };
  }, [coach, path]);

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
    <UploadProvider>
    <div className="app">
      <div className="topbar-wrap">
        <header className="topbar">
          <Link href="/" className="brand" aria-label="Eleade, back to Your week"><img src="/eleade-logo-white.svg" alt="eleade" /></Link>
          <Link href="/account" className="who" aria-label="Account and password">{coach.name}</Link>
        </header>
      </div>
      <main className="page">
        <UploadBar />
        <PitchList />
        {!session.user.user_metadata?.password_set && path !== '/account' && (
          <div className="notice warn">
            Set a password so you can sign in without waiting for an email. <Link href="/account">Set password</Link>
          </div>
        )}
        {toInvoice > 0 && path !== '/admin' && (
          <div className="notice warn">
            {toInvoice} invoice{toInvoice === 1 ? '' : 's'} to send in MYOB. <Link href="/admin">Open Admin</Link>
          </div>
        )}
        {ownerDue && path !== '/admin' && (
          <div className="notice warn">
            Time to fill in your week: Elle hours and Tyler&apos;s Elle sessions. <Link href="/admin">Open Admin</Link>
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
          <Link key={t.href} href={t.href} className={`tab${isOn(t.href) ? ' on' : ''}${'desk' in t ? ' desk-only' : ''}`}
                aria-current={isOn(t.href) ? 'page' : undefined}>
            {t.label}
            {t.href === '/admin' && invoicesWaiting > 0 && <span className="tab-badge" aria-label={`${invoicesWaiting} invoices waiting`}>{invoicesWaiting}</span>}
            {t.href === '/' && todo > 0 && <span className="tab-badge" aria-label={`${todo} to do`}>{todo}</span>}
            {t.href === '/enquiries' && newEnquiries > 0 && <span className="tab-badge" aria-label={`${newEnquiries} waiting`}>{newEnquiries}</span>}
          </Link>
        ))}
      </nav>
    </div>
    </UploadProvider>
  );
}
