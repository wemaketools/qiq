/**
 * Broker and broker-contact behaviour (T-021, AC-022, AC-024, AC-039).
 *
 * Ports the nine CQRS handlers under `src/api/QuoteIQ.Application/Features/Brokers/`:
 * ListBrokers, CreateBroker, GetBroker, UpdateBroker, DisableBroker, AddContact, UpdateContact,
 * RemoveContact, SetPrimaryContact.
 *
 * THE EXACTLY-ONE-PRIMARY INVARIANT, AND WHY IT LIVES HERE
 * =======================================================
 * `uq_broker_contacts_primary` (20260718003100_brokers.sql:100-102) enforces AT MOST one primary
 * contact per broker in the database. The other half — AT LEAST one whenever any contact exists —
 * is not expressible as a row-local constraint, so it is enforced by the three operations below
 * that can disturb it:
 *
 *   1. ADD    — a broker's FIRST contact becomes primary regardless of what the caller asked for,
 *               and a contact added AS primary demotes the incumbent (AddContactCommand.cs:6-10).
 *   2. PROMOTE— set-primary demotes the incumbent and promotes the target, atomically
 *               (SetPrimaryContactCommandHandler.cs:7-13).
 *   3. REMOVE — deleting the primary promotes the OLDEST remaining contact, so a broker is never
 *               left with contacts and no primary (RemoveContactCommandHandler.cs:11-28).
 *
 * DEMOTE BEFORE PROMOTE, ALWAYS. The index is checked per statement, not per transaction, so a
 * promote issued before the matching demote raises 23505 even though the end state would have been
 * legal. Every sequence below is ordered accordingly — the reference records the same requirement
 * as its F-043 fix, and its F-042 fix is why remove+promote share one transaction rather than being
 * two independent saves that could leave a broker with zero primaries if the second failed.
 *
 * THE REMOVAL-TIME PROMOTION RULE IS AN INHERITED AMBIGUITY, FLAGGED NOT INVENTED
 * ==============================================================================
 * `RemoveContactCommandHandler.cs:11-20` states outright that spec FR-24/AC-023 do not say what
 * happens when the primary is removed while other contacts remain, and that promoting the
 * lowest-id (oldest) survivor was the handler's own chosen rule. It is ported verbatim rather than
 * re-decided, and is re-flagged in T-021's task file so a product answer can still land later.
 *
 * EVERY MUTATION AND ITS AUDIT ROW SHARE ONE TRANSACTION (AC-024, V-031)
 * =====================================================================
 * The reference wrote its audit row through a separate `IAuditWriter` call AFTER the store call
 * (e.g. CreateBrokerCommandHandler.cs:58-62), so a crash in between produced a change with no audit
 * trail. Here each operation opens one transaction covering the reads, the writes and the audit
 * row — strictly stronger, and the pattern every other domain in this port already uses.
 */
import { writeAudit } from '../audit/index.js';
import { withTransaction, type DbClient, type TenantId } from '../../lib/db/index.js';
import {
  brokerContactNotFoundError,
  brokerNotFoundError,
  duplicateBrokerNameError,
  invalidBrokerTypeError,
} from './errors.js';
import {
  brokerNameExists,
  deleteContact,
  disableBroker as disableBrokerRow,
  findBroker,
  insertBroker,
  insertContact,
  isActiveBrokerType,
  listBrokers as listBrokerRows,
  listContacts,
  setContactPrimary,
  updateBroker as updateBrokerRow,
  updateContact as updateContactRow,
} from './repository.js';
import type {
  AddContactInput,
  BrokerContactDto,
  BrokerDetailDto,
  BrokerListDto,
  CreateBrokerInput,
  ListBrokersQuery,
  UpdateBrokerInput,
  UpdateContactInput,
} from './schemas.js';

export interface BrokersDeps {
  readonly db: DbClient;
}

/** Who performed the action and in which verified tenant, for audit rows and the `*_by` stamps. */
export interface BrokersActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly correlationId?: string;
}

export const BROKER_CREATED_ACTION = 'broker.created';
export const BROKER_UPDATED_ACTION = 'broker.updated';
export const BROKER_DISABLED_ACTION = 'broker.disabled';
export const BROKER_CONTACT_ADDED_ACTION = 'broker_contact.added';
export const BROKER_CONTACT_UPDATED_ACTION = 'broker_contact.updated';
export const BROKER_CONTACT_REMOVED_ACTION = 'broker_contact.removed';
export const BROKER_CONTACT_SET_PRIMARY_ACTION = 'broker_contact.set_primary';

