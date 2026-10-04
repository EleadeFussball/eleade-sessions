// Turns whatever the website's form automation sends into the fields the app stores.
// It accepts flat objects, nested objects and lists of { label, value } pairs, and matches
// fields by what their label contains, so the form can be reworded without breaking the link.

export type Fields = Partial<Record<
  'first_name' | 'last_name' | 'parent_name' | 'parent_email' | 'parent_phone' | 'email' | 'phone' | 'dob' | 'gender' | 'age_group' |
  'position' | 'foot' | 'club' | 'heard_from' | 'message' | 'player_type', string>>;

// Order matters: the first rule that matches a label (and is still empty) wins.
const RULES: [keyof Fields, string[]][] = [
  ['parent_name', ['parentsname', 'parentname', 'guardianname', 'parentguardianname', 'parentfullname', 'contactname']],
  ['parent_email', ['parent+mail', 'guardian+mail']],
  ['parent_phone', ['parent+phone', 'parent+mobile', 'guardian+phone', 'guardian+mobile']],
  ['first_name', ['firstname', 'playerfirst', 'givenname', 'vorname']],
  ['last_name', ['lastname', 'surname', 'playerlast', 'familyname', 'nachname']],
  ['email', ['email']],
  ['phone', ['phone', 'mobile', 'telephone', 'contactnumber', 'whatsapp']],
  ['dob', ['dateofbirth', 'birthdate', 'birthday', 'dob']],
  ['gender', ['gender', 'sex']],
  ['age_group', ['agegroup', 'playerage', 'age']],
  ['position', ['position']],
  ['foot', ['foot', 'footed']],
  ['club', ['currentclub', 'academy', 'club']],
  ['heard_from', ['hear', 'referral', 'foundus']],
  ['player_type', ['playertype', 'newplayer', 'returningplayer', 'newor']],
  ['message', ['message', 'comment', 'notes', 'note', 'question', 'anythingelse', 'tellus', 'goal']],
];

const FULL_NAME = ['name', 'fullname', 'playername', 'yourname'];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function matches(key: string, alias: string): boolean {
  // "parent+phone" means both words must appear in the label
  if (alias.includes('+')) return alias.split('+').every((part) => key.includes(part));
  // very short words must be the whole label ("age" must not match "message")
  return alias.length < 4 ? key === alias : key.includes(alias);
}

/** "parents_name" or "PARENT´S Name" -> "Parents name" for showing the answer in the app. */
export function prettyLabel(label: string): string {
  const s = label.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

type Pair = [string, string];

export function flatten(input: unknown, prefix = '', out: Pair[] = [], depth = 0): Pair[] {
  if (input === null || input === undefined || depth > 6) return out;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const o = item as Record<string, unknown>;
        const label = (o.label ?? o.name ?? o.field ?? o.fieldName ?? o.key) as unknown;
        const value = (o.value ?? o.values ?? o.answer) as unknown;
        if (typeof label === 'string' && value !== undefined && typeof value !== 'object') {
          out.push([label, String(value)]);
          continue;
        }
        if (typeof label === 'string' && Array.isArray(value)) {
          out.push([label, value.map(String).join(', ')]);
          continue;
        }
      }
      flatten(item, prefix, out, depth + 1);
    }
    return out;
  }
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') flatten(v, k, out, depth + 1);
      else if (v !== undefined && v !== null) out.push([k, String(v)]);
    }
    return out;
  }
  out.push([prefix, String(input)]);
  return out;
}

export function normalise(payload: unknown): { fields: Fields; externalId: string; answers: [string, string][] } {
  const pairs = flatten(payload).filter(([, v]) => v.trim() !== '');
  const fields: Fields = {};
  let fullName = '';
  let externalId = '';
  for (const [label, value] of pairs) {
    const key = squash(label);
    if (!externalId && ['submissionid', 'entryid', 'formsubmissionid', 'submissionid'].includes(key)) externalId = value;
    if (FULL_NAME.includes(key) && !fullName) { fullName = value; continue; }
    for (const [field, aliases] of RULES) {
      if (fields[field] === undefined && aliases.some((a) => matches(key, a))) {
        fields[field] = value.trim();
        break;
      }
    }
  }
  if (!fields.first_name && fullName) {
    const parts = fullName.trim().split(/\s+/);
    fields.first_name = parts[0];
    if (!fields.last_name && parts.length > 1) fields.last_name = parts.slice(1).join(' ');
  }
  return { fields, externalId, answers: pairs.map(([l, v]) => [prettyLabel(l), v.trim()] as [string, string]) };
}
