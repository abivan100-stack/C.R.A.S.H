/* Shared intervention model (ported from intervention-model.js): dominant cause
   -> fix, cost tier, effectiveness; preventable severe incidents, rounded DOWN
   so an estimate can never overstate the harm a spend would avert. */

import type { Cause } from './constants.ts';

export interface Intervention {
  fix: string;
  cost: 'Low' | 'Medium' | 'High';
  eff: number;
}

const BY_CAUSE: Record<string, Intervention> = {
  'Over-speeding': { fix: 'Speed humps and speed-enforcement cameras on the approaches', cost: 'Medium', eff: 0.35 },
  'Signal jumping': { fix: 'Automated red-light enforcement camera at the signal', cost: 'Medium', eff: 0.3 },
  'Pothole / bad road': { fix: 'Road resurfacing and improved drainage', cost: 'High', eff: 0.25 },
  'Drunken driving': { fix: 'Night-time enforcement checkpoints', cost: 'Low', eff: 0.28 },
  'Pedestrian crossing error': { fix: 'Signalised pedestrian crossing or foot overbridge', cost: 'High', eff: 0.35 },
  'Improper overtaking': { fix: 'Lane-discipline markings, median barrier and no-overtaking signage', cost: 'Medium', eff: 0.25 },
  'Mobile phone use': { fix: 'Rumble strips, distraction-warning signage and stepped-up enforcement', cost: 'Low', eff: 0.18 },
  'Wrong-side driving': { fix: 'Median barriers and one-way channelisation with signage', cost: 'Medium', eff: 0.3 },
  'Vehicle defect': { fix: 'Vehicle fitness-check drive and improved junction lighting', cost: 'Low', eff: 0.15 },
  'Poor visibility': { fix: 'Improved lighting, reflective road markings and fog-warning signage', cost: 'Medium', eff: 0.2 },
};

const NIGHT: Intervention = { fix: 'CCTV surveillance and continuous street lighting', cost: 'Medium', eff: 0.22 };
const DEFAULT: Intervention = { fix: 'Junction redesign and signage review', cost: 'High', eff: 0.2 };

export function pickIntervention(cause: string, nightShare = 0): Intervention {
  if (Object.prototype.hasOwnProperty.call(BY_CAUSE, cause)) {
    const direct = BY_CAUSE[cause] as Intervention;
    if (cause === 'Over-speeding' || cause === 'Signal jumping' || cause === 'Pothole / bad road') return direct;
  }
  if (cause === 'Hit and run' || nightShare > 0.55) return NIGHT;
  if (Object.prototype.hasOwnProperty.call(BY_CAUSE, cause)) return BY_CAUSE[cause] as Intervention;
  return DEFAULT;
}

/** Estimated preventable severe incidents, never above the incidents that happened. */
export function preventable(fatal: number, serious: number, eff: number): number {
  const severe = (fatal || 0) + (serious || 0);
  const rate = Math.max(0, Math.min(1, eff || 0));
  return Math.min(severe, Math.floor(severe * rate));
}

export const AUTHORITY = Object.freeze({
  traffic: { name: 'Greater Chennai Traffic Police', url: 'https://www.gctp.in/' },
  civic: { name: 'Greater Chennai Corporation', url: 'https://erp.chennaicorporation.gov.in/pgr/citizen/BeforeReg.do' },
  police: { name: 'Tamil Nadu Police', url: 'https://eservices.tnpolice.gov.in/' },
  transport: { name: 'Tamil Nadu Transport Department', url: 'https://tnsta.gov.in/' },
});

const CAUSE_AUTHORITY: Record<string, keyof typeof AUTHORITY> = {
  'Over-speeding': 'traffic', 'Signal jumping': 'traffic', 'Drunken driving': 'traffic',
  'Improper overtaking': 'traffic', 'Mobile phone use': 'traffic', 'Wrong-side driving': 'traffic',
  'Pedestrian crossing error': 'traffic',
  'Pothole / bad road': 'civic', 'Poor visibility': 'civic',
  'Hit and run': 'police',
  'Vehicle defect': 'transport',
};

export function authorityFor(cause: Cause | string): { name: string; url: string } {
  const key = Object.prototype.hasOwnProperty.call(CAUSE_AUTHORITY, cause)
    ? (CAUSE_AUTHORITY[cause] as keyof typeof AUTHORITY)
    : 'traffic';
  return AUTHORITY[key] ?? AUTHORITY.traffic;
}