/** `ListBrokersQueryHandler.cs:15-16`: below 1 falls back to the default, not to an error. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;

function auditContext(actor: BrokersActor): { context?: { correlationId: string } } {
  return actor.correlationId === undefined ? {} : { context: { correlationId: actor.correlationId } };
}

/** `null` for an absent optional field, so "omitted" and "explicitly null" behave identically. */
function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/**
 * A blank string is stored as NULL.
 *
 * The reference's `.When(!string.IsNullOrWhiteSpace(...))` guard treats "" and "   " as "no value"
 * for validation, so storing them verbatim would leave a row that is neither a valid email nor
 * absent — and `contact.email` would render as an empty string in the UI instead of nothing.
 */
function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === '' ? null : value;
}

/** The mutable broker snapshot both audit halves record (CreateBrokerCommandHandler.cs:61). */
function brokerAuditPayload(broker: {
  name: string;
  brokerTypeId: number | null;
  branch: string | null;
}): Record<string, string | number | null> {
  return { name: broker.name, brokerTypeId: broker.brokerTypeId, branch: broker.branch };
}

/** The mutable contact snapshot the update audit row records (UpdateContactCommandHandler.cs:42). */
function contactAuditPayload(contact: BrokerContactDto): Record<string, string | null> {
  return { name: contact.name, email: contact.email, phone: contact.phone };
}

/** `ListBrokersQueryHandler` (:13-22). */
export async function listBrokers(
  deps: BrokersDeps,
  query: ListBrokersQuery,
  actor: BrokersActor,
): Promise<BrokerListDto> {
  const page = query.page === undefined || query.page < 1 ? DEFAULT_PAGE : query.page;
  const pageSize =
    query.pageSize === undefined || query.pageSize < 1 ? DEFAULT_PAGE_SIZE : query.pageSize;

  const { items, totalCount } = await listBrokerRows(deps.db, actor.tenantId, {
    status: query.status,
    brokerTypeId: query.brokerTypeId,
    search: query.search,
    page,
    pageSize,
  });

  return { items, totalCount, page, pageSize };
}

/** `GetBrokerQueryHandler` (:13-23). */
export async function getBroker(
  deps: BrokersDeps,
  id: number,
  actor: BrokersActor,
): Promise<BrokerDetailDto> {
  const broker = await findBroker(deps.db, actor.tenantId, id);
  // Undefined here means "no such id IN THIS TENANT" — a row belonging to another tenant was
  // already filtered out by the tenant predicate, so it is indistinguishable from a nonexistent
  // one and yields the identical 404 (N-01, AC-022).
  if (broker === undefined) throw brokerNotFoundError(id);

  return { ...broker, contacts: await listContacts(deps.db, actor.tenantId, id) };
}

/**
 * `CreateBrokerCommandHandler` (:31-65).
 *
 * Rule order is the reference's and is observable: the duplicate-name check runs BEFORE the
 * broker-type check, so a duplicate broker with a bad type reports the duplicate (409), not the
 * type (422).
 */
export async function createBroker(
  deps: BrokersDeps,
  input: CreateBrokerInput,
  actor: BrokersActor,
): Promise<BrokerDetailDto> {
  return await withTransaction(deps.db, async (trx) => {
    if (await brokerNameExists(trx, actor.tenantId, input.name, null)) {
      throw duplicateBrokerNameError(input.name);
    }

    const brokerTypeId = orNull(input.brokerTypeId);
    if (brokerTypeId !== null && !(await isActiveBrokerType(trx, actor.tenantId, brokerTypeId))) {
      throw invalidBrokerTypeError(brokerTypeId);
    }

    const created = await insertBroker(trx, actor.tenantId, {
      name: input.name,
      brokerTypeId,
      branch: orNull(input.branch),
      actorUserId: actor.userId,
    });

    await writeAudit(trx, {
      entityType: 'broker',
      entityId: String(created.id),
      action: BROKER_CREATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: null,
      after: brokerAuditPayload(created),
      ...auditContext(actor),
    });

    // Contacts are added afterwards via the dedicated contact routes, never at creation time
    // (CreateBrokerCommand.cs:6-9), so a freshly created broker always has an empty list.
    return { ...created, contacts: [] };
  });
}

