SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE SCHEMA IF NOT EXISTS "public";

ALTER SCHEMA "public" OWNER TO "pg_database_owner";

COMMENT ON SCHEMA "public" IS 'standard public schema';

CREATE OR REPLACE FUNCTION "public"."create_tenant_partitions"("p_tenant_id" bigint) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
    v_table text;
begin
    for v_table in
        select c.relname
          from pg_partitioned_table p
          join pg_class c on c.oid = p.partrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           -- 'l' = LIST strategy, partitioned on exactly one column...
           and p.partstrat = 'l'
           and p.partnatts = 1
           -- ...and that column is tenant_id.
           and (select a.attname
                  from pg_attribute a
                 where a.attrelid = c.oid
                   and a.attnum = p.partattrs[0]) = 'tenant_id'
         order by c.relname
    loop
        -- public. is explicit because search_path is empty: without it CREATE TABLE has no
        -- schema to create in.
        execute format(
            'create table if not exists public.%I partition of public.%I for values in (%L)',
            v_table || '_p' || p_tenant_id,
            v_table,
            p_tenant_id
        );
    end loop;
end;
$$;

ALTER FUNCTION "public"."create_tenant_partitions"("p_tenant_id" bigint) OWNER TO "postgres";

COMMENT ON FUNCTION "public"."create_tenant_partitions"("p_tenant_id" bigint) IS 'Creates the per-tenant partition on every public LIST(tenant_id)-partitioned table. Called inside the tenant-creation transaction (T-016); idempotent, so it is also the backfill path when a new partitioned table is added for existing tenants.';

CREATE OR REPLACE FUNCTION "public"."invoke_cron_endpoint"("job_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'net'
    AS $$
declare
    config public.job_cron_config;
begin
    select * into config from public.job_cron_config limit 1;

    if not found then
        -- The expected state locally. Not an error: see the T-032 migration's header.
        raise notice 'invoke_cron_endpoint(%): job_cron_config is empty; skipping. This is expected in local development, where npm run cron:run drives the sweeps.', job_name;
        return;
    end if;

    -- Fire-and-forget: pg_net queues the request and returns immediately, so a slow or unreachable
    -- endpoint can never block the cron worker or hold a transaction open. The endpoint's own
    -- job_run row is the durable record of what happened.
    perform net.http_get(
        url := config.base_url || '/api/cron/' || job_name,
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || config.cron_secret,
            'Content-Type', 'application/json'
        ),
        timeout_milliseconds := 5000
    );
end;
$$;

ALTER FUNCTION "public"."invoke_cron_endpoint"("job_name" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."invoke_cron_endpoint"("job_name" "text") IS 'Calls /api/cron/{job_name} on the configured origin with the CRON_SECRET bearer header via pg_net (net.http_get). No-ops with a NOTICE when job_cron_config is empty (the local state).';

CREATE OR REPLACE FUNCTION "public"."invoke_queue_drain"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'net'
    AS $$
declare
    config public.job_cron_config;
begin
    select * into config from public.job_cron_config limit 1;

    if not found then
        raise notice 'invoke_queue_drain: job_cron_config is empty; skipping. This is expected in local development, where npm run queue:worker drains the queue.';
        return;
    end if;

    if config.internal_job_secret is null then
        -- Named distinctly from the empty-table case: "the row exists but the drain half was never
        -- configured" is a DIFFERENT operator mistake from "nothing is configured", and an
        -- environment where alerts silently stop clearing within the minute is worth one clear line
        -- in the log rather than the same generic notice.
        raise notice 'invoke_queue_drain: job_cron_config.internal_job_secret is null; skipping. Set it to the deployment''s INTERNAL_JOB_SECRET to enable the every-minute drain.';
        return;
    end if;

    perform net.http_post(
        url := config.base_url || '/api/queue/drain',
        body := '{}'::jsonb,
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || config.internal_job_secret,
            'Content-Type', 'application/json'
        ),
        timeout_milliseconds := 5000
    );
end;
$$;

ALTER FUNCTION "public"."invoke_queue_drain"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."invoke_queue_drain"() IS 'Calls POST /api/queue/drain on the configured origin with the INTERNAL_JOB_SECRET bearer header via pg_net (net.http_post). No-ops with a NOTICE when unconfigured (the local state).';

SET default_tablespace = '';

CREATE TABLE IF NOT EXISTS "public"."alerts" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "type" "text" NOT NULL,
    "lead_id" bigint NOT NULL,
    "quote_id" bigint,
    "severity" "text" NOT NULL,
    "premium_at_risk" numeric(18,2),
    "created_at" timestamp with time zone NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_reason" "text",
    CONSTRAINT "alerts_type_check" CHECK (("type" = ANY (ARRAY['unassigned_lead'::"text", 'overdue_follow_up'::"text", 'stalled_lead'::"text", 'stalled_quote'::"text", 'quote_expiring'::"text", 'quote_expired'::"text", 'sla_breach'::"text", 'high_value_stalled'::"text", 'pending_pricing_approval'::"text", 'awaiting_underwriting'::"text", 'executive_escalation'::"text"])))
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."alerts" OWNER TO "postgres";

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."alerts_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "type" "text" NOT NULL,
    "lead_id" bigint NOT NULL,
    "quote_id" bigint,
    "severity" "text" NOT NULL,
    "premium_at_risk" numeric(18,2),
    "created_at" timestamp with time zone NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_reason" "text",
    CONSTRAINT "alerts_type_check" CHECK (("type" = ANY (ARRAY['unassigned_lead'::"text", 'overdue_follow_up'::"text", 'stalled_lead'::"text", 'stalled_quote'::"text", 'quote_expiring'::"text", 'quote_expired'::"text", 'sla_breach'::"text", 'high_value_stalled'::"text", 'pending_pricing_approval'::"text", 'awaiting_underwriting'::"text", 'executive_escalation'::"text"])))
);

ALTER TABLE "public"."alerts_default" OWNER TO "postgres";

ALTER TABLE "public"."alerts" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."alerts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."api_credentials" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "broker_id" bigint,
    "key_id" "text" NOT NULL,
    "key_hash" "text" NOT NULL,
    "key_salt" "text" NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "last_rotated_at" timestamp with time zone,
    "disabled_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    CONSTRAINT "ck_api_credentials_status" CHECK (("status" = ANY (ARRAY['active'::"text", 'disabled'::"text"])))
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."api_credentials" OWNER TO "postgres";

COMMENT ON COLUMN "public"."api_credentials"."key_hash" IS 'Salted + peppered one-way hash of the API key secret. Verify-only: the plaintext key is shown once at issue/regenerate and is never recoverable. The pepper lives in env config, not in the database. Never add a column that can hold a usable key (Q-19, spec §16).';

CREATE TABLE IF NOT EXISTS "public"."api_credentials_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "broker_id" bigint,
    "key_id" "text" NOT NULL,
    "key_hash" "text" NOT NULL,
    "key_salt" "text" NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "last_rotated_at" timestamp with time zone,
    "disabled_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    CONSTRAINT "ck_api_credentials_status" CHECK (("status" = ANY (ARRAY['active'::"text", 'disabled'::"text"])))
);

ALTER TABLE "public"."api_credentials_default" OWNER TO "postgres";

ALTER TABLE "public"."api_credentials" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."api_credentials_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" bigint NOT NULL,
    "tenant_id" bigint,
    "entity_type" "text" NOT NULL,
    "entity_id" "text" NOT NULL,
    "action" "text" NOT NULL,
    "actor_user_id" bigint,
    "actor_label" "text",
    "acted_at" timestamp with time zone NOT NULL,
    "details" "jsonb"
);

ALTER TABLE "public"."audit_log" OWNER TO "postgres";

ALTER TABLE "public"."audit_log" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."audit_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."broker_contacts" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "broker_id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "is_primary" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."broker_contacts" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."broker_contacts_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "broker_id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "is_primary" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
);

ALTER TABLE "public"."broker_contacts_default" OWNER TO "postgres";

ALTER TABLE "public"."broker_contacts" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."broker_contacts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."brokers" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "broker_type_id" bigint,
    "branch" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_brokers_status" CHECK (("status" = ANY (ARRAY['active'::"text", 'disabled'::"text"])))
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."brokers" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."brokers_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "broker_type_id" bigint,
    "branch" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_brokers_status" CHECK (("status" = ANY (ARRAY['active'::"text", 'disabled'::"text"])))
);

ALTER TABLE "public"."brokers_default" OWNER TO "postgres";

ALTER TABLE "public"."brokers" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."brokers_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."business_assignments" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "role_id" bigint NOT NULL,
    "slot" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_business_assignments_slot" CHECK (("slot" = ANY (ARRAY['rm'::"text", 'underwriter'::"text"])))
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."business_assignments" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."business_assignments_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "role_id" bigint NOT NULL,
    "slot" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_business_assignments_slot" CHECK (("slot" = ANY (ARRAY['rm'::"text", 'underwriter'::"text"])))
);

ALTER TABLE "public"."business_assignments_default" OWNER TO "postgres";

