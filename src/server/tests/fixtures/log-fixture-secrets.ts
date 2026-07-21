/**
 * Synthetic secrets used to prove log scrubbing (V-014). None of these are real credentials;
 * they exist only so tests can assert their absence from captured output.
 */
export const fixtureSecrets = {
  accessToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWZpeHR1cmUifQ.f1xtur3s1gnature',
  refreshToken: 'v1MTo6Zml4dHVyZS1yZWZyZXNoLXRva2Vu',
  serviceRoleKey: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.f1xtur3serv1cerole',
  password: 'Fixture-P4ssword!',
  databasePassword: 'fixture-db-p4ssword',
  apiKey: 'qiq_live_fixture0123456789',
  pepper: 'fixture-pepper-with-entropy',
} as const;

export const fixtureDatabaseUrl = `postgresql://postgres:${fixtureSecrets.databasePassword}@db.fixture.supabase.co:6543/postgres`;

/** Flat list of literals that must never appear in captured stdout. */
export const fixtureSecretLiterals: readonly string[] = Object.values(fixtureSecrets);