/** `UpdateBrokerCommandHandler` (:29-73). */
export async function updateBroker(
  deps: BrokersDeps,
  id: number,
  input: UpdateBrokerInput,
  actor: BrokersActor,
): Promise<BrokerDetailDto> {
  return await withTransaction(deps.db, async (trx) => {
    const existing = await findBroker(trx, actor.tenantId, id);
    if (existing === undefined) throw brokerNotFoundError(id);

    // `excludeId` is what lets a broker keep its own name on an edit that changes only the branch.
    if (await brokerNameExists(trx, actor.tenantId, input.name, id)) {
      throw duplicateBrokerNameError(input.name);
    }

    const brokerTypeId = orNull(input.brokerTypeId);
    if (brokerTypeId !== null && !(await isActiveBrokerType(trx, actor.tenantId, brokerTypeId))) {
      throw invalidBrokerTypeError(brokerTypeId);
    }

    const updated = await updateBrokerRow(trx, actor.tenantId, id, {
      name: input.name,
      brokerTypeId,
      branch: orNull(input.branch),
      actorUserId: actor.userId,
    });

    await writeAudit(trx, {
      entityType: 'broker',
      entityId: String(id),
      action: BROKER_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: brokerAuditPayload(existing),
      after: brokerAuditPayload(updated),
      ...auditContext(actor),
    });

    return { ...updated, contacts: await listContacts(trx, actor.tenantId, id) };
  });
}

/**
 * `DisableBrokerCommandHandler` (:19-40).
 *
 * IDEMPOTENT BY DESIGN: an already-disabled broker returns success WITHOUT a second audit row
 * (:27-30). A retried request therefore cannot inflate the audit trail — which matters under
 * Vercel, where a duplicate delivery is normal rather than exceptional.
 *
 * The row is never deleted (N-09, AC-075): historical leads and quotes pointing at a retired broker
 * keep resolving it, and only the active-broker picker filters it out.
 */
export async function disableBroker(
  deps: BrokersDeps,
  id: number,
  actor: BrokersActor,
): Promise<void> {
  await withTransaction(deps.db, async (trx) => {
    const existing = await findBroker(trx, actor.tenantId, id);
    if (existing === undefined) throw brokerNotFoundError(id);

    if (existing.status === 'disabled') return;

    await disableBrokerRow(trx, actor.tenantId, id, actor.userId);

    await writeAudit(trx, {
      entityType: 'broker',
      entityId: String(id),
      action: BROKER_DISABLED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { name: existing.name, status: existing.status },
      after: { name: existing.name, status: 'disabled' },
      ...auditContext(actor),
    });
  });
}

/**
 * `AddContactCommandHandler` (:31-74).
 *
 * The caller's `isPrimary` is a REQUEST, not a decision. A broker's first contact becomes primary
 * even when the caller passed false (a broker with contacts but no primary is the state the whole
 * invariant exists to prevent), and requesting primary thereafter demotes the incumbent — demote
 * first, then insert, for the index-ordering reason in the header.
 */
export async function addContact(
  deps: BrokersDeps,
  brokerId: number,
  input: AddContactInput,
  actor: BrokersActor,
): Promise<BrokerContactDto> {
  return await withTransaction(deps.db, async (trx) => {
    const broker = await findBroker(trx, actor.tenantId, brokerId);
    if (broker === undefined) throw brokerNotFoundError(brokerId);

    const existing = await listContacts(trx, actor.tenantId, brokerId);
    const makePrimary = existing.length === 0 || input.isPrimary === true;

    if (makePrimary) {
      for (const incumbent of existing.filter((contact) => contact.isPrimary)) {
        await setContactPrimary(
          trx,
          actor.tenantId,
          brokerId,
          incumbent.id,
          false,
          actor.userId,
        );
      }
    }

    const created = await insertContact(trx, actor.tenantId, {
      brokerId,
      name: input.name,
      email: blankToNull(input.email),
      phone: blankToNull(input.phone),
      isPrimary: makePrimary,
      actorUserId: actor.userId,
    });

    await writeAudit(trx, {
      entityType: 'broker_contact',
      entityId: String(created.id),
      action: BROKER_CONTACT_ADDED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: null,
      after: { brokerId, ...contactAuditPayload(created), isPrimary: created.isPrimary },
      ...auditContext(actor),
    });

    return created;
  });
}

/**
 * `UpdateContactCommandHandler` (:21-59).
 *
 * Name, email and phone only. The primary marker is changed exclusively by `setPrimaryContact`, so
 * an edit cannot disturb the invariant no matter what it carries.
 */
