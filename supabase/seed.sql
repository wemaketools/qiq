-- supabase/seed.sql
--
-- Owner: T-006 (M-11 layer 1, Q-8, P-03, P-04, AC-009/AC-086).
--
-- The BASELINE seed: the fixed permission catalog and the Internal-managed global default
-- reference-data template. It is executed automatically after migrations by `supabase db reset`
-- (config.toml [db.seed].sql_paths) and, against any environment, by `npm run db:seed`, which
-- extracts the delimited block below and runs it through DIRECT_DATABASE_URL (A-8: admin work
-- never goes through the pooler). Both callers therefore run the SAME statements -- there is one
-- copy of this data, not two.
--
-- SOURCE OF TRUTH. Every row here is a transcription of the .NET startup seeders, which have no
-- serverless equivalent and are replaced by this file:
--   * permissions              <- QuoteIQ.Domain/Security/PermissionCatalog.cs (`All`), applied by
--                                 QuoteIQ.Infrastructure/Security/PermissionCatalogSeeder.cs
--   * default_reference_items  <- QuoteIQ.Infrastructure/Provisioning/DefaultReferenceData.cs,
--                                 applied by .../Provisioning/DefaultTemplateSeeder.cs
-- Nothing was invented, renamed or paraphrased: a wrong permission code silently misroutes
-- authorization, and a wrong canonical_key silently corrupts every conversion metric. The
-- integration suite re-derives both inventories from those C# files and compares them row by row,
-- so a transcription error fails the build rather than shipping.
--
-- CONFLICT BEHAVIOUR IS DELIBERATELY DIFFERENT PER TABLE, matching the two .NET seeders exactly:
--   * permissions            -> ON CONFLICT DO UPDATE. The catalog is fixed and code-owned; there
--                               is no permission editing UI, so re-running re-asserts the
--                               category/description of existing rows (PermissionCatalogSeeder
--                               does the same). Rows are never DELETED even if dropped from the
--                               catalog, because role/user/group grants may still reference them.
--   * default_reference_items -> ON CONFLICT DO NOTHING. This template IS editable by Internal
--                               users (P-04), and those edits are the source of truth once made.
--                               DO UPDATE here would silently revert an Internal user's edit on
--                               the next deploy. Seeding only ever fills in what has never
--                               existed, exactly as DefaultTemplateSeeder does.
-- Either way re-running converges and never duplicates, which is what AC-009 requires.
--
-- NOT SEEDED HERE: tenant-scoped `reference_items`. Copying this template into a tenant happens at
-- tenant-creation time (T-016), not at seed time. The demo dataset is T-041.
--
-- NO cover_type ROWS. That is not an omission: DefaultReferenceData.cs documents that the PRD
-- supplies suggested defaults for all lists except cover types, which are an open client-discovery
-- question, so the .NET template carries zero cover types too. The `default_product_line_key`
-- linkage column stays unused until real cover-type defaults are agreed.
--
-- Rollback/recovery: `delete from default_reference_items;` and `delete from permissions;` (the
-- latter only after clearing role_permissions/user_permissions/group_permissions, which reference
-- it). Re-running this file restores both, since neither carries state a user created.

-- >>> QUOTEIQ BASELINE SEED BEGIN
-- Everything between these markers is the baseline layer, and is what `npm run db:seed
-- --baseline` extracts and executes. Keep later seed layers (T-041 demo data) OUTSIDE the markers.

