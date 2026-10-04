'use client';
import { useEffect, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

/** Jan's setup panel: the address and key the website form uses to send enquiries to the app. */
export function EnquiryWebhook() {
  const [key, setKey] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const endpoint = `${URL_BASE}/functions/v1/enquiry-webhook`;

  useEffect(() => {
    supabase.rpc('get_enquiry_key').then(({ data }) => setKey(typeof data === 'string' ? data : null));
  }, []);

  async function make() {
    if (key && !window.confirm('Make a new key? The website stops sending until you paste the new key into it.')) return;
    setErr(''); setMsg('');
    const { data, error } = await supabase.rpc('rotate_enquiry_key');
    if (error) setErr(errorText(error)); else { setKey(data as string); setShow(true); }
  }

  async function copy(text: string, which: string) {
    await navigator.clipboard.writeText(text);
    setCopied(which); setTimeout(() => setCopied(''), 2500);
  }

  async function test() {
    if (!key) return;
    setErr(''); setMsg('');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-eleade-key': key },
        body: JSON.stringify({
          submissionId: `test-${Date.now()}`,
          'First Name': 'Test', 'Last Name': 'Player', Email: 'test.parent@example.com', Phone: '0400 000 000',
          'Age Group': 'U12', Message: 'Test enquiry sent from the Team page. Safe to decline.',
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) setMsg('Test enquiry sent. Open Enquiries to see it, then decline it.');
      else setErr(`The address answered with an error: ${body.error ?? res.status}`);
    } catch { setErr('Could not reach the address from this browser.'); }
  }

  return (
    <details className="panel">
      <summary>Website enquiries: connect the expression of interest form</summary>
      <p className="hint">Each submission of your Wix form is sent to the address below and appears in Enquiries. The key makes sure only your website can send.</p>
      {key && (
        <div className="field">
          <span className="fieldlabel">Address for Wix (already includes the key)</span>
          <div className="row" style={{ alignItems: 'center' }}>
            <input type={show ? 'text' : 'password'} readOnly value={`${endpoint}?key=${key}`} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn small ghost" style={{ flex: '0 0 auto' }} onClick={() => copy(`${endpoint}?key=${key}`, 'wix')}>{copied === 'wix' ? 'Copied' : 'Copy'}</button>
          </div>
          <ol className="hint">
            <li>Wix dashboard, Automations, open your form automation.</li>
            <li>Add the action &quot;Send HTTP request&quot; after the email.</li>
            <li>Method POST, paste this address, body &quot;Entire payload from trigger&quot;.</li>
            <li>Activate, then submit the form once to test.</li>
          </ol>
        </div>
      )}
      <div className="field">
        <span className="fieldlabel">Address only (POST)</span>
        <div className="row" style={{ alignItems: 'center' }}>
          <input type="text" readOnly value={endpoint} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn small ghost" style={{ flex: '0 0 auto' }} onClick={() => copy(endpoint, 'url')}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
      <div className="field">
        <span className="fieldlabel">Key (send it as the header <code>x-eleade-key</code>)</span>
        {key ? (
          <div className="row" style={{ alignItems: 'center' }}>
            <input type={show ? 'text' : 'password'} readOnly value={key} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn small ghost" style={{ flex: '0 0 auto' }} onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
            <button type="button" className="btn small ghost" style={{ flex: '0 0 auto' }} onClick={() => copy(key, 'key')}>{copied === 'key' ? 'Copied' : 'Copy'}</button>
          </div>
        ) : <p className="hint">No key yet.</p>}
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn small" onClick={make}>{key ? 'Make a new key' : 'Create key'}</button>
        {key && <button type="button" className="btn small ghost" onClick={test}>Send a test enquiry</button>}
      </div>
      {err && <div className="notice err" role="alert">{err}</div>}
      {msg && <div className="notice ok" role="status">{msg}</div>}
    </details>
  );
}