export async function updateContact(
  deps: BrokersDeps,
  brokerId: number,
  contactId: number,
  input: UpdateContactInput,
  actor: BrokersActor,
): Promise<BrokerContactDto> {
  return await withTransaction(deps.db, async (trx) => {
    const broker = await findBroker(trx, actor.tenantId, brokerId);
    if (broker === undefined) throw brokerNotFoundError(brokerId);

    const existing = (await listContacts(trx, actor.tenantId, brokerId)).find(
      (contact) => contact.id === contactId,
    );
    // Resolved WITHIN this broker's contacts: a contact that exists under a different broker is
    // not found here, which is what keeps the association from being decorative.
    if (existing === undefined) throw brokerContactNotFoundError(contactId);

    const updated = await updateContactRow(trx, actor.tenantId, brokerId, contactId, {
      name: input.name,
      email: blankToNull(input.email),
      phone: blankToNull(input.phone),
      actorUserId: actor.userId,
    });

    await writeAudit(trx, {
      entityType: 'broker_contact',
      entityId: String(contactId),
      action: BROKER_CONTACT_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: contactAuditPayload(existing),
      after: contactAuditPayload(updated),
      ...auditContext(actor),
    });

    return updated;
  });
}

/**
 * `RemoveContactCommandHandler` (:41-72).
 *
 * Delete, then promote the oldest survivor if the deleted contact was the primary — in that order,
 * inside one transaction (F-042/F-043). Removing a NON-primary contact promotes nobody, and
 * removing the LAST contact legitimately leaves the broker with zero contacts and zero primaries:
 * the invariant is "exactly one primary whenever any contact exists".
 */
export async function removeContact(
  deps: BrokersDeps,
  brokerId: number,
  contactId: number,
  actor: BrokersActor,
): Promise<void> {
  await withTransaction(deps.db, async (trx) => {
    const broker = await findBroker(trx, actor.tenantId, brokerId);
    if (broker === undefined) throw brokerNotFoundError(brokerId);

    const contacts = await listContacts(trx, actor.tenantId, brokerId);
    const target = contacts.find((contact) => contact.id === contactId);
    if (target === undefined) throw brokerContactNotFoundError(contactId);

    // `listContacts` orders by id, so the first survivor IS the oldest one.
    const remaining = contacts.filter((contact) => contact.id !== contactId);
    const promote = target.isPrimary && remaining.length > 0 ? remaining[0] : undefined;

    await deleteContact(trx, actor.tenantId, brokerId, contactId);

    if (promote !== undefined) {
      await setContactPrimary(trx, actor.tenantId, brokerId, promote.id, true, actor.userId);
    }

    await writeAudit(trx, {
      entityType: 'broker_contact',
      entityId: String(contactId),
      action: BROKER_CONTACT_REMOVED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { brokerId, name: target.name, wasPrimary: target.isPrimary },
      after: { promotedContactId: promote?.id ?? null },
      ...auditContext(actor),
    });
  });
}

/**
 * `SetPrimaryContactCommandHandler` (:26-59).
 *
 * Idempotent when the target already holds the marker: the reference returns early (:41-44) WITHOUT
 * writing an audit row, so a double-click cannot manufacture a second "set primary" event.
 */
export async function setPrimaryContact(
  deps: BrokersDeps,
  brokerId: number,
  contactId: number,
  actor: BrokersActor,
): Promise<BrokerContactDto> {
  return await withTransaction(deps.db, async (trx) => {
    const broker = await findBroker(trx, actor.tenantId, brokerId);
    if (broker === undefined) throw brokerNotFoundError(brokerId);

    const contacts = await listContacts(trx, actor.tenantId, brokerId);
    const target = contacts.find((contact) => contact.id === contactId);
    if (target === undefined) throw brokerContactNotFoundError(contactId);

    if (target.isPrimary) return target;

    const incumbents = contacts.filter(
      (contact) => contact.isPrimary && contact.id !== contactId,
    );
    // Demote before promote — the partial unique index is checked per statement (see header).
    for (const incumbent of incumbents) {
      await setContactPrimary(trx, actor.tenantId, brokerId, incumbent.id, false, actor.userId);
    }
    await setContactPrimary(trx, actor.tenantId, brokerId, contactId, true, actor.userId);

    await writeAudit(trx, {
      entityType: 'broker_contact',
      entityId: String(contactId),
      action: BROKER_CONTACT_SET_PRIMARY_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { brokerId, primaryContactId: incumbents[0]?.id ?? null },
      after: { brokerId, primaryContactId: contactId },
      ...auditContext(actor),
    });

    return { ...target, isPrimary: true };
  });
}
