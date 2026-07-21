/** The party fields shared between `PartyFormPage` (T-025) and the lead-intake "+ New party" inline
 * expansion (`features/leads/form/PartySection.tsx`, T-026). Kept out of `PartyFields.tsx` (which
 * exports only the component) so that file stays fast-refresh-clean. */
export interface PartyFieldValues {
  name: string;
  partyTypeId: string;
  segmentId: string;
  industryId: string;
  regionId: string;
  isStrategic: boolean;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

/** The subset of `PartyFieldValues` that is validated (mirrors `PartyFormPage`'s `FormField`). */
export type PartyFieldName = 'name' | 'partyTypeId' | 'contactName' | 'contactEmail' | 'contactPhone';

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Same lenient shape as the server's `PartyContactValidation.PhonePattern` (UX validation only —
// the backend remains the sole authority per CLAUDE.md).
export const PHONE_PATTERN = /^[+]?[0-9()\-.\s]{7,20}$/;

export function validatePartyField(field: PartyFieldName, values: PartyFieldValues): string | undefined {
  if (field === 'name') {
    return values.name.trim().length === 0 ? 'Party name is required.' : undefined;
  }
  if (field === 'partyTypeId') {
    return values.partyTypeId === '' ? 'Party type is required.' : undefined;
  }
  if (field === 'contactEmail') {
    const email = values.contactEmail.trim();
    return email.length > 0 && !EMAIL_PATTERN.test(email) ? 'Enter a valid email address.' : undefined;
  }
  if (field === 'contactPhone') {
    const phone = values.contactPhone.trim();
    return phone.length > 0 && !PHONE_PATTERN.test(phone) ? 'Enter a valid phone number.' : undefined;
  }
  return undefined;
}

export const EMPTY_PARTY_FIELD_VALUES: PartyFieldValues = {
  name: '',
  partyTypeId: '',
  segmentId: '',
  industryId: '',
  regionId: '',
  isStrategic: false,
  contactName: '',
  contactEmail: '',
  contactPhone: '',
};
