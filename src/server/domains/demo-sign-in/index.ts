import type { AppConfig } from "../../lib/config/index.js";
import { getVerificationClient } from "../../lib/supabase/clients.js";
import type { DemoSignInDeps } from "./service.js";

export {
  DEMO_SIGN_IN_NOT_CONFIGURED_CODE,
  DEMO_SIGN_IN_REFUSED_CODE,
  demoSignInRoutes,
} from "./routes.js";
export {
  demoSignIn,
  type DemoSession,
  type DemoSignInDeps,
} from "./service.js";

/** Production wiring: the anon-key verification client signs in, as the browser would. */
export function defaultDemoSignInDeps(config: AppConfig): DemoSignInDeps {
  return {
    appEnv: config.appEnv,
    configuredPassword: config.seed.demoPassword,
    signIn: async (email, password) => {
      const { data, error } = await getVerificationClient(
        config,
      ).auth.signInWithPassword({
        email,
        password,
      });
      if (error !== null || data.session === null) return null;
      const { access_token, refresh_token, expires_at, expires_in } =
        data.session;
      return {
        access_token,
        refresh_token,
        expires_at: expires_at ?? Math.floor(Date.now() / 1000) + expires_in,
      };
    },
  };
}
