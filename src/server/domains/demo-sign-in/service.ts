import { DEMO_IDENTITIES } from "../../../ui/src/auth/demoAccountList.js";
import { resolveDemoPassword } from "../../lib/config/demo-password.js";
import { err, ok, type Result } from "../../lib/result.js";

export interface DemoSession {
  readonly access_token: string;
  readonly refresh_token: string;
  /** Unix seconds. */
  readonly expires_at: number;
}

export type DemoSignInRefusal = "not_allowed" | "not_configured" | "rejected";

export interface DemoSignInDeps {
  readonly appEnv: string;
  /** `config.seed.demoPassword`: the secret the demo seed gave the personas in this environment. */
  readonly configuredPassword: string | null;
  /** Password sign-in against Supabase Auth; `null` when Auth refuses the credentials. */
  readonly signIn: (
    email: string,
    password: string,
  ) => Promise<DemoSession | null>;
}

const ALLOWED_EMAILS: ReadonlySet<string> = new Set(
  DEMO_IDENTITIES.map((identity) => identity.email),
);

/**
 * Signs a demo persona in on the server so the SPA never holds the demo password. Only the
 * active personas of the shared list qualify; the password is the one the seed uses.
 */
export async function demoSignIn(
  deps: DemoSignInDeps,
  email: string,
): Promise<Result<DemoSession, DemoSignInRefusal>> {
  if (!ALLOWED_EMAILS.has(email.trim().toLowerCase()))
    return err("not_allowed");

  const decision = resolveDemoPassword(deps.appEnv, deps.configuredPassword);
  if (!decision.ok) return err("not_configured");

  const session = await deps.signIn(
    email.trim().toLowerCase(),
    decision.password,
  );
  return session === null ? err("rejected") : ok(session);
}
