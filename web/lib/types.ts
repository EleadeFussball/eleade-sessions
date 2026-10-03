export type Format = '1:1' | '2:1' | '4:1' | 'analysis' | 'testing' | 'assessment';
export type PaymentMethod = 'stripe' | 'bank' | 'cash' | 'other';
export type Outcome = 'attended' | 'cancelled_in_time' | 'cancelled_late' | 'no_show';
export type BillingModel = 'package' | 'pay_per_session';

export type Coach = {
  id: string;
  name: string;
  email: string | null;
  user_id: string | null;
  is_admin: boolean;
  active: boolean;
  salaried: boolean;
};

export type PlayerBalance = {
  player_id: string;
  name: string;
  family: string | null;
  billing_model: BillingModel;
  active: boolean;
  main_coach_id: string | null;
  opening_confirmed: boolean;
  sessions_left: number | null;
  analyses_left: number | null;
  own_sessions_left: number | null;
  last_session: string | null;
  last_purchase: string | null;
  next_expiry: string | null;
};

export type SessionRow = {
  id: string;
  session_date: string;
  start_time: string | null;
  coach_id: string;
  format: Format;
  outcome: Outcome;
  location: string | null;
  topic: string | null;
  observations: string | null;
  improve: string | null;
  imported: boolean;
  payment_status: 'awaiting' | 'confirmed' | null;
  payment_method: PaymentMethod | null;
  logged_by: string | null;
  logged_at: string;
  session_players?: { player_id: string; players?: { name: string } | null }[];
};

export const FORMAT_LABEL: Record<Format, string> = {
  '1:1': '1:1',
  '2:1': '2:1 group',
  '4:1': '4:1 group',
  analysis: 'Game analysis',
  testing: 'Testing',
  assessment: 'Assessment',
};

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  stripe: 'Stripe link',
  bank: 'Bank transfer',
  cash: 'Cash',
  other: 'Other',
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  attended: 'Attended',
  cancelled_in_time: 'Cancelled in time',
  cancelled_late: 'Cancelled late',
  no_show: 'No show',
};

export const OUTCOME_HINT: Record<Outcome, string> = {
  attended: 'Uses a credit, coach paid',
  cancelled_in_time: '12+ hours notice: free, not paid',
  cancelled_late: 'Uses a credit, coach paid',
  no_show: 'Uses a credit, coach paid',
};

export const MAX_PLAYERS: Record<Format, number> = { '1:1': 1, '2:1': 2, '4:1': 4, analysis: 1, testing: 12, assessment: 1 };

export type CoachInvoice = {
  id: string; coach_id: string; number: number; period_start: string; period_end: string; issued_on: string;
  total: number; status: 'submitted' | 'paid'; coach_name: string; coach_legal_name: string; coach_abn: string;
  bsb: string; account_number: string; account_name: string; business_name: string | null; business_abn: string | null;
  submitted_at: string; paid_at: string | null;
};

export type InvoiceLine = { session_id: string | null; line_date: string; description: string; amount: number; is_correction: boolean; no_rate?: boolean };

export const invoiceNo = (i: { coach_name: string; number: number }) =>
  `${i.coach_name.toUpperCase().replace(/[^A-Z]/g, '')}-${String(i.number).padStart(4, '0')}`;