ALTER TABLE "public"."business_assignments" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."business_assignments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."default_reference_items" (
    "id" bigint NOT NULL,
    "list_type" "text" NOT NULL,
    "name" "text" NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "is_broker_channel" boolean,
    "default_product_line_key" "text",
    "reporting_category" "text",
    "canonical_key" "text",
    "is_terminal" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_default_reference_items_list_type" CHECK (("list_type" = ANY (ARRAY['request_channel'::"text", 'product_line'::"text", 'cover_type'::"text", 'party_segment'::"text", 'industry'::"text", 'region'::"text", 'party_type'::"text", 'lead_status'::"text", 'quote_status'::"text", 'lost_reason'::"text", 'broker_type'::"text"]))),
    CONSTRAINT "ck_default_reference_items_reporting_category" CHECK ((("reporting_category" IS NULL) OR ("reporting_category" = ANY (ARRAY['open'::"text", 'quoted'::"text", 'won'::"text", 'lost'::"text", 'expired'::"text", 'withdrawn'::"text"]))))
);

ALTER TABLE "public"."default_reference_items" OWNER TO "postgres";

ALTER TABLE "public"."default_reference_items" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."default_reference_items_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."follow_ups" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "follow_up_date" "date" NOT NULL,
    "outcome_note" "text" NOT NULL,
    "next_follow_up_date" "date",
    "logged_by" bigint,
    "logged_at" timestamp with time zone NOT NULL
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."follow_ups" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."follow_ups_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "follow_up_date" "date" NOT NULL,
    "outcome_note" "text" NOT NULL,
    "next_follow_up_date" "date",
    "logged_by" bigint,
    "logged_at" timestamp with time zone NOT NULL
);

ALTER TABLE "public"."follow_ups_default" OWNER TO "postgres";

ALTER TABLE "public"."follow_ups" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."follow_ups_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."group_members" (
    "id" bigint NOT NULL,
    "group_id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
);

ALTER TABLE "public"."group_members" OWNER TO "postgres";

ALTER TABLE "public"."group_members" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."group_members_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."group_permissions" (
    "id" bigint NOT NULL,
    "group_id" bigint NOT NULL,
    "permission_code" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
);

ALTER TABLE "public"."group_permissions" OWNER TO "postgres";

ALTER TABLE "public"."group_permissions" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."group_permissions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."group_roles" (
    "id" bigint NOT NULL,
    "group_id" bigint NOT NULL,
    "role_id" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
);

ALTER TABLE "public"."group_roles" OWNER TO "postgres";

ALTER TABLE "public"."group_roles" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."group_roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."job_cron_config" (
    "id" boolean DEFAULT true NOT NULL,
    "base_url" "text" NOT NULL,
    "cron_secret" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "internal_job_secret" "text",
    CONSTRAINT "job_cron_config_single_row" CHECK ("id")
);

ALTER TABLE "public"."job_cron_config" OWNER TO "postgres";

COMMENT ON TABLE "public"."job_cron_config" IS 'Single-row infrastructure config for the pg_cron -> pg_net job schedules (T-032). Holds a bearer secret: service-role only. Populated per environment out of band, NEVER by a migration or by the committed seed, and never present in local development (see Q-7).';

COMMENT ON COLUMN "public"."job_cron_config"."internal_job_secret" IS 'The INTERNAL_JOB_SECRET value /api/queue/drain authenticates against (T-034). Separate from cron_secret so a leak of one does not authorize the other. NULL = drain schedule no-ops.';

CREATE TABLE IF NOT EXISTS "public"."job_idempotency_key" (
    "key" "text" NOT NULL,
    "job_name" "text" NOT NULL,
    "tenant_id" bigint,
    "claimed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_run_id" bigint
);

ALTER TABLE "public"."job_idempotency_key" OWNER TO "postgres";

COMMENT ON TABLE "public"."job_idempotency_key" IS 'Claimed idempotency keys for queue messages (spec §9.5). Claimed in the SAME transaction as the handler effect, so a duplicate delivery is a no-op and a failed attempt releases the key.';

CREATE TABLE IF NOT EXISTS "public"."job_run" (
    "id" bigint NOT NULL,
    "job_name" "text" NOT NULL,
    "trigger" "text" NOT NULL,
    "environment" "text" NOT NULL,
    "correlation_id" "text" NOT NULL,
    "idempotency_key" "text",
    "message_id" bigint,
    "attempt" integer DEFAULT 1 NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "duration_ms" integer,
    "status" "text" NOT NULL,
    "error_class" "text",
    "error_message" "text",
    "error_stack" "text",
    "counts" "jsonb",
    CONSTRAINT "ck_job_run_attempt_positive" CHECK (("attempt" >= 1)),
    CONSTRAINT "ck_job_run_duration_non_negative" CHECK ((("duration_ms" IS NULL) OR ("duration_ms" >= 0))),
    CONSTRAINT "ck_job_run_environment" CHECK (("environment" = ANY (ARRAY['local'::"text", 'preview'::"text", 'staging'::"text", 'production'::"text"]))),
    CONSTRAINT "ck_job_run_failure_has_error" CHECK ((("status" <> 'failed'::"text") OR ("error_message" IS NOT NULL))),
    CONSTRAINT "ck_job_run_status" CHECK (("status" = ANY (ARRAY['running'::"text", 'succeeded'::"text", 'failed'::"text"]))),
    CONSTRAINT "ck_job_run_terminal_has_finish" CHECK (((("status" = 'running'::"text") AND ("finished_at" IS NULL) AND ("duration_ms" IS NULL)) OR (("status" <> 'running'::"text") AND ("finished_at" IS NOT NULL) AND ("duration_ms" IS NOT NULL)))),
    CONSTRAINT "ck_job_run_trigger" CHECK (("trigger" = ANY (ARRAY['cron'::"text", 'queue'::"text", 'manual'::"text"])))
);

ALTER TABLE "public"."job_run" OWNER TO "postgres";

COMMENT ON TABLE "public"."job_run" IS 'Durable per-attempt history of every background job execution (spec §9.5, AC-063). Replaces the Hangfire dashboard/job store; read by `npm run jobs:status`.';

COMMENT ON COLUMN "public"."job_run"."attempt" IS 'Delivery attempt number: 1 for a first run, pgmq read_ct for a redelivered queue message.';

COMMENT ON COLUMN "public"."job_run"."counts" IS 'Per-run outcome counters for operators (observability payload, not a queryable business field).';

ALTER TABLE "public"."job_run" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."job_run_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."lead_assignments" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "business_assignment_id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."lead_assignments" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."lead_assignments_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "business_assignment_id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
);

ALTER TABLE "public"."lead_assignments_default" OWNER TO "postgres";

ALTER TABLE "public"."lead_assignments" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lead_assignments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."lead_notes" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."lead_notes" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."lead_notes_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
);

ALTER TABLE "public"."lead_notes_default" OWNER TO "postgres";

ALTER TABLE "public"."lead_notes" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lead_notes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."lead_status_history" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "operation" "text" NOT NULL,
    "previous_status_id" bigint,
    "new_status_id" bigint,
    "acted_by" bigint,
    "acted_at" timestamp with time zone NOT NULL,
    "inputs" "jsonb"
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."lead_status_history" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."lead_status_history_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "operation" "text" NOT NULL,
    "previous_status_id" bigint,
    "new_status_id" bigint,
    "acted_by" bigint,
    "acted_at" timestamp with time zone NOT NULL,
    "inputs" "jsonb"
);

ALTER TABLE "public"."lead_status_history_default" OWNER TO "postgres";

ALTER TABLE "public"."lead_status_history" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lead_status_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."leads" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "party_id" bigint NOT NULL,
    "lead_ref" "text" NOT NULL,
    "external_ref" "text",
    "date_received" "date" NOT NULL,
    "request_channel_id" bigint NOT NULL,
    "broker_id" bigint,
    "region_id" bigint NOT NULL,
    "product_line_id" bigint NOT NULL,
    "cover_type_id" bigint NOT NULL,
    "sum_insured" numeric(18,2),
    "estimated_premium" numeric(18,2),
    "policy_term" "text" NOT NULL,
    "policy_term_other" "text",
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "is_existing_client" boolean DEFAULT false NOT NULL,
    "status_id" bigint NOT NULL,
    "pricing_approval_state" "text" DEFAULT 'none'::"text" NOT NULL,
    "date_assigned" timestamp with time zone,
    "decision_date" timestamp with time zone,
    "lost_reason_id" bigint,
    "lost_before_quote" boolean,
    "competitor" "text",
    "competitor_premium" numeric(18,2),
    "loss_comments" "text",
    "withdrawal_note" "text",
    "last_activity_at" timestamp with time zone,
    "last_follow_up_date" "date",
    "next_follow_up_date" "date",
    "follow_up_count" integer DEFAULT 0 NOT NULL,
    "source" "text" NOT NULL,
    "intake_credential_id" bigint,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_leads_policy_term" CHECK (("policy_term" = ANY (ARRAY['m6'::"text", 'm12'::"text", 'm24'::"text", 'm36'::"text", 'other'::"text"]))),
    CONSTRAINT "ck_leads_pricing_approval_state" CHECK (("pricing_approval_state" = ANY (ARRAY['none'::"text", 'pending'::"text", 'approved'::"text", 'rejected'::"text"]))),
    CONSTRAINT "ck_leads_priority" CHECK (("priority" = ANY (ARRAY['normal'::"text", 'high'::"text"]))),
    CONSTRAINT "ck_leads_source" CHECK (("source" = ANY (ARRAY['browser'::"text", 'api'::"text"])))
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."leads" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."leads_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "party_id" bigint NOT NULL,
    "lead_ref" "text" NOT NULL,
    "external_ref" "text",
    "date_received" "date" NOT NULL,
    "request_channel_id" bigint NOT NULL,
    "broker_id" bigint,
    "region_id" bigint NOT NULL,
    "product_line_id" bigint NOT NULL,
    "cover_type_id" bigint NOT NULL,
    "sum_insured" numeric(18,2),
    "estimated_premium" numeric(18,2),
    "policy_term" "text" NOT NULL,
    "policy_term_other" "text",
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "is_existing_client" boolean DEFAULT false NOT NULL,
    "status_id" bigint NOT NULL,
    "pricing_approval_state" "text" DEFAULT 'none'::"text" NOT NULL,
    "date_assigned" timestamp with time zone,
    "decision_date" timestamp with time zone,
    "lost_reason_id" bigint,
    "lost_before_quote" boolean,
    "competitor" "text",
    "competitor_premium" numeric(18,2),
    "loss_comments" "text",
    "withdrawal_note" "text",
    "last_activity_at" timestamp with time zone,
    "last_follow_up_date" "date",
    "next_follow_up_date" "date",
    "follow_up_count" integer DEFAULT 0 NOT NULL,
    "source" "text" NOT NULL,
    "intake_credential_id" bigint,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_leads_policy_term" CHECK (("policy_term" = ANY (ARRAY['m6'::"text", 'm12'::"text", 'm24'::"text", 'm36'::"text", 'other'::"text"]))),
    CONSTRAINT "ck_leads_pricing_approval_state" CHECK (("pricing_approval_state" = ANY (ARRAY['none'::"text", 'pending'::"text", 'approved'::"text", 'rejected'::"text"]))),
    CONSTRAINT "ck_leads_priority" CHECK (("priority" = ANY (ARRAY['normal'::"text", 'high'::"text"]))),
    CONSTRAINT "ck_leads_source" CHECK (("source" = ANY (ARRAY['browser'::"text", 'api'::"text"])))
);

