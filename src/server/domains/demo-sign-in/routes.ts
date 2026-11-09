/**
 * POST /api/v1/auth/demo-sign-in — one-click sign-in for the sign-in page's demo roles.
 *
 * MOUNTED OUTSIDE THE SESSION-AUTH GROUP, like intake: the caller has no session yet. The guard is
 * the allow-list in `demoSignIn` (the shared active-persona list), so adding a route here that
 * takes an arbitrary email would turn it into a password oracle. Every refusal that is about the
 * account looks the same.
 *
 * Never logs the email's password or the tokens; the session leaves only in the response body.
 */
import { Hono } from "hono";
import { z } from "zod";

import { AppError } from "../../lib/errors/index.js";
import type { ApiEnv } from "../../lib/router/env.js";
import { parseOrThrow } from "../../lib/validation/index.js";
import { demoSignIn, type DemoSignInDeps } from "./service.js";

export const DEMO_SIGN_IN_REFUSED_CODE = "DEMO_SIGN_IN_REFUSED";
export const DEMO_SIGN_IN_NOT_CONFIGURED_CODE = "DEMO_SIGN_IN_NOT_CONFIGURED";

const bodySchema = z.object({ email: z.string().trim().min(1).max(254) });

export function demoSignInRoutes(deps: DemoSignInDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.post("/auth/demo-sign-in", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError(400, "The request body could not be read as JSON.");
    }
    const { email } = parseOrThrow(bodySchema, raw);

    const result = await demoSignIn(deps, email);
    if (result.ok) return c.json(result.value);

    c.get("logger").warn("demo sign-in refused", { reason: result.error });
    if (result.error === "not_configured") {
      // 404, not 503: the boundary sanitizes every 5xx, which would hide the reason from the page.
      throw new AppError(404, "Demo sign-in is not configured.", {
        code: DEMO_SIGN_IN_NOT_CONFIGURED_CODE,
      });
    }
    throw new AppError(403, "Demo sign-in is not available for this account.", {
      code: DEMO_SIGN_IN_REFUSED_CODE,
    });
  });

  return routes;
}
