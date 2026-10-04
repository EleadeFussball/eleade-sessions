'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fmtDate } from '@/lib/dates';

type Info = {
  parent_name: string | null; email: string | null; phone: string | null; dob: string | null; gender: string | null;
  age_group: string | null; position: string | null; foot: string | null; club: string | null;
  heard_from: string | null; message: string | null; created_at: string;
};

/** What the parent wrote on the website form, on the player's page (for the assigned coach and Jan). */
export function EnquiryInfo({ playerId }: { playerId: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    supabase.from('enquiries')
      .select('parent_name, email, phone, dob, gender, age_group, position, foot, club, heard_from, message, created_at')
      .eq('player_id', playerId).order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => setInfo((data as Info) ?? null));
  }, [playerId]);
  if (!info) return null;
  return (
    <details className="panel">
      <summary>From the website enquiry ({fmtDate(info.created_at.slice(0, 10))})</summary>
      <dl>
        {info.parent_name && <><dt>Parent</dt><dd>{info.parent_name}</dd></>}
        {info.phone && <><dt>Phone</dt><dd><a href={`tel:${info.phone.replace(/\s/g, '')}`}>{info.phone}</a></dd></>}
        {info.email && <><dt>Email</dt><dd><a href={`mailto:${info.email}`}>{info.email}</a></dd></>}
        {info.dob && <><dt>Date of birth</dt><dd>{info.dob}</dd></>}
        {info.age_group && <><dt>Age group</dt><dd>{info.age_group}</dd></>}
        {info.position && <><dt>Position</dt><dd>{info.position}</dd></>}
        {info.foot && <><dt>Foot</dt><dd>{info.foot}</dd></>}
        {info.club && <><dt>Club or academy</dt><dd>{info.club}</dd></>}
        {info.heard_from && <><dt>Heard about us</dt><dd>{info.heard_from}</dd></>}
        {info.message && <><dt>Message</dt><dd>{info.message}</dd></>}
      </dl>
    </details>
  );
}