ALTER TABLE "public"."leads_default" OWNER TO "postgres";

ALTER TABLE "public"."leads" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."leads_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."parties" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "party_type_id" bigint NOT NULL,
    "segment_id" bigint,
    "industry_id" bigint,
    "region_id" bigint,
    "is_strategic" boolean DEFAULT false NOT NULL,
    "contact_name" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "last_activity_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."parties" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."parties_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "party_type_id" bigint NOT NULL,
    "segment_id" bigint,
    "industry_id" bigint,
    "region_id" bigint,
    "is_strategic" boolean DEFAULT false NOT NULL,
    "contact_name" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "last_activity_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
);

ALTER TABLE "public"."parties_default" OWNER TO "postgres";

ALTER TABLE "public"."parties" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."parties_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."permissions" (
    "code" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text" NOT NULL
);

ALTER TABLE "public"."permissions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."pricing_approvals" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "requested_by" bigint NOT NULL,
    "requested_at" timestamp with time zone NOT NULL,
    "approver_id" bigint NOT NULL,
    "proposed_premium" numeric(18,2),
    "request_note" "text",
    "state" "text" NOT NULL,
    "decided_by" bigint,
    "decided_at" timestamp with time zone,
    "decision_note" "text",
    "rejection_reason" "text",
    CONSTRAINT "ck_pricing_approvals_state" CHECK (("state" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."pricing_approvals" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."pricing_approvals_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "requested_by" bigint NOT NULL,
    "requested_at" timestamp with time zone NOT NULL,
    "approver_id" bigint NOT NULL,
    "proposed_premium" numeric(18,2),
    "request_note" "text",
    "state" "text" NOT NULL,
    "decided_by" bigint,
    "decided_at" timestamp with time zone,
    "decision_note" "text",
    "rejection_reason" "text",
    CONSTRAINT "ck_pricing_approvals_state" CHECK (("state" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);

ALTER TABLE "public"."pricing_approvals_default" OWNER TO "postgres";

ALTER TABLE "public"."pricing_approvals" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."pricing_approvals_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."quote_assignments" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "quote_id" bigint NOT NULL,
    "business_assignment_id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."quote_assignments" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."quote_assignments_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "quote_id" bigint NOT NULL,
    "business_assignment_id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
);

ALTER TABLE "public"."quote_assignments_default" OWNER TO "postgres";

ALTER TABLE "public"."quote_assignments" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."quote_assignments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."quote_attachments" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "quote_id" bigint NOT NULL,
    "file_name" "text" NOT NULL,
    "content_type" "text" NOT NULL,
    "size_bytes" bigint NOT NULL,
    "storage_key" "text" NOT NULL,
    "uploaded_at" timestamp with time zone NOT NULL,
    "uploaded_by" bigint,
    "removed_at" timestamp with time zone,
    "removed_by" bigint,
    "confirmed_at" timestamp with time zone
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."quote_attachments" OWNER TO "postgres";

COMMENT ON COLUMN "public"."quote_attachments"."storage_key" IS 'Tenant-prefixed object key in the private Supabase Storage bucket (A-6). Attachment BYTES live in Storage and are served only through the signed-URL envelope flow (A-7) — never add a bytea column to this table.';

COMMENT ON COLUMN "public"."quote_attachments"."confirmed_at" IS 'NULL until the A-7 signed-URL upload is confirmed server-side (object verified: exists, within the tenant size cap, magic number agrees with the declared content type). Rows with a NULL confirmed_at are pending uploads and must never appear in a read path or be downloadable.';

CREATE TABLE IF NOT EXISTS "public"."quote_attachments_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "quote_id" bigint NOT NULL,
    "file_name" "text" NOT NULL,
    "content_type" "text" NOT NULL,
    "size_bytes" bigint NOT NULL,
    "storage_key" "text" NOT NULL,
    "uploaded_at" timestamp with time zone NOT NULL,
    "uploaded_by" bigint,
    "removed_at" timestamp with time zone,
    "removed_by" bigint,
    "confirmed_at" timestamp with time zone
);

ALTER TABLE "public"."quote_attachments_default" OWNER TO "postgres";

ALTER TABLE "public"."quote_attachments" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."quote_attachments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."quote_status_history" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "quote_id" bigint NOT NULL,
    "operation" "text" NOT NULL,
    "previous_status_id" bigint,
    "new_status_id" bigint,
    "acted_by" bigint,
    "acted_at" timestamp with time zone NOT NULL,
    "inputs" "jsonb"
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."quote_status_history" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."quote_status_history_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "quote_id" bigint NOT NULL,
    "operation" "text" NOT NULL,
    "previous_status_id" bigint,
    "new_status_id" bigint,
    "acted_by" bigint,
    "acted_at" timestamp with time zone NOT NULL,
    "inputs" "jsonb"
);

ALTER TABLE "public"."quote_status_history_default" OWNER TO "postgres";

ALTER TABLE "public"."quote_status_history" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."quote_status_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."quote_versions" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "quote_id" bigint NOT NULL,
    "version_no" integer NOT NULL,
    "quoted_premium" numeric(18,2) NOT NULL,
    "terms_notes" "text",
    "revision_note" "text",
    "is_current" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."quote_versions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."quote_versions_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "quote_id" bigint NOT NULL,
    "version_no" integer NOT NULL,
    "quoted_premium" numeric(18,2) NOT NULL,
    "terms_notes" "text",
    "revision_note" "text",
    "is_current" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
);

ALTER TABLE "public"."quote_versions_default" OWNER TO "postgres";

ALTER TABLE "public"."quote_versions" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."quote_versions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."quotes" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "quote_ref" "text" NOT NULL,
    "status_id" bigint NOT NULL,
    "is_current" boolean DEFAULT false NOT NULL,
    "product_line_id" bigint NOT NULL,
    "cover_type_id" bigint NOT NULL,
    "prepared_date" "date" NOT NULL,
    "sent_date" "date",
    "valid_until" "date",
    "decision_date" timestamp with time zone,
    "bound_premium" numeric(18,2),
    "lost_reason_id" bigint,
    "competitor" "text",
    "competitor_premium" numeric(18,2),
    "loss_comments" "text",
    "withdrawal_note" "text",
    "notes" "text",
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."quotes" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."quotes_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "lead_id" bigint NOT NULL,
    "quote_ref" "text" NOT NULL,
    "status_id" bigint NOT NULL,
    "is_current" boolean DEFAULT false NOT NULL,
    "product_line_id" bigint NOT NULL,
    "cover_type_id" bigint NOT NULL,
    "prepared_date" "date" NOT NULL,
    "sent_date" "date",
    "valid_until" "date",
    "decision_date" timestamp with time zone,
    "bound_premium" numeric(18,2),
    "lost_reason_id" bigint,
    "competitor" "text",
    "competitor_premium" numeric(18,2),
    "loss_comments" "text",
    "withdrawal_note" "text",
    "notes" "text",
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
);

ALTER TABLE "public"."quotes_default" OWNER TO "postgres";

