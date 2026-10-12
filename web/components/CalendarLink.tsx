'use client';
import { useEffect, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';

/** The coach's private calendar link, with one-tap buttons for iPhone and Google Calendar. */
export function CalendarLink() {
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  async function load(reset = false) {
    setErr('');
    const { data, error } = await supabase.rpc('my_calendar_token', { p_reset: reset });
    if (error) setErr(errorText(error)); else setToken(data as string);
  }
  useEffect(() => { load(); }, []);

  if (err) return <div className="notice err" role="alert">{err}</div>;
  if (!token) return <p className="empty">Loading</p>;

  const https = `${window.location.origin}/api/calendar/${token}.ics`;
  const webcal = https.replace(/^https?:/, 'webcal:');
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;

  return (
    <div className="panel-form">
      <p style={{ marginTop: 0 }}>Your sessions appear in your phone&apos;s calendar and update by themselves. Add sessions and changes here in the app; the phone calendar only shows them.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <a className="btn small" href={webcal}>Add to iPhone calendar</a>
        <a className="btn small ghost" href={google} target="_blank" rel="noreferrer">Add to Google Calendar</a>
        <button type="button" className="btn small ghost" onClick={async () => {
          try { await navigator.clipboard.writeText(https); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
        }}>{copied ? 'Copied' : 'Copy link'}</button>
      </div>
      <p className="hint mt">iPhone: tap the button, then Subscribe. To refresh often, go to Settings › Calendar › Accounts › Fetch New Data and choose Every 15 Minutes. Google Calendar refreshes a linked calendar on its own schedule, usually every few hours.</p>
      <p className="hint">Keep this link to yourself: anyone with it can see your sessions. <button type="button" className="linkbtn" onClick={() => { if (window.confirm('Make a new link? The old one stops working, so you will need to add the calendar again.')) load(true); }}>Make a new link</button></p>
    </div>
  );
}
