/** Plain-English labels for the codes used in the data contract. */
import type { Channel, CommuteMode, HouseholdKind, Nationality, OccupationGroup, ScenarioKind, Tenure, ViewMode } from '../types';

export const STANCE_LABEL: Record<number, string> = {
  [-2]: 'Strongly against',
  [-1]: 'Against',
  0: 'Undecided',
  1: 'In favour',
  2: 'Strongly in favour',
};

export function stanceLabel(s: number): string {
  return STANCE_LABEL[Math.max(-2, Math.min(2, Math.round(s)))];
}

/** Which side a stance is on, for colours: 'support' | 'oppose' | 'neutral'. */
export function stanceSide(s: number): 'support' | 'oppose' | 'neutral' {
  if (s >= 1) return 'support';
  if (s <= -1) return 'oppose';
  return 'neutral';
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  votation: 'City-wide vote (votation)',
  public_meeting: 'Public meeting',
  online_consultation: 'Online consultation',
};

export const CHANNEL_SHORT: Record<Channel, string> = {
  votation: 'Vote',
  public_meeting: 'Public meeting',
  online_consultation: 'Online consultation',
};

/** Default turnout assumptions for custom proposals (share of those who can take part). */
export const CHANNEL_TURNOUT: Record<Channel, number> = {
  votation: 0.065, // Paris votations 2023-2024: 5.7% to 7.5%
  public_meeting: 0.02,
  online_consultation: 0.04,
};

export const KIND_BADGE: Record<ScenarioKind, string> = {
  backtest: 'Real vote · backtest',
  hypothetical: 'Hypothetical',
  custom: 'Your proposal',
};

export const TENURE_LABEL: Record<Tenure, string> = {
  owner: 'Owns their home',
  private_renter: 'Rents privately',
  social_renter: 'Social housing tenant',
};

export const NATIONALITY_LABEL: Record<Nationality, string> = {
  french: 'French citizen',
  eu: 'EU citizen',
  non_eu: 'Non-EU citizen',
};

export const COMMUTE_LABEL: Record<CommuteMode, string> = {
  metro: 'Metro',
  rer: 'RER train',
  bus: 'Bus',
  car: 'Car',
  bike: 'Bike',
  walk: 'Walks',
  none: 'No daily commute',
};

export const HOUSEHOLD_LABEL: Record<HouseholdKind, string> = {
  single: 'Lives alone',
  couple_no_kids: 'Couple, no children',
  couple_kids: 'Couple with children',
  single_parent: 'Single parent',
};

export const OCCUPATION_LABEL: Record<OccupationGroup, string> = {
  cadres: 'Manager or professional',
  prof_inter: 'Technician or mid-level job',
  employes: 'Office or service worker',
  ouvriers: 'Manual worker',
  artisans: 'Shopkeeper, craftsperson or business owner',
  agriculteurs: 'Farmer',
  retraites: 'Retired',
  sans_activite: 'Not in work (student, carer, job-seeker)',
};

export function viewLabel(v: ViewMode, voterScope: 'paris_eligible' | 'all_residents' = 'paris_eligible'): string {
  if (v === 'everyone') return 'Everyone';
  if (v === 'eligible') return voterScope === 'paris_eligible' ? 'Can vote' : 'Can take part';
  return 'Likely to show up';
}

export const EXPOSURE_LEVEL: Record<number, string> = {
  0: 'Not touched',
  1: 'A little',
  2: 'Clearly',
  3: 'A lot',
};