ALTER TABLE "public"."quotes" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."quotes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."reference_items" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "list_type" "text" NOT NULL,
    "name" "text" NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "is_broker_channel" boolean,
    "product_line_id" bigint,
    "reporting_category" "text",
    "canonical_key" "text",
    "is_terminal" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_reference_items_list_type" CHECK (("list_type" = ANY (ARRAY['request_channel'::"text", 'product_line'::"text", 'cover_type'::"text", 'party_segment'::"text", 'industry'::"text", 'region'::"text", 'party_type'::"text", 'lead_status'::"text", 'quote_status'::"text", 'lost_reason'::"text", 'broker_type'::"text"]))),
    CONSTRAINT "ck_reference_items_reporting_category" CHECK ((("reporting_category" IS NULL) OR ("reporting_category" = ANY (ARRAY['open'::"text", 'quoted'::"text", 'won'::"text", 'lost'::"text", 'expired'::"text", 'withdrawn'::"text"]))))
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."reference_items" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."reference_items_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "list_type" "text" NOT NULL,
    "name" "text" NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "is_broker_channel" boolean,
    "product_line_id" bigint,
    "reporting_category" "text",
    "canonical_key" "text",
    "is_terminal" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_reference_items_list_type" CHECK (("list_type" = ANY (ARRAY['request_channel'::"text", 'product_line'::"text", 'cover_type'::"text", 'party_segment'::"text", 'industry'::"text", 'region'::"text", 'party_type'::"text", 'lead_status'::"text", 'quote_status'::"text", 'lost_reason'::"text", 'broker_type'::"text"]))),
    CONSTRAINT "ck_reference_items_reporting_category" CHECK ((("reporting_category" IS NULL) OR ("reporting_category" = ANY (ARRAY['open'::"text", 'quoted'::"text", 'won'::"text", 'lost'::"text", 'expired'::"text", 'withdrawn'::"text"]))))
);

ALTER TABLE "public"."reference_items_default" OWNER TO "postgres";

ALTER TABLE "public"."reference_items" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."reference_items_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."reference_sequences" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "entity_type" "text" NOT NULL,
    "year" integer NOT NULL,
    "next_value" bigint DEFAULT 0 NOT NULL
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."reference_sequences" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."reference_sequences_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "entity_type" "text" NOT NULL,
    "year" integer NOT NULL,
    "next_value" bigint DEFAULT 0 NOT NULL
);

ALTER TABLE "public"."reference_sequences_default" OWNER TO "postgres";

ALTER TABLE "public"."reference_sequences" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."reference_sequences_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."role_permissions" (
    "id" bigint NOT NULL,
    "role_id" bigint NOT NULL,
    "permission_code" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
);

ALTER TABLE "public"."role_permissions" OWNER TO "postgres";

ALTER TABLE "public"."role_permissions" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."role_permissions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."roles" (
    "id" bigint NOT NULL,
    "tenant_id" bigint,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
);

ALTER TABLE "public"."roles" OWNER TO "postgres";

ALTER TABLE "public"."roles" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."tenant_settings" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "currency_code" "text" DEFAULT 'BWP'::"text" NOT NULL,
    "currency_symbol" "text" DEFAULT 'BWP'::"text" NOT NULL,
    "max_attachment_mb" integer DEFAULT 10 NOT NULL,
    "high_value_threshold" numeric(18,2),
    "quote_expiry_alert_days" integer DEFAULT 7 NOT NULL,
    "follow_up_overdue_grace_days" integer DEFAULT 0 NOT NULL,
    "aging_amber_days" integer DEFAULT 8 NOT NULL,
    "aging_red_days" integer DEFAULT 15 NOT NULL,
    "unassigned_lead_hours" integer DEFAULT 24 NOT NULL,
    "stalled_lead_days" integer DEFAULT 7 NOT NULL,
    "stalled_quote_days" integer DEFAULT 7 NOT NULL,
    "duplicate_check_days" integer DEFAULT 30 NOT NULL,
    "lead_ref_format" "text" DEFAULT 'L-{YYYY}-{SEQ:4}'::"text" NOT NULL,
    "quote_ref_format" "text" DEFAULT 'Q-{YYYY}-{SEQ:4}'::"text" NOT NULL,
    "lead_inactivity_expiry_days" integer DEFAULT 60 NOT NULL,
    "pricing_approval_target_days" integer DEFAULT 3 NOT NULL,
    "sla_assignment_days" integer DEFAULT 1 NOT NULL,
    "sla_underwriting_days" integer DEFAULT 3 NOT NULL,
    "sla_received_to_sent_days" integer DEFAULT 5 NOT NULL,
    "require_pricing_approval_for_high_value" boolean DEFAULT false NOT NULL,
    "manual_external_ref_enabled" boolean DEFAULT false NOT NULL,
    "expire_lead_when_last_quote_expires" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."tenant_settings" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."tenant_settings_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "currency_code" "text" DEFAULT 'BWP'::"text" NOT NULL,
    "currency_symbol" "text" DEFAULT 'BWP'::"text" NOT NULL,
    "max_attachment_mb" integer DEFAULT 10 NOT NULL,
    "high_value_threshold" numeric(18,2),
    "quote_expiry_alert_days" integer DEFAULT 7 NOT NULL,
    "follow_up_overdue_grace_days" integer DEFAULT 0 NOT NULL,
    "aging_amber_days" integer DEFAULT 8 NOT NULL,
    "aging_red_days" integer DEFAULT 15 NOT NULL,
    "unassigned_lead_hours" integer DEFAULT 24 NOT NULL,
    "stalled_lead_days" integer DEFAULT 7 NOT NULL,
    "stalled_quote_days" integer DEFAULT 7 NOT NULL,
    "duplicate_check_days" integer DEFAULT 30 NOT NULL,
    "lead_ref_format" "text" DEFAULT 'L-{YYYY}-{SEQ:4}'::"text" NOT NULL,
    "quote_ref_format" "text" DEFAULT 'Q-{YYYY}-{SEQ:4}'::"text" NOT NULL,
    "lead_inactivity_expiry_days" integer DEFAULT 60 NOT NULL,
    "pricing_approval_target_days" integer DEFAULT 3 NOT NULL,
    "sla_assignment_days" integer DEFAULT 1 NOT NULL,
    "sla_underwriting_days" integer DEFAULT 3 NOT NULL,
    "sla_received_to_sent_days" integer DEFAULT 5 NOT NULL,
    "require_pricing_approval_for_high_value" boolean DEFAULT false NOT NULL,
    "manual_external_ref_enabled" boolean DEFAULT false NOT NULL,
    "expire_lead_when_last_quote_expires" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
);

ALTER TABLE "public"."tenant_settings_default" OWNER TO "postgres";

ALTER TABLE "public"."tenant_settings" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."tenant_settings_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."tenants" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "contact_name" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "removed_at" timestamp with time zone,
    "removed_by" bigint,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint,
    CONSTRAINT "ck_tenants_status" CHECK (("status" = ANY (ARRAY['active'::"text", 'removed'::"text"])))
);

ALTER TABLE "public"."tenants" OWNER TO "postgres";

ALTER TABLE "public"."tenants" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."tenants_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."user_alert_views" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "last_opened_at" timestamp with time zone NOT NULL
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."user_alert_views" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."user_alert_views_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "last_opened_at" timestamp with time zone NOT NULL
);

ALTER TABLE "public"."user_alert_views_default" OWNER TO "postgres";

ALTER TABLE "public"."user_alert_views" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."user_alert_views_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."user_groups" (
    "id" bigint NOT NULL,
    "tenant_id" bigint,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
);

ALTER TABLE "public"."user_groups" OWNER TO "postgres";

ALTER TABLE "public"."user_groups" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."user_groups_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."user_permissions" (
    "id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "permission_code" "text" NOT NULL,
    "tenant_id" bigint,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
);

ALTER TABLE "public"."user_permissions" OWNER TO "postgres";

ALTER TABLE "public"."user_permissions" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."user_permissions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "role_id" bigint NOT NULL,
    "tenant_id" bigint,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
);

ALTER TABLE "public"."user_roles" OWNER TO "postgres";

ALTER TABLE "public"."user_roles" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."user_roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."user_tenants" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
)
PARTITION BY LIST ("tenant_id");

ALTER TABLE "public"."user_tenants" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."user_tenants_default" (
    "tenant_id" bigint NOT NULL,
    "id" bigint NOT NULL,
    "user_id" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint
);

ALTER TABLE "public"."user_tenants_default" OWNER TO "postgres";

ALTER TABLE "public"."user_tenants" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."user_tenants_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" bigint NOT NULL,
    "auth_user_id" "uuid" NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "email" "extensions"."citext" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_tenant_id" bigint,
    "theme_preference" "text",
    "created_at" timestamp with time zone NOT NULL,
    "created_by" bigint,
    "updated_at" timestamp with time zone NOT NULL,
    "updated_by" bigint
);

ALTER TABLE "public"."users" OWNER TO "postgres";

ALTER TABLE "public"."users" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."users_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY "public"."alerts" ATTACH PARTITION "public"."alerts_default" DEFAULT;

ALTER TABLE ONLY "public"."api_credentials" ATTACH PARTITION "public"."api_credentials_default" DEFAULT;

ALTER TABLE ONLY "public"."broker_contacts" ATTACH PARTITION "public"."broker_contacts_default" DEFAULT;

ALTER TABLE ONLY "public"."brokers" ATTACH PARTITION "public"."brokers_default" DEFAULT;

ALTER TABLE ONLY "public"."business_assignments" ATTACH PARTITION "public"."business_assignments_default" DEFAULT;

