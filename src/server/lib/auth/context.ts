/**
 * The authenticated principal for one request (T-011, spec §13).
 *
 * Ported from the .NET `CurrentUser`/`ICurrentUser` pair, minus the ambient-service machinery:
 * there, `UserId` (the application `users.id`) started null and was populated per request by
 * `RequirePermissionFilter`. Here the same value is set once by the authentication middleware and
 * read from the Hono context, so there is no request-scoped DI container and no way for a
 * resolved id to survive into another request.
 *
 * `userId` is the application `users.id` (bigint, carried as a string — see spec §11 A-12), NOT
 * the Supabase `auth.users.id` uuid. `authUserId` is the uuid. Confusing the two is the single
 * most likely bug in this area, hence both are named explicitly.
 */
export interface AuthContext {
  /** Application `users.id`. bigint values are carried as strings to avoid precision loss. */
  readonly userId: string;
  /** Supabase `auth.users.id` (uuid) — the verified `sub` claim. */
  readonly authUserId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** The signing algorithm the token was verified with; logged, never trusted for decisions. */
  readonly tokenAlgorithm: string;
}
