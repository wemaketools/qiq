const TITLE_BY_PREFIX: Array<[string, string]> = [
  ['/overview', 'Executive Overview'],
  ['/dashboards/drill', 'Drill-through'],
  ['/leads', 'Leads'],
  ['/parties', 'Parties'],
  ['/pipeline', 'Pipeline & Conversion'],
  ['/brokers', 'Broker Performance'],
  ['/rm-performance', 'RM Performance'],
  ['/loss-analysis', 'Loss Analysis'],
  ['/alerts', 'Alerts'],
  ['/reports', 'Reports'],
  ['/settings', 'Settings'],
  ['/admin/users', 'User Manager'],
  ['/admin/roles', 'User Manager'],
  ['/admin/groups', 'User Manager'],
  ['/admin/tenants', 'Tenant Manager'],
];

/** Resolves the top-bar page title (spec §10.1 route map) from the current pathname. */
export function resolvePageTitle(pathname: string): string {
  const match = TITLE_BY_PREFIX.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return match?.[1] ?? 'QuoteIQ';
}