ALTER TABLE ONLY "public"."follow_ups" ATTACH PARTITION "public"."follow_ups_default" DEFAULT;

ALTER TABLE ONLY "public"."lead_assignments" ATTACH PARTITION "public"."lead_assignments_default" DEFAULT;

ALTER TABLE ONLY "public"."lead_notes" ATTACH PARTITION "public"."lead_notes_default" DEFAULT;

ALTER TABLE ONLY "public"."lead_status_history" ATTACH PARTITION "public"."lead_status_history_default" DEFAULT;

ALTER TABLE ONLY "public"."leads" ATTACH PARTITION "public"."leads_default" DEFAULT;

ALTER TABLE ONLY "public"."parties" ATTACH PARTITION "public"."parties_default" DEFAULT;

ALTER TABLE ONLY "public"."pricing_approvals" ATTACH PARTITION "public"."pricing_approvals_default" DEFAULT;

ALTER TABLE ONLY "public"."quote_assignments" ATTACH PARTITION "public"."quote_assignments_default" DEFAULT;

ALTER TABLE ONLY "public"."quote_attachments" ATTACH PARTITION "public"."quote_attachments_default" DEFAULT;

ALTER TABLE ONLY "public"."quote_status_history" ATTACH PARTITION "public"."quote_status_history_default" DEFAULT;

ALTER TABLE ONLY "public"."quote_versions" ATTACH PARTITION "public"."quote_versions_default" DEFAULT;

ALTER TABLE ONLY "public"."quotes" ATTACH PARTITION "public"."quotes_default" DEFAULT;

ALTER TABLE ONLY "public"."reference_items" ATTACH PARTITION "public"."reference_items_default" DEFAULT;

ALTER TABLE ONLY "public"."reference_sequences" ATTACH PARTITION "public"."reference_sequences_default" DEFAULT;

ALTER TABLE ONLY "public"."tenant_settings" ATTACH PARTITION "public"."tenant_settings_default" DEFAULT;

ALTER TABLE ONLY "public"."user_alert_views" ATTACH PARTITION "public"."user_alert_views_default" DEFAULT;

ALTER TABLE ONLY "public"."user_tenants" ATTACH PARTITION "public"."user_tenants_default" DEFAULT;

ALTER TABLE ONLY "public"."alerts"
    ADD CONSTRAINT "alerts_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."alerts_default"
    ADD CONSTRAINT "alerts_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."api_credentials"
    ADD CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."api_credentials_default"
    ADD CONSTRAINT "api_credentials_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."api_credentials"
    ADD CONSTRAINT "uq_api_credentials_key_id" UNIQUE ("tenant_id", "key_id");

ALTER TABLE ONLY "public"."api_credentials_default"
    ADD CONSTRAINT "api_credentials_default_tenant_id_key_id_key" UNIQUE ("tenant_id", "key_id");

ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."broker_contacts"
    ADD CONSTRAINT "broker_contacts_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."broker_contacts_default"
    ADD CONSTRAINT "broker_contacts_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."brokers"
    ADD CONSTRAINT "brokers_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."brokers_default"
    ADD CONSTRAINT "brokers_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."brokers"
    ADD CONSTRAINT "uq_brokers_tenant_name" UNIQUE ("tenant_id", "name");

ALTER TABLE ONLY "public"."brokers_default"
    ADD CONSTRAINT "brokers_default_tenant_id_name_key" UNIQUE ("tenant_id", "name");

ALTER TABLE ONLY "public"."business_assignments"
    ADD CONSTRAINT "business_assignments_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."business_assignments_default"
    ADD CONSTRAINT "business_assignments_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."business_assignments"
    ADD CONSTRAINT "uq_business_assignments_tenant_slot" UNIQUE ("tenant_id", "slot");

ALTER TABLE ONLY "public"."business_assignments_default"
    ADD CONSTRAINT "business_assignments_default_tenant_id_slot_key" UNIQUE ("tenant_id", "slot");

ALTER TABLE ONLY "public"."default_reference_items"
    ADD CONSTRAINT "default_reference_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."follow_ups"
    ADD CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."follow_ups_default"
    ADD CONSTRAINT "follow_ups_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."group_permissions"
    ADD CONSTRAINT "group_permissions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."group_roles"
    ADD CONSTRAINT "group_roles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."job_cron_config"
    ADD CONSTRAINT "job_cron_config_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."job_idempotency_key"
    ADD CONSTRAINT "job_idempotency_key_pkey" PRIMARY KEY ("key");

ALTER TABLE ONLY "public"."job_run"
    ADD CONSTRAINT "job_run_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."lead_assignments"
    ADD CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."lead_assignments_default"
    ADD CONSTRAINT "lead_assignments_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."lead_assignments"
    ADD CONSTRAINT "uq_lead_assignments_tenant_lead_role" UNIQUE ("tenant_id", "lead_id", "business_assignment_id");

ALTER TABLE ONLY "public"."lead_assignments_default"
    ADD CONSTRAINT "lead_assignments_default_tenant_id_lead_id_business_assignm_key" UNIQUE ("tenant_id", "lead_id", "business_assignment_id");

ALTER TABLE ONLY "public"."lead_notes"
    ADD CONSTRAINT "lead_notes_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."lead_notes_default"
    ADD CONSTRAINT "lead_notes_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."lead_status_history"
    ADD CONSTRAINT "lead_status_history_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."lead_status_history_default"
    ADD CONSTRAINT "lead_status_history_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."leads_default"
    ADD CONSTRAINT "leads_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "uq_leads_tenant_lead_ref" UNIQUE ("tenant_id", "lead_ref");

ALTER TABLE ONLY "public"."leads_default"
    ADD CONSTRAINT "leads_default_tenant_id_lead_ref_key" UNIQUE ("tenant_id", "lead_ref");

ALTER TABLE ONLY "public"."parties"
    ADD CONSTRAINT "parties_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."parties_default"
    ADD CONSTRAINT "parties_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("code");

ALTER TABLE ONLY "public"."pricing_approvals"
    ADD CONSTRAINT "pricing_approvals_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."pricing_approvals_default"
    ADD CONSTRAINT "pricing_approvals_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quote_assignments"
    ADD CONSTRAINT "quote_assignments_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quote_assignments_default"
    ADD CONSTRAINT "quote_assignments_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quote_assignments"
    ADD CONSTRAINT "uq_quote_assignments_tenant_quote_role" UNIQUE ("tenant_id", "quote_id", "business_assignment_id");

ALTER TABLE ONLY "public"."quote_assignments_default"
    ADD CONSTRAINT "quote_assignments_default_tenant_id_quote_id_business_assig_key" UNIQUE ("tenant_id", "quote_id", "business_assignment_id");

ALTER TABLE ONLY "public"."quote_attachments"
    ADD CONSTRAINT "quote_attachments_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quote_attachments_default"
    ADD CONSTRAINT "quote_attachments_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quote_status_history"
    ADD CONSTRAINT "quote_status_history_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quote_status_history_default"
    ADD CONSTRAINT "quote_status_history_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quote_versions"
    ADD CONSTRAINT "quote_versions_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quote_versions_default"
    ADD CONSTRAINT "quote_versions_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quote_versions"
    ADD CONSTRAINT "uq_quote_versions_tenant_quote_version" UNIQUE ("tenant_id", "quote_id", "version_no");

ALTER TABLE ONLY "public"."quote_versions_default"
    ADD CONSTRAINT "quote_versions_default_tenant_id_quote_id_version_no_key" UNIQUE ("tenant_id", "quote_id", "version_no");

ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quotes_default"
    ADD CONSTRAINT "quotes_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "uq_quotes_tenant_quote_ref" UNIQUE ("tenant_id", "quote_ref");

ALTER TABLE ONLY "public"."quotes_default"
    ADD CONSTRAINT "quotes_default_tenant_id_quote_ref_key" UNIQUE ("tenant_id", "quote_ref");

ALTER TABLE ONLY "public"."reference_items"
    ADD CONSTRAINT "reference_items_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."reference_items_default"
    ADD CONSTRAINT "reference_items_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."reference_items"
    ADD CONSTRAINT "uq_reference_items_tenant_list_canonical_key" UNIQUE ("tenant_id", "list_type", "canonical_key");

ALTER TABLE ONLY "public"."reference_items_default"
    ADD CONSTRAINT "reference_items_default_tenant_id_list_type_canonical_key_key" UNIQUE ("tenant_id", "list_type", "canonical_key");

ALTER TABLE ONLY "public"."reference_items"
    ADD CONSTRAINT "uq_reference_items_tenant_list_name" UNIQUE ("tenant_id", "list_type", "name");

ALTER TABLE ONLY "public"."reference_items_default"
    ADD CONSTRAINT "reference_items_default_tenant_id_list_type_name_key" UNIQUE ("tenant_id", "list_type", "name");

ALTER TABLE ONLY "public"."reference_sequences"
    ADD CONSTRAINT "reference_sequences_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."reference_sequences_default"
    ADD CONSTRAINT "reference_sequences_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."reference_sequences"
    ADD CONSTRAINT "uq_reference_sequences_tenant_entity_year" UNIQUE ("tenant_id", "entity_type", "year");

