'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Admin page layout: every topic is a closed, expandable section, and the things Jan has to action
 * are collected in one "To do" summary at the top. Sections report their own count of open items
 * (even while closed), and the summary links straight to them.
 */
type Task = { label: string; count: number; id: string; order: number };
type Ctx = { tasks: Record<string, Task>; report: (key: string, t: Task | null) => void };
const TaskCtx = createContext<Ctx>({ tasks: {}, report: () => {} });

export function AdminTasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const report = useCallback((key: string, t: Task | null) => {
    setTasks((cur) => {
      const old = cur[key];
      if (!t && !old) return cur;
      if (t && old && old.count === t.count && old.label === t.label && old.id === t.id && old.order === t.order) return cur;
      const next = { ...cur };
      if (t) next[key] = t; else delete next[key];
      return next;
    });
  }, []);
  const value = useMemo(() => ({ tasks, report }), [tasks, report]);
  return <TaskCtx.Provider value={value}>{children}</TaskCtx.Provider>;
}

/** A section reports how many items need action. Count 0 removes it from the summary. */
export function useAdminTask(key: string, id: string, label: string, count: number, order: number) {
  const { report } = useContext(TaskCtx);
  useEffect(() => {
    report(key, count > 0 ? { label, count, id, order } : null);
    return () => report(key, null);
  }, [report, key, id, label, count, order]);
}

/** Opens a section and scrolls to it. */
export function openFold(id: string) {
  const el = document.getElementById(id) as HTMLDetailsElement | null;
  if (!el) return;
  el.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** The "To do" list at the top of the Admin page. */
export function AdminSummary({ ready }: { ready: boolean }) {
  const { tasks } = useContext(TaskCtx);
  const list = Object.values(tasks).sort((a, b) => a.order - b.order);
  return (
    <section className="panel admin-summary" aria-label="To do">
      <h2 style={{ marginTop: 0 }}>To do{list.length > 0 ? ` (${list.length})` : ''}</h2>
      {!ready ? <p className="empty" style={{ padding: 0 }}>Loading</p> : list.length === 0 ? (
        <p className="empty" style={{ padding: 0 }}>All clear. Nothing needs your action right now.</p>
      ) : (
        <ul className="list">
          {list.map((t) => (
            <li key={t.id}>
              <button type="button" className="linkbtn todo" onClick={() => openFold(t.id)}>
                <span>{t.label}</span>
                <span className="tag amber">{t.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One expandable topic. The component inside keeps its own title hidden; the heading here replaces it. */
export function Fold({ id, title, taskKey, children }: { id: string; title: string; taskKey?: string; children: ReactNode }) {
  const { tasks } = useContext(TaskCtx);
  const count = taskKey ? tasks[taskKey]?.count ?? 0 : 0;
  return (
    <details className="fold" id={id}>
      <summary>
        <span>{title}</span>
        {count > 0 && <span className="tag amber">{count}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
