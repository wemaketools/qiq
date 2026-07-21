/**
 * Global default-template contracts (T-016; P-04, spec §11.2).
 *
 * DTO ported from `DefaultReferenceItemDto` (ReferenceItemDto.cs:33-42) — note it carries NO `id`,
 * so the template is addressed as a whole set, never row by row. The request body is
 * `ReplaceTemplateRequest(IReadOnlyList<DefaultReferenceItemInput> Items)`
 * (GlobalTemplateEndpoints.cs:49).
 *
 * Validation ported from `ReplaceDefaultReferenceItemsValidator` (:10-35):
 *   name             NotEmpty, MaximumLength(200)
 *   listType         must parse as a known reference list type
 *   productLine key  required WHEN listType == cover_type
 *   reportingCategory required, and one of the six, WHEN listType is lead_status/quote_status
 *   the set          no duplicate (listType, trimmed lowercase name) pairs
 * plus the handler's own rule (:39-54): every cover type's `defaultProductLineKey` must name an
 * ACTIVE product line inside the SAME submitted set.
 */
import { z } from 'zod';

import { REFERENCE_LIST_TYPES, REPORTING_CATEGORIES } from './canonical-statuses.js';

const STATUS_LIST_TYPES = new Set(['lead_status', 'quote_status']);
const COVER_TYPE = 'cover_type';

const templateItemSchema = z.object({
  listType: z.enum(REFERENCE_LIST_TYPES, {
    message: "EnumValidator|The submitted value is not a recognized reference list type.",
  }),
  name: z
    .string({ message: 'NotNullValidator|Name is required.' })
    .max(200, { message: "MaximumLengthValidator|'Name' must be 200 characters or fewer." })
    .refine((value) => value.trim().length > 0, {
      message: "NotEmptyValidator|'Name' must not be empty.",
    }),
  displayOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
  isBrokerChannel: z.boolean().nullish(),
  defaultProductLineKey: z.string().nullish(),
  reportingCategory: z.string().nullish(),
  canonicalKey: z.string().nullish(),
  isTerminal: z.boolean().default(false),
});

export const replaceTemplateSchema = z
  .object({ items: z.array(templateItemSchema) })
  .superRefine((body, ctx) => {
    body.items.forEach((item, index) => {
      if (item.listType === COVER_TYPE && (item.defaultProductLineKey ?? '').trim() === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'defaultProductLineKey'],
          message: 'NotEmptyValidator|Cover types require a product line.',
        });
      }

      if (STATUS_LIST_TYPES.has(item.listType)) {
        const category = item.reportingCategory;
        if (category == null || category.trim() === '') {
          ctx.addIssue({
            code: 'custom',
            path: ['items', index, 'reportingCategory'],
            message: 'NotEmptyValidator|Lead/quote statuses require a reporting category.',
          });
        } else if (!(REPORTING_CATEGORIES as readonly string[]).includes(category)) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', index, 'reportingCategory'],
            message:
              'EnumValidator|Reporting category must be one of: open, quoted, won, lost, expired, withdrawn.',
          });
        }
      }
    });

    // ReplaceDefaultReferenceItemsValidator.cs:31-35.
    const seen = new Set<string>();
    for (const item of body.items) {
      const key = `${item.listType}\u0000${item.name.trim().toLowerCase()}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items'],
          message:
            'EnumValidator|Duplicate (listType, name) pairs are not allowed in the template.',
        });
        break;
      }
      seen.add(key);
    }
  });

export type ReplaceTemplateInput = z.infer<typeof replaceTemplateSchema>;

/** Wire shape of `DefaultReferenceItemDto` — deliberately without an id. */
export interface DefaultReferenceItemDto {
  readonly listType: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly isActive: boolean;
  readonly isBrokerChannel: boolean | null;
  readonly defaultProductLineKey: string | null;
  readonly reportingCategory: string | null;
  readonly canonicalKey: string | null;
  readonly isTerminal: boolean;
}