ALTER TABLE ONLY "public"."reference_sequences_default"
    ADD CONSTRAINT "reference_sequences_default_tenant_id_entity_type_year_key" UNIQUE ("tenant_id", "entity_type", "year");

ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."tenant_settings"
    ADD CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."tenant_settings_default"
    ADD CONSTRAINT "tenant_settings_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."tenant_settings"
    ADD CONSTRAINT "uq_tenant_settings_tenant_id" UNIQUE ("tenant_id");

ALTER TABLE ONLY "public"."tenant_settings_default"
    ADD CONSTRAINT "tenant_settings_default_tenant_id_key" UNIQUE ("tenant_id");

ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."default_reference_items"
    ADD CONSTRAINT "uq_default_reference_items_list_name" UNIQUE ("list_type", "name");

ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "uq_group_members_group_user" UNIQUE ("group_id", "user_id");

ALTER TABLE ONLY "public"."group_permissions"
    ADD CONSTRAINT "uq_group_permissions_group_permission" UNIQUE ("group_id", "permission_code");

ALTER TABLE ONLY "public"."group_roles"
    ADD CONSTRAINT "uq_group_roles_group_role" UNIQUE ("group_id", "role_id");

ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "uq_role_permissions_role_permission" UNIQUE ("role_id", "permission_code");

ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "uq_roles_tenant_name" UNIQUE ("tenant_id", "name");

ALTER TABLE ONLY "public"."user_alert_views"
    ADD CONSTRAINT "uq_user_alert_views_tenant_user" UNIQUE ("tenant_id", "user_id");

ALTER TABLE ONLY "public"."user_groups"
    ADD CONSTRAINT "uq_user_groups_tenant_name" UNIQUE ("tenant_id", "name");

ALTER TABLE ONLY "public"."user_permissions"
    ADD CONSTRAINT "uq_user_permissions_user_permission_tenant" UNIQUE ("user_id", "permission_code", "tenant_id");

ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "uq_user_roles_user_role_tenant" UNIQUE ("user_id", "role_id", "tenant_id");