-- Permission catalog (P-03/FR-12): 81 fixed codes. There is no free-form permission
-- creation anywhere in the product, so this list is exhaustive by design.
insert into permissions (code, category, description) values
    ('tenants.view', 'tenants', 'View tenant'),
    ('tenants.create', 'tenants', 'Create tenant'),
    ('tenants.edit', 'tenants', 'Edit tenant'),
    ('tenants.deactivate', 'tenants', 'Deactivate/remove tenant'),
    ('tenants.restore', 'tenants', 'Restore a removed tenant'),
    ('tenants.view_removed', 'tenants', 'View removed tenants'),
    ('tenants.manage_settings', 'tenants', 'Manage tenant settings'),
    ('users.view', 'users', 'View users'),
    ('users.invite', 'users', 'Invite/create user'),
    ('users.edit', 'users', 'Edit user'),
    ('users.deactivate', 'users', 'Deactivate user'),
    ('users.assign_tenant', 'users', 'Assign user to tenant'),
    ('users.assign_role', 'users', 'Assign role to user'),
    ('users.assign_group', 'users', 'Assign user to group'),
    ('users.grant_direct_permission', 'users', 'Grant direct permission to user'),
    ('roles.view', 'roles', 'View roles'),
    ('roles.manage', 'roles', 'Create, edit, and disable roles'),
    ('groups.view', 'groups', 'View user groups'),
    ('groups.manage', 'groups', 'Create, edit, and disable user groups'),
    ('leads.create', 'leads', 'Create lead'),
    ('leads.view', 'leads', 'View lead'),
    ('leads.view_all', 'leads', 'View all tenant leads (record-level visibility breadth)'),
    ('leads.update', 'leads', 'Update lead'),
    ('leads.assign', 'leads', 'Assign/reassign lead'),
    ('leads.close', 'leads', 'Close lead'),
    ('leads.delete', 'leads', 'Delete/void lead'),
    ('leads.export', 'leads', 'Export leads'),
    ('leads.reassign', 'leads', 'Bulk reassign leads'),
    ('leads.correct_closed', 'leads', 'Correct a closed lead'),
    ('leads.reopen', 'leads', 'Reopen a closed lead'),
    ('parties.create', 'parties', 'Create party'),
    ('parties.view', 'parties', 'View party'),
    ('parties.update', 'parties', 'Update party'),
    ('parties.export', 'parties', 'Export parties'),
    ('quotes.create', 'quotes', 'Create quote'),
    ('quotes.view', 'quotes', 'View quote'),
    ('quotes.view_all', 'quotes', 'View all tenant quotes (record-level visibility breadth)'),
    ('quotes.update', 'quotes', 'Update quote'),
    ('quotes.revise', 'quotes', 'Revise quote'),
    ('quotes.mark_sent', 'quotes', 'Mark quote sent'),
    ('quotes.close_won', 'quotes', 'Close quote won'),
    ('quotes.close_lost', 'quotes', 'Close quote lost'),
    ('quotes.export', 'quotes', 'Export quotes'),
    ('quotes.assign', 'quotes', 'Assign/reassign quote'),
    ('quotes.withdraw', 'quotes', 'Withdraw quote'),
    ('quotes.correct_closed', 'quotes', 'Correct a closed quote'),
    ('quotes.set_current', 'quotes', 'Set the current quote for a lead'),
    ('pricing.request', 'pricing', 'Request pricing approval'),
    ('pricing.approve', 'pricing', 'Approve pricing'),
    ('pricing.reject', 'pricing', 'Reject pricing'),
    ('brokers.view', 'brokers', 'View brokers'),
    ('brokers.manage', 'brokers', 'Manage brokers (create, edit, disable, contacts)'),
    ('brokers.manage_api_access', 'brokers', 'Manage broker API access'),
    ('brokers.view_performance', 'brokers', 'View broker performance'),
    ('reference_data.manage', 'reference_data', 'Manage tenant reference data lists'),
    ('business_rules.view', 'business_rules', 'View tenant business rules'),
    ('business_rules.manage', 'business_rules', 'Manage tenant business rules'),
    ('business_assignments.view', 'business_assignments', 'View business assignment configuration'),
    ('business_assignments.manage', 'business_assignments', 'Manage business assignment configuration'),
    ('api_access.view', 'api_access', 'View API credentials'),
    ('api_access.enable', 'api_access', 'Enable API access'),
    ('api_access.disable', 'api_access', 'Disable API access'),
    ('api_access.regenerate_secret', 'api_access', 'Regenerate API credential secret'),
    ('dashboards.view_executive', 'dashboards', 'View executive overview dashboard'),
    ('dashboards.view_pipeline', 'dashboards', 'View pipeline & conversion dashboard'),
    ('dashboards.view_broker_performance', 'dashboards', 'View broker performance dashboard'),
    ('dashboards.view_rm_performance', 'dashboards', 'View RM performance dashboard'),
    ('dashboards.view_loss_analysis', 'dashboards', 'View loss analysis dashboard'),
    ('reports.view', 'reports', 'View reports'),
    ('reports.export', 'reports', 'Export reports'),
    ('alerts.view', 'alerts', 'View alerts'),
    ('alerts.assign_owner', 'alerts', 'Assign alert owner'),
    ('alerts.escalate', 'alerts', 'Escalate alert'),
    ('alerts.resolve', 'alerts', 'Clear/resolve alert'),
    ('audit.view', 'audit', 'View tenant audit history'),
    ('global.view_any_tenant', 'global', 'View and switch into any tenant'),
    ('global.manage_templates', 'global', 'Manage global default templates'),
    ('global.cross_tenant_reporting', 'global', 'View cross-tenant reporting'),
    ('global.cross_tenant_audit_access', 'global', 'View cross-tenant audit history'),
    ('global.cross_tenant_export', 'global', 'Export data under a cross-tenant context'),
    ('global.manage_global_defaults', 'global', 'Manage global default platform data')
