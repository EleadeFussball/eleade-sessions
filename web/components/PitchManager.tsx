'use client';
import { useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { loadPitches, mapsUrl, usePitches, type Pitch } from '@/lib/locations';

/** Jan only: the pitches coaches choose from, each with a Google Maps link for parents. */
export function PitchManager() {
  const pitches = usePitches();
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState('');

  async function save(p: Partial<Pitch> & { name: string }, id?: string) {
    setErr('');
    const row = { name: p.name.trim(), address: p.address?.trim() || null, maps_url: p.maps_url?.trim() || null, active: p.active ?? true,
      aliases: (p.aliases ?? []).map((a) => a.trim()).filter(Boolean) };
    if (!row.name) { setErr('Add a name.'); return; }
    const { error } = id ? await supabase.from('locations').update(row).eq('id', id) : await supabase.from('locations').insert(row);
    if (error) setErr(errorText(error)); else { setEditing(null); loadPitches(true); }
  }

  return (
    <details className="panel">
      <summary>Pitches ({pitches.filter((p) => p.active).length})</summary>
      <p className="hint">Coaches pick these when booking. Messages to parents include the Google Maps link. A pitch without an address or link shows only its name.</p>
      {err && <div className="notice err">{err}</div>}
      <ul className="list">
        {pitches.map((p) => editing === p.id
          ? <li key={p.id}><PitchForm p={p} onSave={(v) => save(v, p.id)} onCancel={() => setEditing(null)} /></li>
          : (
            <li key={p.id} style={p.active ? undefined : { opacity: .5 }}>
              <strong>{p.name}</strong>{!p.active && ' (hidden)'}<br />
              <span className="hint">{p.address ?? 'No address yet'}{p.aliases.length ? ` · also typed as ${p.aliases.join(', ')}` : ''}</span><br />
              {mapsUrl(p) ? <a href={mapsUrl(p)!} target="_blank" rel="noreferrer">Check on Google Maps</a> : <span className="tag amber">Map link missing</span>}{' '}
              <button type="button" className="linkbtn" onClick={() => setEditing(p.id)}>Edit</button>
            </li>
          ))}
      </ul>
      {editing === 'new'
        ? <PitchForm onSave={(v) => save(v)} onCancel={() => setEditing(null)} />
        : <button type="button" className="btn small ghost" onClick={() => setEditing('new')}>Add a pitch</button>}
    </details>
  );
}

function PitchForm({ p, onSave, onCancel }: { p?: Pitch; onSave: (v: Partial<Pitch> & { name: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState(p?.name ?? '');
  const [address, setAddress] = useState(p?.address ?? '');
  const [link, setLink] = useState(p?.maps_url ?? '');
  const [aliases, setAliases] = useState((p?.aliases ?? []).join(', '));
  const [active, setActive] = useState(p?.active ?? true);
  return (
    <div className="mt">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 180px' }}><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field" style={{ flex: '2 1 260px' }}><span>Address</span><input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. Darley Rd, Queens Park NSW 2022" /></label>
      </div>
      <label className="field"><span>Google Maps link <span className="hint">(optional: paste from Google Maps › Share to point at the exact field)</span></span>
        <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://maps.app.goo.gl/…" /></label>
      <label className="field"><span>Other ways coaches type it <span className="hint">(comma separated)</span></span>
        <input type="text" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="e.g. Queens park, QP" /></label>
      <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> <span>Show in the list</span></label>
      <div className="row mt">
        <button type="button" className="btn small" onClick={() => onSave({ name, address, maps_url: link, aliases: aliases.split(','), active })}>Save pitch</button>
        <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
