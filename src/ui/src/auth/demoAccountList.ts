/**
 * The demo personas, shared by the demo seed (scripts/db/demo-data/catalog.ts) and the sign-in quick-pick.
 * Keep this file free of imports: the seed reads it from outside the SPA.
 *
 * The SPA's quick-pick does not use DEMO_PASSWORD outside local development: deployed environments seed their
 * personas with their own password, which the build supplies as VITE_DEMO_PASSWORD (see SignInPage).
 */

/** Password of the personas on a LOCAL stack; the seed refuses to use it anywhere else. */
export const DEMO_PASSWORD = 'test1234';

export interface DemoIdentity {
  readonly key: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Role as shown on the quick-pick button. */
  readonly roleLabel: string;
}

/** Active personas only; the deactivated one cannot sign in and is not offered. */
export const DEMO_IDENTITIES: readonly DemoIdentity[] = [
  {
    key: 'internal_admin',
    email: 'internal.admin@quoteiq.local',
    firstName: 'Ava',
    lastName: 'Molefe',
    roleLabel: 'Internal Administrator',
  },
  {
    key: 'pilot_admin',
    email: 'pilot.admin@quoteiq.local',
    firstName: 'Boitumelo',
    lastName: 'Seretse',
    roleLabel: 'Tenant Administrator',
  },
  {
    key: 'multi_manager',
    email: 'sales.manager@quoteiq.local',
    firstName: 'Kagiso',
    lastName: 'Dube',
    roleLabel: 'Sales Manager',
  },
  {
    key: 'exec',
    email: 'executive@quoteiq.local',
    firstName: 'Naledi',
    lastName: 'Khama',
    roleLabel: 'Executive',
  },
  {
    key: 'rm1',
    email: 'rm.tebogo@quoteiq.local',
    firstName: 'Tebogo',
    lastName: 'Moremi',
    roleLabel: 'Relationship Manager',
  },
  {
    key: 'rm2',
    email: 'rm.lorato@quoteiq.local',
    firstName: 'Lorato',
    lastName: 'Pheto',
    roleLabel: 'Relationship Manager',
  },
  {
    key: 'rm3',
    email: 'rm.mpho@quoteiq.local',
    firstName: 'Mpho',
    lastName: 'Sekgoma',
    roleLabel: 'Relationship Manager',
  },
  {
    key: 'uw1',
    email: 'uw.thabo@quoteiq.local',
    firstName: 'Thabo',
    lastName: 'Ramotswe',
    roleLabel: 'Underwriter',
  },
  {
    key: 'uw2',
    email: 'uw.gorata@quoteiq.local',
    firstName: 'Gorata',
    lastName: 'Nkwe',
    roleLabel: 'Underwriter',
  },
  {
    key: 'single_rm',
    email: 'rm.single@quoteiq.local',
    firstName: 'Onalenna',
    lastName: 'Botha',
    roleLabel: 'Relationship Manager',
  },
  {
    key: 'partner_admin',
    email: 'partner.admin@quoteiq.local',
    firstName: 'Refilwe',
    lastName: 'Modise',
    roleLabel: 'Tenant Administrator',
  },
  {
    key: 'partner_manager',
    email: 'partner.manager@quoteiq.local',
    firstName: 'Kabelo',
    lastName: 'Tau',
    roleLabel: 'Sales Manager',
  },
  {
    key: 'partner_rm1',
    email: 'partner.rm1@quoteiq.local',
    firstName: 'Sethunya',
    lastName: 'Kgosi',
    roleLabel: 'Relationship Manager',
  },
  {
    key: 'partner_rm2',
    email: 'partner.rm2@quoteiq.local',
    firstName: 'Tumelo',
    lastName: 'Segwabe',
    roleLabel: 'Relationship Manager',
  },
  {
    key: 'partner_uw',
    email: 'partner.uw@quoteiq.local',
    firstName: 'Bonolo',
    lastName: 'Mogami',
    roleLabel: 'Underwriter',
  },
];