ALTER TABLE ONLY "public"."user_tenants"
    ADD CONSTRAINT "uq_user_tenants_user_tenant" UNIQUE ("user_id", "tenant_id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "uq_users_auth_user_id" UNIQUE ("auth_user_id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "uq_users_email" UNIQUE ("email");

ALTER TABLE ONLY "public"."user_alert_views"
    ADD CONSTRAINT "user_alert_views_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."user_alert_views_default"
    ADD CONSTRAINT "user_alert_views_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."user_alert_views_default"
    ADD CONSTRAINT "user_alert_views_default_tenant_id_user_id_key" UNIQUE ("tenant_id", "user_id");

ALTER TABLE ONLY "public"."user_groups"
    ADD CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."user_permissions"
    ADD CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."user_tenants"
    ADD CONSTRAINT "user_tenants_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."user_tenants_default"
    ADD CONSTRAINT "user_tenants_default_pkey" PRIMARY KEY ("tenant_id", "id");

ALTER TABLE ONLY "public"."user_tenants_default"
    ADD CONSTRAINT "user_tenants_default_user_id_tenant_id_key" UNIQUE ("user_id", "tenant_id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");

CREATE INDEX "ix_alerts_tenant_open_created" ON ONLY "public"."alerts" USING "btree" ("tenant_id", "created_at") WHERE ("resolved_at" IS NULL);

CREATE INDEX "alerts_default_tenant_id_created_at_idx" ON "public"."alerts_default" USING "btree" ("tenant_id", "created_at") WHERE ("resolved_at" IS NULL);

CREATE INDEX "ix_alerts_tenant_lead" ON ONLY "public"."alerts" USING "btree" ("tenant_id", "lead_id");

CREATE INDEX "alerts_default_tenant_id_lead_id_idx" ON "public"."alerts_default" USING "btree" ("tenant_id", "lead_id");

CREATE UNIQUE INDEX "uq_alerts_open_per_type_lead_quote" ON ONLY "public"."alerts" USING "btree" ("tenant_id", "type", "lead_id", COALESCE("quote_id", (0)::bigint)) WHERE ("resolved_at" IS NULL);

COMMENT ON INDEX "public"."uq_alerts_open_per_type_lead_quote" IS 'Enforces at most one OPEN alert per (tenant, type, lead, quote) — the DB uniqueness spec §9.5 names as the basis for Job 3 reconciliation idempotency under at-least-once cron delivery. Partial on resolved_at IS NULL so a resolved alert never blocks a recurrence; COALESCE(quote_id, 0) so lead-level alerts (quote_id IS NULL) collide instead of being all-distinct under NULL semantics.';

CREATE UNIQUE INDEX "alerts_default_tenant_id_type_lead_id_coalesce_idx" ON "public"."alerts_default" USING "btree" ("tenant_id", "type", "lead_id", COALESCE("quote_id", (0)::bigint)) WHERE ("resolved_at" IS NULL);

CREATE INDEX "ix_api_credentials_key_id" ON ONLY "public"."api_credentials" USING "btree" ("key_id");

CREATE INDEX "api_credentials_default_key_id_idx" ON "public"."api_credentials_default" USING "btree" ("key_id");

CREATE INDEX "ix_broker_contacts_tenant_broker" ON ONLY "public"."broker_contacts" USING "btree" ("tenant_id", "broker_id");

CREATE INDEX "broker_contacts_default_tenant_id_broker_id_idx" ON "public"."broker_contacts_default" USING "btree" ("tenant_id", "broker_id");

CREATE UNIQUE INDEX "uq_broker_contacts_primary" ON ONLY "public"."broker_contacts" USING "btree" ("tenant_id", "broker_id") WHERE ("is_primary" = true);

COMMENT ON INDEX "public"."uq_broker_contacts_primary" IS 'Enforces at most one primary contact per broker per tenant (FR-24, AC-023). Partial on is_primary = true so any number of non-primary contacts remain allowed. Replaces a handler-only invariant that two concurrent SetPrimary calls could violate.';

CREATE UNIQUE INDEX "broker_contacts_default_tenant_id_broker_id_idx1" ON "public"."broker_contacts_default" USING "btree" ("tenant_id", "broker_id") WHERE ("is_primary" = true);

CREATE INDEX "ix_brokers_name_trgm" ON ONLY "public"."brokers" USING "gin" ("name" "extensions"."gin_trgm_ops");

CREATE INDEX "brokers_default_name_idx" ON "public"."brokers_default" USING "gin" ("name" "extensions"."gin_trgm_ops");

CREATE INDEX "ix_follow_ups_tenant_lead" ON ONLY "public"."follow_ups" USING "btree" ("tenant_id", "lead_id", "logged_at");

CREATE INDEX "follow_ups_default_tenant_id_lead_id_logged_at_idx" ON "public"."follow_ups_default" USING "btree" ("tenant_id", "lead_id", "logged_at");

CREATE INDEX "ix_audit_log_acted_at" ON "public"."audit_log" USING "btree" ("acted_at");

CREATE INDEX "ix_audit_log_entity" ON "public"."audit_log" USING "btree" ("entity_type", "entity_id");

CREATE INDEX "ix_audit_log_tenant_id" ON "public"."audit_log" USING "btree" ("tenant_id");

CREATE INDEX "ix_group_members_user_id" ON "public"."group_members" USING "btree" ("user_id");

CREATE INDEX "ix_job_idempotency_key_claimed_at" ON "public"."job_idempotency_key" USING "btree" ("claimed_at");

CREATE INDEX "ix_job_run_correlation_id" ON "public"."job_run" USING "btree" ("correlation_id");

CREATE INDEX "ix_job_run_job_name_started_at" ON "public"."job_run" USING "btree" ("job_name", "started_at" DESC);

CREATE INDEX "ix_job_run_unhealthy" ON "public"."job_run" USING "btree" ("started_at" DESC) WHERE ("status" = ANY (ARRAY['running'::"text", 'failed'::"text"]));

CREATE INDEX "ix_lead_status_history_tenant_lead" ON ONLY "public"."lead_status_history" USING "btree" ("tenant_id", "lead_id", "acted_at");

CREATE INDEX "ix_leads_external_ref_trgm" ON ONLY "public"."leads" USING "gin" ("external_ref" "extensions"."gin_trgm_ops");

CREATE INDEX "ix_leads_lead_ref_trgm" ON ONLY "public"."leads" USING "gin" ("lead_ref" "extensions"."gin_trgm_ops");

CREATE INDEX "ix_parties_name_trgm" ON ONLY "public"."parties" USING "gin" ("name" "extensions"."gin_trgm_ops");

CREATE INDEX "ix_pricing_approvals_tenant_lead" ON ONLY "public"."pricing_approvals" USING "btree" ("tenant_id", "lead_id", "requested_at");

CREATE INDEX "ix_quote_attachments_tenant_quote" ON ONLY "public"."quote_attachments" USING "btree" ("tenant_id", "quote_id");

CREATE INDEX "ix_quote_attachments_tenant_quote_live" ON ONLY "public"."quote_attachments" USING "btree" ("tenant_id", "quote_id") WHERE (("confirmed_at" IS NOT NULL) AND ("removed_at" IS NULL));

CREATE INDEX "ix_quote_status_history_tenant_quote" ON ONLY "public"."quote_status_history" USING "btree" ("tenant_id", "quote_id", "acted_at");

CREATE INDEX "ix_quote_versions_tenant_quote" ON ONLY "public"."quote_versions" USING "btree" ("tenant_id", "quote_id");

CREATE INDEX "ix_quotes_quote_ref_trgm" ON ONLY "public"."quotes" USING "gin" ("quote_ref" "extensions"."gin_trgm_ops");

CREATE INDEX "ix_quotes_tenant_lead" ON ONLY "public"."quotes" USING "btree" ("tenant_id", "lead_id");

CREATE INDEX "ix_user_roles_role_id" ON "public"."user_roles" USING "btree" ("role_id");

CREATE INDEX "lead_status_history_default_tenant_id_lead_id_acted_at_idx" ON "public"."lead_status_history_default" USING "btree" ("tenant_id", "lead_id", "acted_at");

CREATE INDEX "leads_default_external_ref_idx" ON "public"."leads_default" USING "gin" ("external_ref" "extensions"."gin_trgm_ops");

CREATE INDEX "leads_default_lead_ref_idx" ON "public"."leads_default" USING "gin" ("lead_ref" "extensions"."gin_trgm_ops");

CREATE INDEX "parties_default_name_idx" ON "public"."parties_default" USING "gin" ("name" "extensions"."gin_trgm_ops");

CREATE INDEX "pricing_approvals_default_tenant_id_lead_id_requested_at_idx" ON "public"."pricing_approvals_default" USING "btree" ("tenant_id", "lead_id", "requested_at");

CREATE INDEX "quote_attachments_default_tenant_id_quote_id_idx" ON "public"."quote_attachments_default" USING "btree" ("tenant_id", "quote_id");

CREATE INDEX "quote_attachments_default_tenant_id_quote_id_idx1" ON "public"."quote_attachments_default" USING "btree" ("tenant_id", "quote_id") WHERE (("confirmed_at" IS NOT NULL) AND ("removed_at" IS NULL));

CREATE INDEX "quote_status_history_default_tenant_id_quote_id_acted_at_idx" ON "public"."quote_status_history_default" USING "btree" ("tenant_id", "quote_id", "acted_at");

CREATE INDEX "quote_versions_default_tenant_id_quote_id_idx" ON "public"."quote_versions_default" USING "btree" ("tenant_id", "quote_id");

CREATE UNIQUE INDEX "uq_quote_versions_current" ON ONLY "public"."quote_versions" USING "btree" ("tenant_id", "quote_id") WHERE ("is_current" = true);

COMMENT ON INDEX "public"."uq_quote_versions_current" IS 'Enforces at most one current version per quote per tenant. Absent from the .NET reference, where the invariant lived only in ReviseQuoteCommandHandler and two concurrent revisions could commit two current rows — double-counting quoted premium in every dashboard that joins quote.is_current AND version.is_current. Documented target-only deviation (T-005).';

CREATE UNIQUE INDEX "quote_versions_default_tenant_id_quote_id_idx1" ON "public"."quote_versions_default" USING "btree" ("tenant_id", "quote_id") WHERE ("is_current" = true);

CREATE INDEX "quotes_default_quote_ref_idx" ON "public"."quotes_default" USING "gin" ("quote_ref" "extensions"."gin_trgm_ops");

CREATE INDEX "quotes_default_tenant_id_lead_id_idx" ON "public"."quotes_default" USING "btree" ("tenant_id", "lead_id");

CREATE UNIQUE INDEX "uq_quotes_current" ON ONLY "public"."quotes" USING "btree" ("tenant_id", "lead_id") WHERE ("is_current" = true);

COMMENT ON INDEX "public"."uq_quotes_current" IS 'Enforces at most one current quote per lead per tenant (FR-50, PRD 7.3). Absent from the .NET reference, where the invariant lived only in SetCurrentQuoteCommandHandler/CreateQuoteCommandHandler and two concurrent promotions could commit two current rows — double-counting quoted premium in every dashboard that joins quote.is_current AND version.is_current. Documented target-only deviation (T-026, per the T-005 evaluator ruling).';

CREATE UNIQUE INDEX "quotes_default_tenant_id_lead_id_idx1" ON "public"."quotes_default" USING "btree" ("tenant_id", "lead_id") WHERE ("is_current" = true);

CREATE UNIQUE INDEX "uq_tenants_active_name" ON "public"."tenants" USING "btree" ("lower"("name")) WHERE ("status" = 'active'::"text");

ALTER INDEX "public"."alerts_pkey" ATTACH PARTITION "public"."alerts_default_pkey";

ALTER INDEX "public"."ix_alerts_tenant_open_created" ATTACH PARTITION "public"."alerts_default_tenant_id_created_at_idx";

ALTER INDEX "public"."ix_alerts_tenant_lead" ATTACH PARTITION "public"."alerts_default_tenant_id_lead_id_idx";

ALTER INDEX "public"."uq_alerts_open_per_type_lead_quote" ATTACH PARTITION "public"."alerts_default_tenant_id_type_lead_id_coalesce_idx";

ALTER INDEX "public"."ix_api_credentials_key_id" ATTACH PARTITION "public"."api_credentials_default_key_id_idx";

ALTER INDEX "public"."api_credentials_pkey" ATTACH PARTITION "public"."api_credentials_default_pkey";

ALTER INDEX "public"."uq_api_credentials_key_id" ATTACH PARTITION "public"."api_credentials_default_tenant_id_key_id_key";

ALTER INDEX "public"."broker_contacts_pkey" ATTACH PARTITION "public"."broker_contacts_default_pkey";

ALTER INDEX "public"."ix_broker_contacts_tenant_broker" ATTACH PARTITION "public"."broker_contacts_default_tenant_id_broker_id_idx";

ALTER INDEX "public"."uq_broker_contacts_primary" ATTACH PARTITION "public"."broker_contacts_default_tenant_id_broker_id_idx1";

ALTER INDEX "public"."ix_brokers_name_trgm" ATTACH PARTITION "public"."brokers_default_name_idx";

ALTER INDEX "public"."brokers_pkey" ATTACH PARTITION "public"."brokers_default_pkey";

ALTER INDEX "public"."uq_brokers_tenant_name" ATTACH PARTITION "public"."brokers_default_tenant_id_name_key";

ALTER INDEX "public"."business_assignments_pkey" ATTACH PARTITION "public"."business_assignments_default_pkey";

ALTER INDEX "public"."uq_business_assignments_tenant_slot" ATTACH PARTITION "public"."business_assignments_default_tenant_id_slot_key";

ALTER INDEX "public"."follow_ups_pkey" ATTACH PARTITION "public"."follow_ups_default_pkey";

ALTER INDEX "public"."ix_follow_ups_tenant_lead" ATTACH PARTITION "public"."follow_ups_default_tenant_id_lead_id_logged_at_idx";

ALTER INDEX "public"."lead_assignments_pkey" ATTACH PARTITION "public"."lead_assignments_default_pkey";

ALTER INDEX "public"."uq_lead_assignments_tenant_lead_role" ATTACH PARTITION "public"."lead_assignments_default_tenant_id_lead_id_business_assignm_key";

ALTER INDEX "public"."lead_notes_pkey" ATTACH PARTITION "public"."lead_notes_default_pkey";

ALTER INDEX "public"."lead_status_history_pkey" ATTACH PARTITION "public"."lead_status_history_default_pkey";

ALTER INDEX "public"."ix_lead_status_history_tenant_lead" ATTACH PARTITION "public"."lead_status_history_default_tenant_id_lead_id_acted_at_idx";

ALTER INDEX "public"."ix_leads_external_ref_trgm" ATTACH PARTITION "public"."leads_default_external_ref_idx";

ALTER INDEX "public"."ix_leads_lead_ref_trgm" ATTACH PARTITION "public"."leads_default_lead_ref_idx";

ALTER INDEX "public"."leads_pkey" ATTACH PARTITION "public"."leads_default_pkey";

ALTER INDEX "public"."uq_leads_tenant_lead_ref" ATTACH PARTITION "public"."leads_default_tenant_id_lead_ref_key";

ALTER INDEX "public"."ix_parties_name_trgm" ATTACH PARTITION "public"."parties_default_name_idx";

ALTER INDEX "public"."parties_pkey" ATTACH PARTITION "public"."parties_default_pkey";

ALTER INDEX "public"."pricing_approvals_pkey" ATTACH PARTITION "public"."pricing_approvals_default_pkey";

ALTER INDEX "public"."ix_pricing_approvals_tenant_lead" ATTACH PARTITION "public"."pricing_approvals_default_tenant_id_lead_id_requested_at_idx";

ALTER INDEX "public"."quote_assignments_pkey" ATTACH PARTITION "public"."quote_assignments_default_pkey";

ALTER INDEX "public"."uq_quote_assignments_tenant_quote_role" ATTACH PARTITION "public"."quote_assignments_default_tenant_id_quote_id_business_assig_key";

ALTER INDEX "public"."quote_attachments_pkey" ATTACH PARTITION "public"."quote_attachments_default_pkey";

ALTER INDEX "public"."ix_quote_attachments_tenant_quote" ATTACH PARTITION "public"."quote_attachments_default_tenant_id_quote_id_idx";

ALTER INDEX "public"."ix_quote_attachments_tenant_quote_live" ATTACH PARTITION "public"."quote_attachments_default_tenant_id_quote_id_idx1";

ALTER INDEX "public"."quote_status_history_pkey" ATTACH PARTITION "public"."quote_status_history_default_pkey";

ALTER INDEX "public"."ix_quote_status_history_tenant_quote" ATTACH PARTITION "public"."quote_status_history_default_tenant_id_quote_id_acted_at_idx";

ALTER INDEX "public"."quote_versions_pkey" ATTACH PARTITION "public"."quote_versions_default_pkey";

ALTER INDEX "public"."ix_quote_versions_tenant_quote" ATTACH PARTITION "public"."quote_versions_default_tenant_id_quote_id_idx";

ALTER INDEX "public"."uq_quote_versions_current" ATTACH PARTITION "public"."quote_versions_default_tenant_id_quote_id_idx1";

ALTER INDEX "public"."uq_quote_versions_tenant_quote_version" ATTACH PARTITION "public"."quote_versions_default_tenant_id_quote_id_version_no_key";

ALTER INDEX "public"."quotes_pkey" ATTACH PARTITION "public"."quotes_default_pkey";

ALTER INDEX "public"."ix_quotes_quote_ref_trgm" ATTACH PARTITION "public"."quotes_default_quote_ref_idx";

ALTER INDEX "public"."ix_quotes_tenant_lead" ATTACH PARTITION "public"."quotes_default_tenant_id_lead_id_idx";

ALTER INDEX "public"."uq_quotes_current" ATTACH PARTITION "public"."quotes_default_tenant_id_lead_id_idx1";

ALTER INDEX "public"."uq_quotes_tenant_quote_ref" ATTACH PARTITION "public"."quotes_default_tenant_id_quote_ref_key";

ALTER INDEX "public"."reference_items_pkey" ATTACH PARTITION "public"."reference_items_default_pkey";

ALTER INDEX "public"."uq_reference_items_tenant_list_canonical_key" ATTACH PARTITION "public"."reference_items_default_tenant_id_list_type_canonical_key_key";

ALTER INDEX "public"."uq_reference_items_tenant_list_name" ATTACH PARTITION "public"."reference_items_default_tenant_id_list_type_name_key";

ALTER INDEX "public"."reference_sequences_pkey" ATTACH PARTITION "public"."reference_sequences_default_pkey";

ALTER INDEX "public"."uq_reference_sequences_tenant_entity_year" ATTACH PARTITION "public"."reference_sequences_default_tenant_id_entity_type_year_key";

ALTER INDEX "public"."tenant_settings_pkey" ATTACH PARTITION "public"."tenant_settings_default_pkey";

ALTER INDEX "public"."uq_tenant_settings_tenant_id" ATTACH PARTITION "public"."tenant_settings_default_tenant_id_key";

ALTER INDEX "public"."user_alert_views_pkey" ATTACH PARTITION "public"."user_alert_views_default_pkey";

ALTER INDEX "public"."uq_user_alert_views_tenant_user" ATTACH PARTITION "public"."user_alert_views_default_tenant_id_user_id_key";

ALTER INDEX "public"."user_tenants_pkey" ATTACH PARTITION "public"."user_tenants_default_pkey";

ALTER INDEX "public"."uq_user_tenants_user_tenant" ATTACH PARTITION "public"."user_tenants_default_user_id_tenant_id_key";

ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "fk_group_members_group" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id");

ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "fk_group_members_user" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."group_permissions"
    ADD CONSTRAINT "fk_group_permissions_group" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id");

ALTER TABLE ONLY "public"."group_permissions"
    ADD CONSTRAINT "fk_group_permissions_permission" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code");

ALTER TABLE ONLY "public"."group_roles"
    ADD CONSTRAINT "fk_group_roles_group" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id");

ALTER TABLE ONLY "public"."group_roles"
    ADD CONSTRAINT "fk_group_roles_role" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id");

ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "fk_role_permissions_permission" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code");

ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "fk_role_permissions_role" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id");

ALTER TABLE ONLY "public"."user_permissions"
    ADD CONSTRAINT "fk_user_permissions_permission" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code");

ALTER TABLE ONLY "public"."user_permissions"
    ADD CONSTRAINT "fk_user_permissions_user" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "fk_user_roles_role" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id");

ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "fk_user_roles_user" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."job_idempotency_key"
    ADD CONSTRAINT "job_idempotency_key_job_run_id_fkey" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_run"("id") ON DELETE SET NULL;

ALTER TABLE "public"."user_tenants"
    ADD CONSTRAINT "user_tenants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

REVOKE ALL ON FUNCTION "public"."invoke_cron_endpoint"("job_name" "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."invoke_queue_drain"() FROM PUBLIC;

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."alerts" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."alerts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."alerts" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."alerts_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."alerts_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."alerts_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."alerts_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."alerts_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."alerts_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."api_credentials" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."api_credentials" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."api_credentials" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."api_credentials_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."api_credentials_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."api_credentials_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."api_credentials_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."api_credentials_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."api_credentials_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."audit_log" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."audit_log" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."audit_log" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."audit_log_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."audit_log_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."audit_log_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."broker_contacts" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."broker_contacts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."broker_contacts" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."broker_contacts_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."broker_contacts_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."broker_contacts_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."broker_contacts_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."broker_contacts_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."broker_contacts_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."brokers" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."brokers" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."brokers" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."brokers_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."brokers_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."brokers_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."brokers_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."brokers_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."brokers_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."business_assignments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."business_assignments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."business_assignments" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."business_assignments_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."business_assignments_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."business_assignments_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."business_assignments_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."business_assignments_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."business_assignments_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."default_reference_items" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."default_reference_items" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."default_reference_items" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."default_reference_items_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."default_reference_items_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."default_reference_items_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."follow_ups" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."follow_ups" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."follow_ups" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."follow_ups_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."follow_ups_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."follow_ups_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."follow_ups_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."follow_ups_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."follow_ups_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."group_members" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."group_members" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."group_members" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."group_members_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."group_members_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."group_members_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."group_permissions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."group_permissions" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."group_permissions" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."group_permissions_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."group_permissions_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."group_permissions_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."group_roles" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."group_roles" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."group_roles" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."group_roles_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."group_roles_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."group_roles_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."job_cron_config" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."job_idempotency_key" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."job_idempotency_key" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."job_idempotency_key" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."job_run" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."job_run" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."job_run" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."job_run_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."job_run_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."job_run_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_assignments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_assignments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_assignments" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_assignments_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_assignments_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_assignments_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."lead_assignments_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."lead_assignments_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."lead_assignments_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_notes" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_notes" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_notes" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_notes_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_notes_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_notes_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."lead_notes_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."lead_notes_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."lead_notes_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_status_history" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_status_history" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_status_history" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_status_history_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_status_history_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lead_status_history_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."lead_status_history_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."lead_status_history_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."lead_status_history_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."leads" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."leads" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."leads" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."leads_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."leads_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."leads_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."leads_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."leads_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."leads_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."parties" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."parties" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."parties" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."parties_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."parties_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."parties_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."parties_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."parties_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."parties_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."permissions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."permissions" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."permissions" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pricing_approvals" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pricing_approvals" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pricing_approvals" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pricing_approvals_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pricing_approvals_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pricing_approvals_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."pricing_approvals_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."pricing_approvals_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."pricing_approvals_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_assignments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_assignments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_assignments" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_assignments_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_assignments_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_assignments_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."quote_assignments_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."quote_assignments_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."quote_assignments_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_attachments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_attachments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_attachments" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_attachments_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_attachments_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_attachments_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."quote_attachments_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."quote_attachments_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."quote_attachments_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_status_history" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_status_history" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_status_history" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_status_history_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_status_history_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_status_history_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."quote_status_history_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."quote_status_history_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."quote_status_history_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_versions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_versions" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_versions" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_versions_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_versions_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quote_versions_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."quote_versions_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."quote_versions_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."quote_versions_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quotes" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quotes" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quotes" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quotes_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quotes_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."quotes_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."quotes_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."quotes_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."quotes_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_items" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_items" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_items" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_items_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_items_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_items_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."reference_items_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."reference_items_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."reference_items_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_sequences" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_sequences" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_sequences" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_sequences_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_sequences_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reference_sequences_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."reference_sequences_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."reference_sequences_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."reference_sequences_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."role_permissions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."role_permissions" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."role_permissions" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."role_permissions_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."role_permissions_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."role_permissions_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."roles" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."roles" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."roles" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."roles_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."roles_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."roles_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tenant_settings" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tenant_settings" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tenant_settings" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tenant_settings_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tenant_settings_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tenant_settings_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."tenant_settings_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."tenant_settings_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."tenant_settings_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tenants" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tenants" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tenants" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."tenants_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."tenants_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."tenants_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_alert_views" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_alert_views" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_alert_views" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_alert_views_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_alert_views_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_alert_views_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."user_alert_views_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."user_alert_views_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."user_alert_views_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_groups" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_groups" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_groups" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."user_groups_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."user_groups_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."user_groups_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_permissions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_permissions" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_permissions" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."user_permissions_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."user_permissions_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."user_permissions_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_roles" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_roles" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_roles" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."user_roles_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."user_roles_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."user_roles_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_tenants" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_tenants" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_tenants" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_tenants_default" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_tenants_default" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_tenants_default" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."user_tenants_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."user_tenants_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."user_tenants_id_seq" TO "service_role";

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."users" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."users" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."users" TO "service_role";

GRANT UPDATE ON SEQUENCE "public"."users_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."users_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."users_id_seq" TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";
