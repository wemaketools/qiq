/**
 * Synthetic, NON-REAL credentials used only by the CI security-scanner tests
 * (`src/server/tests/unit/ci-scan-secrets.test.ts` and `ci-scan-bundle.test.ts`) to prove the
 * scanners have teeth. None of these grant access to anything; they exist solely as planted inputs.
 *
 * This file is on the `scan-secrets.ts` ALLOWLIST by exact path, which is why it may carry these
 * fake secret-shaped strings without failing the repo-wide scan.
 */

/** A fake three-segment JWT (service-role shape). Matches the `jwt` value-shape rule. */
export const FAKE_SERVICE_ROLE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoiZmFrZSJ9.n0t-A-r34l-s1gnatur3-0nly-f0r-t3st5';

/** A fake new-format Supabase secret key. Matches the `supabase-secret-key` rule. */
export const FAKE_SB_SECRET_KEY = 'sb_secret_0123456789abcdefFAKE0123456789';

/** A fake postgres URL with an inline password. Matches the `postgres-inline-credential` rule. */
export const FAKE_POSTGRES_URL = 'postgresql://postgres:n0t-a-real-passw0rd@db.example.supabase.co:6543/postgres';

/** A fake high-entropy value assigned to a secret-named var. Matches the entropy-assignment rule. */
export const FAKE_SECRET_ASSIGNMENT = "CRON_SECRET='aG9wZWZ1bGx5Tm90UmVhbEVudHJvcHkxMjM0NTY3OA'";
