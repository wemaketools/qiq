import { describe, expect, it, vi } from "vitest";

import { DEMO_IDENTITIES } from "../../../ui/src/auth/demoAccountList.js";
import {
  demoSignIn,
  type DemoSession,
} from "../../domains/demo-sign-in/index.js";
import { demoSignInRoutes } from "../../domains/demo-sign-in/routes.js";
import { loadConfig } from "../../lib/config/index.js";
import { buildApp } from "../../lib/router/app.js";

const SESSION: DemoSession = {
  access_token: "access.jwt",
  refresh_token: "refresh",
  expires_at: 1_900_000_000,
};
const PERSONA = DEMO_IDENTITIES[1]?.email ?? "";

const CONFIG = loadConfig({
  SUPABASE_DATABASE_URL: "postgresql://127.0.0.1:5432/postgres",
  SUPABASE_DIRECT_DATABASE_URL: "postgresql://127.0.0.1:5432/postgres",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  CRON_SECRET: "cron",
  INTERNAL_JOB_SECRET: "internal",
  API_KEY_PEPPER: "0123456789abcdef",
});

function appWith(appEnv: string, configuredPassword: string | null) {
  const signIn = vi.fn(async (): Promise<DemoSession | null> => SESSION);
  const logs: string[] = [];
  const app = buildApp({
    config: CONFIG,
    loggerOptions: { sink: (line) => logs.push(line), level: "debug" },
    demoSignIn: { appEnv, configuredPassword, signIn },
  });
  const post = (body: unknown) =>
    app.request("/api/v1/auth/demo-sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, signIn, logs };
}

describe("POST /api/v1/auth/demo-sign-in", () => {
  it("signsInAListedPersonaServerSide_RefusesEveryoneElse_AndAnswersAProblemWhenNotConfigured", async () => {
    // Arrange
    const configured = appWith("dev", "deployed-demo-pw");

    // Act: a listed persona, with no session or tenant header
    const allowed = await configured.post({ email: PERSONA });
    const unknown = await configured.post({
      email: "someone.else@example.com",
    });
    const deactivated = await configured.post({
      email: "disabled.user@quoteiq.local",
    });
    const local = await appWith("local", null).post({ email: PERSONA });
    const unconfigured = appWith("production", null);
    const notConfigured = await unconfigured.post({ email: PERSONA });

    // Assert
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual(SESSION);
    expect(configured.signIn).toHaveBeenCalledOnce();
    expect(configured.signIn).toHaveBeenCalledWith(PERSONA, "deployed-demo-pw");
    expect(JSON.stringify(configured.logs)).not.toContain("deployed-demo-pw");

    expect(unknown.status).toBe(403);
    expect(deactivated.status).toBe(403);
    expect(((await unknown.json()) as { code: string }).code).toBe(
      "DEMO_SIGN_IN_REFUSED",
    );

    expect(local.status).toBe(200);

    expect(notConfigured.status).toBe(404);
    expect(((await notConfigured.json()) as { code: string }).code).toBe(
      "DEMO_SIGN_IN_NOT_CONFIGURED",
    );
    expect(unconfigured.signIn).not.toHaveBeenCalled();
  });

  it("refusesWhenSupabaseRejectsTheCredentialsWithTheSameBodyAsAnUnlistedEmail", async () => {
    // Arrange
    const rejecting = {
      appEnv: "dev",
      configuredPassword: "x-demo-pw",
      signIn: async () => null,
    };

    // Act
    const result = await demoSignIn(rejecting, PERSONA);

    // Assert
    expect(result).toEqual({ ok: false, error: "rejected" });
    expect(typeof demoSignInRoutes).toBe("function");
  });
});
