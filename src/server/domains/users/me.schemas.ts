/**
 * Wire contract for the session bootstrap surface (T-015, AC-025, V-032; P-01, spec §12).
 *
 * THIS FILE IS A CONTRACT, NOT A MODEL. The SPA shell is not being rewritten by this task, so every
 * field name, casing and nullability below is transcribed from the .NET DTOs and re-checked against
 * the consumer that actually parses them:
 *
 *   src/api/QuoteIQ.Application/Features/Me/GetMe/GetMeQuery.cs:26-34   GetMeResult
 *   src/api/QuoteIQ.Application/Features/Me/GetMe/GetMeQuery.cs:41-46   MembershipDto
 *   src/api/QuoteIQ.Api/Endpoints/MeEndpoints.cs:55                     SetPreferencesRequest
 *   src/ui/src/api/me.ts:8-32                                           MeResponse / MeMembership
 *   src/ui/src/auth/AuthProvider.tsx:96                                 reads `effectivePermissions`
 *
 * System.Text.Json's camelCase policy is what turns `UserId`/`EffectivePermissions` into
 * `userId`/`effectivePermissions`; the names below are the post-policy wire names.
 *
 * NUMBERS, NOT STRINGS. `UserId`/`TenantId` are .NET `long` and serialize as JSON numbers, and
 * `src/ui/src/api/me.ts` declares them `number`. Elsewhere in this port bigints are carried as
 * strings to avoid precision loss (spec §11 A-12) — that convention is deliberately NOT applied
 * here, because changing `userId` to a string is exactly the kind of "tidy-up" that breaks
 * `m.tenantId === me.lastTenantId` in the SPA (AuthProvider.tsx:26, TenantSwitcher.tsx).
 *
 * ONE FIELD IS RENAMED BY THE CONSUMER, NOT BY US: the Redux slice stores the membership permission
 * array as `permissions` (sessionSlice.ts:17), but the WIRE name is `effectivePermissions` — the
 * rename happens in AuthProvider.tsx:96. Emitting `permissions` here would silently produce a shell
 * with no permissions at all.
 */
import { z } from 'zod';

/** One tenant the caller may act in. Mirrors `MembershipDto` (GetMeQuery.cs:41-46). */
export interface MeMembershipDto {
  readonly tenantId: number;
  readonly tenantName: string;
  /** Tenant display currency (spec §11.2, AC-074) — present for every member, not permission-gated. */
  readonly currencyCode: string;
  readonly currencySymbol: string;
  /** Effective permission codes in THIS tenant, ordinal-sorted (GetMeQueryHandler.cs:60). */
  readonly effectivePermissions: readonly string[];
}

/** `GET /api/v1/me`. Mirrors `GetMeResult` (GetMeQuery.cs:26-34). */
export interface MeResponseDto {
  readonly userId: number;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** `null`, not absent: `users.last_tenant_id` is nullable and the SPA tests it with `== null`. */
  readonly lastTenantId: number | null;
  readonly themePreference: string | null;
  readonly memberships: readonly MeMembershipDto[];
  /**
   * Tenant-less grants (the Internal/global set). For members these codes are already unioned into
   * every membership's `effectivePermissions`; carrying them separately is what lets a
   * ZERO-MEMBERSHIP Internal user drive the shell with no tenant context at all
   * (GetMeQuery.cs:17-24, sessionSlice.ts:33-39).
   */
  readonly globalPermissions: readonly string[];
}

/**
 * The theme allow-list, ported verbatim from `SetMePreferencesValidator.AllowedThemes`
 * (SetMePreferencesValidator.cs:14). Spec §12.1/NFR-04 define only these two; there is no "system"
 * value anywhere in the spec, and adding one here without adding it to the SPA's `ThemePreference`
 * union (sessionSlice.ts:27) would put an unrenderable value in the database.
 */
export const ALLOWED_THEMES = ['light', 'dark'] as const;

export type ThemePreference = (typeof ALLOWED_THEMES)[number];

/** The reference's exact validator message (SetMePreferencesValidator.cs:21). */
export const INVALID_THEME_MESSAGE = `themePreference must be one of: ${ALLOWED_THEMES.join(', ')}.`;

/**
 * `PUT /api/v1/me/preferences` body. Both fields are optional AND nullable, matching
 * `SetPreferencesRequest(long? LastTenantId, string? ThemePreference)` (MeEndpoints.cs:55).
 *
 * A null/omitted field means "leave this preference alone", NOT "clear it" — measured from
 * `UserPreferencesStore.SetPreferencesAsync` (UserPreferencesStore.cs:27-35), which assigns only
 * when the incoming value is non-null. The SPA relies on this: the tenant switcher sends
 * `{ lastTenantId }` alone (TenantSwitcher.tsx:80) and must not thereby wipe the caller's theme.
 *
 * `.max(20)` is `MaximumLength(20)` (SetMePreferencesValidator.cs:18); the allow-list check carries
 * the reference's message so the 422 detail matches.
 */
export const setMePreferencesSchema = z.object({
  lastTenantId: z.number().int().positive().nullable().optional(),
  themePreference: z
    .string()
    .max(20, INVALID_THEME_MESSAGE)
    .refine((value): value is ThemePreference => (ALLOWED_THEMES as readonly string[]).includes(value), {
      message: INVALID_THEME_MESSAGE,
    })
    .nullable()
    .optional(),
});

export type SetMePreferencesInput = z.infer<typeof setMePreferencesSchema>;