on conflict (code) do update
    set category    = excluded.category,
        description = excluded.description;

-- Global default reference-data template (P-04): 93 rows across ten lists.
-- Guarded lead/quote statuses carry reporting_category, canonical_key and is_terminal;
-- dashboards resolve statuses by canonical_key, never by the tenant-renameable name.
insert into default_reference_items (
    list_type, name, display_order, is_active, is_broker_channel,
    default_product_line_key, reporting_category, canonical_key, is_terminal,
    created_at, updated_at
) values
    -- request_channel
    ('request_channel', 'Broker email', 1, true, true, null, null, null, false, now(), now()),
    ('request_channel', 'Direct client', 2, true, false, null, null, null, false, now(), now()),
    ('request_channel', 'RM referral', 3, true, false, null, null, null, false, now(), now()),
    ('request_channel', 'Phone', 4, true, false, null, null, null, false, now(), now()),
    ('request_channel', 'Portal', 5, true, true, null, null, null, false, now(), now()),
    ('request_channel', 'WhatsApp', 6, true, false, null, null, null, false, now(), now()),
    ('request_channel', 'Renewal review', 7, true, false, null, null, null, false, now(), now()),
    ('request_channel', 'Walk-in / branch', 8, true, false, null, null, null, false, now(), now()),
    ('request_channel', 'Other', 9, true, false, null, null, null, false, now(), now()),
    -- product_line
    ('product_line', 'Motor', 1, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Property', 2, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Liability', 3, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Engineering', 4, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Marine', 5, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Group Life', 6, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Health', 7, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Funeral', 8, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Agriculture', 9, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Commercial Combined', 10, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Specialty Risks', 11, true, null, null, null, null, false, now(), now()),
    ('product_line', 'Other', 12, true, null, null, null, null, false, now(), now()),
    -- party_type
    ('party_type', 'Individual', 1, true, null, null, null, null, false, now(), now()),
    ('party_type', 'SME', 2, true, null, null, null, null, false, now(), now()),
    ('party_type', 'Corporate', 3, true, null, null, null, null, false, now(), now()),
    ('party_type', 'Group', 4, true, null, null, null, null, false, now(), now()),
    ('party_type', 'Government', 5, true, null, null, null, null, false, now(), now()),
    ('party_type', 'Parastatal', 6, true, null, null, null, null, false, now(), now()),
    ('party_type', 'Non-profit', 7, true, null, null, null, null, false, now(), now()),
    ('party_type', 'Other', 8, true, null, null, null, null, false, now(), now()),
    -- industry
    ('industry', 'Agriculture', 1, true, null, null, null, null, false, now(), now()),
    ('industry', 'Mining', 2, true, null, null, null, null, false, now(), now()),
    ('industry', 'Logistics / Transport', 3, true, null, null, null, null, false, now(), now()),
    ('industry', 'Hospitality', 4, true, null, null, null, null, false, now(), now()),
    ('industry', 'Retail', 5, true, null, null, null, null, false, now(), now()),
    ('industry', 'Construction', 6, true, null, null, null, null, false, now(), now()),
    ('industry', 'Manufacturing', 7, true, null, null, null, null, false, now(), now()),
    ('industry', 'Financial Services', 8, true, null, null, null, null, false, now(), now()),
    ('industry', 'Public Sector', 9, true, null, null, null, null, false, now(), now()),
    ('industry', 'Professional Services', 10, true, null, null, null, null, false, now(), now()),
    ('industry', 'Other', 11, true, null, null, null, null, false, now(), now()),
    -- party_segment
    ('party_segment', 'Retail', 1, true, null, null, null, null, false, now(), now()),
    ('party_segment', 'SME', 2, true, null, null, null, null, false, now(), now()),
    ('party_segment', 'Corporate', 3, true, null, null, null, null, false, now(), now()),
    ('party_segment', 'Strategic Account', 4, true, null, null, null, null, false, now(), now()),
    ('party_segment', 'Specialty Risks', 5, true, null, null, null, null, false, now(), now()),
    ('party_segment', 'Agriculture', 6, true, null, null, null, null, false, now(), now()),
    ('party_segment', 'Public Sector', 7, true, null, null, null, null, false, now(), now()),
    ('party_segment', 'Other', 8, true, null, null, null, null, false, now(), now()),
    -- region
    ('region', 'Botswana - National', 1, true, null, null, null, null, false, now(), now()),
    ('region', 'Gaborone', 2, true, null, null, null, null, false, now(), now()),
    ('region', 'Francistown', 3, true, null, null, null, null, false, now(), now()),
    ('region', 'Maun', 4, true, null, null, null, null, false, now(), now()),
    ('region', 'Kasane', 5, true, null, null, null, null, false, now(), now()),
    ('region', 'Lobatse', 6, true, null, null, null, null, false, now(), now()),
    ('region', 'Palapye', 7, true, null, null, null, null, false, now(), now()),
    ('region', 'Selebi-Phikwe', 8, true, null, null, null, null, false, now(), now()),
    ('region', 'Other', 9, true, null, null, null, null, false, now(), now()),
    -- lead_status
    ('lead_status', 'New', 1, true, null, null, 'open', 'new', false, now(), now()),
    ('lead_status', 'Assigned', 2, true, null, null, 'open', 'assigned', false, now(), now()),
    ('lead_status', 'Information Gathering', 3, true, null, null, 'open', 'information_gathering', false, now(), now()),
    ('lead_status', 'Underwriting', 4, true, null, null, 'open', 'underwriting', false, now(), now()),
    ('lead_status', 'Pricing', 5, true, null, null, 'open', 'pricing', false, now(), now()),
    ('lead_status', 'Quote Sent', 6, true, null, null, 'quoted', 'quote_sent', false, now(), now()),
    ('lead_status', 'Negotiation', 7, true, null, null, 'quoted', 'negotiation', false, now(), now()),
    ('lead_status', 'Closed Won', 8, true, null, null, 'won', 'closed_won', true, now(), now()),
    ('lead_status', 'Closed Lost', 9, true, null, null, 'lost', 'closed_lost', true, now(), now()),
    ('lead_status', 'Expired', 10, true, null, null, 'expired', 'expired', true, now(), now()),
    ('lead_status', 'Withdrawn', 11, true, null, null, 'withdrawn', 'withdrawn', true, now(), now()),
    -- quote_status
    ('quote_status', 'Draft', 1, true, null, null, 'open', 'draft', false, now(), now()),
    ('quote_status', 'Sent', 2, true, null, null, 'quoted', 'sent', false, now(), now()),
    ('quote_status', 'Revised', 3, true, null, null, 'quoted', 'revised', false, now(), now()),
    ('quote_status', 'Won', 4, true, null, null, 'won', 'won', true, now(), now()),
    ('quote_status', 'Lost', 5, true, null, null, 'lost', 'lost', true, now(), now()),
    ('quote_status', 'Expired', 6, true, null, null, 'expired', 'expired', true, now(), now()),
    ('quote_status', 'Withdrawn', 7, true, null, null, 'withdrawn', 'withdrawn', true, now(), now()),
    -- broker_type
    ('broker_type', 'Tier 1 - strategic partner', 1, true, null, null, null, null, false, now(), now()),
    ('broker_type', 'Tier 2 - core partner', 2, true, null, null, null, null, false, now(), now()),
    ('broker_type', 'Tier 3 - occasional partner', 3, true, null, null, null, null, false, now(), now()),
    ('broker_type', 'Direct / non-intermediated', 4, true, null, null, null, null, false, now(), now()),
    -- lost_reason
    ('lost_reason', 'Pricing too high', 1, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Competitor won', 2, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Incumbent retained', 3, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Tender exercise only', 4, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Coverage gap', 5, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Terms not accepted', 6, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Service concern', 7, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Brand / trust concern', 8, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Underwriting declined', 9, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'No response', 10, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Decision postponed', 11, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Quote expired', 12, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Lost before quote issued', 13, true, null, null, null, null, false, now(), now()),
    ('lost_reason', 'Other', 14, true, null, null, null, 'other', false, now(), now())
on conflict (list_type, name) do nothing;

-- <<< QUOTEIQ BASELINE SEED END
