-- 20260718001200_rbac.sql
--
-- Owner: T-003 (M-08, spec §11.1 / §13, P-03).
-- Source changelog: src/api/db/changelog/020-rbac/020-rbac-tables.xml
--   changesets 023-permissions-table .. 031-group-permissions-table.
--
-- Every table here is global/unpartitioned by design. Roles, groups and all four grant paths
-- (user->permission, user->role, group->role, group->permission) may be either tenant-scoped
-- (tenant_id set) or global/Internal (tenant_id null), so none of them can be LIST-partitioned on
-- a NOT NULL tenant_id, and none is registered with create_tenant_partitions. `permissions` is the
-- global catalog and has no tenant dimension at all.
--
-- Effective-permission resolution (T-012) unions these paths filtered to "matches the context
-- tenant OR is global", which is why tenant_id appears on user_roles and user_permissions rather
-- than only on roles/groups: a user may hold different grants per tenant (AC-018, AC-030).
--
-- Carried-over NULL semantics, preserved deliberately: PostgreSQL treats NULLs as distinct in
-- unique constraints, so `unique (tenant_id, name)` on roles does not prevent two *global* roles
-- sharing a name, and `unique (user_id, role_id, tenant_id)` does not prevent duplicate *global*
-- grants. Tenant-scoped uniqueness (non-null tenant_id) is fully enforced. This matches the .NET
-- source exactly; a duplicate grant is a no-op for the resolver, which unions into a set.
-- Tightening global-scope uniqueness, if wanted, belongs to User Manager validation (T-017).
--
-- group_roles and group_permissions carry no tenant_id: a group is already tenant-scoped (or
-- global) via user_groups.tenant_id, so its role/permission assignments inherit that scope.
--
-- Rollback/recovery: dropping any table here silently removes access grants rather than failing
-- closed, so a partial rollback can leave users with less access than intended (not more).
-- Re-running this migration recreates empty tables; the grants themselves must be restored from
-- backup or re-applied through User Manager.

create table permissions (
    code text primary key,
    category text not null,
    description text not null
);

create table roles (
    id bigint generated always as identity primary key,
    tenant_id bigint,
    name text not null,
    is_active boolean not null default true,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    constraint uq_roles_tenant_name unique (tenant_id, name)
);

create table role_permissions (
    id bigint generated always as identity primary key,
    role_id bigint not null,
    permission_code text not null,
    created_at timestamptz not null,
    created_by bigint,
    constraint fk_role_permissions_role foreign key (role_id) references roles (id),
    constraint fk_role_permissions_permission foreign key (permission_code) references permissions (code),
    constraint uq_role_permissions_role_permission unique (role_id, permission_code)
);

create table user_roles (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    role_id bigint not null,
    tenant_id bigint,
    created_at timestamptz not null,
    created_by bigint,
    constraint fk_user_roles_user foreign key (user_id) references users (id),
    constraint fk_user_roles_role foreign key (role_id) references roles (id),
    constraint uq_user_roles_user_role_tenant unique (user_id, role_id, tenant_id)
);

-- "Which users hold this role?" is asked before a role can be disabled (AC-030), and the unique
-- constraint's index leads with user_id, so role_id needs its own index.
create index ix_user_roles_role_id on user_roles (role_id);

create table user_permissions (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    permission_code text not null,
    tenant_id bigint,
    created_at timestamptz not null,
    created_by bigint,
    constraint fk_user_permissions_user foreign key (user_id) references users (id),
    constraint fk_user_permissions_permission foreign key (permission_code) references permissions (code),
    constraint uq_user_permissions_user_permission_tenant unique (user_id, permission_code, tenant_id)
);

create table user_groups (
    id bigint generated always as identity primary key,
    tenant_id bigint,
    name text not null,
    is_active boolean not null default true,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    constraint uq_user_groups_tenant_name unique (tenant_id, name)
);

create table group_members (
    id bigint generated always as identity primary key,
    group_id bigint not null,
    user_id bigint not null,
    created_at timestamptz not null,
    created_by bigint,
    constraint fk_group_members_group foreign key (group_id) references user_groups (id),
    constraint fk_group_members_user foreign key (user_id) references users (id),
    constraint uq_group_members_group_user unique (group_id, user_id)
);

-- Resolution walks user -> groups on every permission check; the unique constraint leads with
-- group_id, so the user_id direction needs its own index.
create index ix_group_members_user_id on group_members (user_id);

create table group_roles (
    id bigint generated always as identity primary key,
    group_id bigint not null,
    role_id bigint not null,
    created_at timestamptz not null,
    created_by bigint,
    constraint fk_group_roles_group foreign key (group_id) references user_groups (id),
    constraint fk_group_roles_role foreign key (role_id) references roles (id),
    constraint uq_group_roles_group_role unique (group_id, role_id)
);

create table group_permissions (
    id bigint generated always as identity primary key,
    group_id bigint not null,
    permission_code text not null,
    created_at timestamptz not null,
    created_by bigint,
    constraint fk_group_permissions_group foreign key (group_id) references user_groups (id),
    constraint fk_group_permissions_permission foreign key (permission_code) references permissions (code),
    constraint uq_group_permissions_group_permission unique (group_id, permission_code)
);
