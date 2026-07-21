// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with `npm run db:types` (scripts/db/generate-types.ts).
// CI runs `npm run db:types -- --check`, which fails if this file is stale (AC-013).
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      alerts: {
        Row: {
          created_at: string
          id: number
          lead_id: number
          premium_at_risk: number | null
          quote_id: number | null
          resolved_at: string | null
          resolved_reason: string | null
          severity: string
          tenant_id: number
          type: string
        }
        Insert: {
          created_at: string
          id?: never
          lead_id: number
          premium_at_risk?: number | null
          quote_id?: number | null
          resolved_at?: string | null
          resolved_reason?: string | null
          severity: string
          tenant_id: number
          type: string
        }
        Update: {
          created_at?: string
          id?: never
          lead_id?: number
          premium_at_risk?: number | null
          quote_id?: number | null
          resolved_at?: string | null
          resolved_reason?: string | null
          severity?: string
          tenant_id?: number
          type?: string
        }
        Relationships: []
      }
      api_credentials: {
        Row: {
          broker_id: number | null
          created_at: string
          created_by: number | null
          disabled_at: string | null
          id: number
          key_hash: string
          key_id: string
          key_salt: string
          last_rotated_at: string | null
          last_used_at: string | null
          name: string
          status: string
          tenant_id: number
        }
        Insert: {
          broker_id?: number | null
          created_at: string
          created_by?: number | null
          disabled_at?: string | null
          id?: never
          key_hash: string
          key_id: string
          key_salt: string
          last_rotated_at?: string | null
          last_used_at?: string | null
          name: string
          status?: string
          tenant_id: number
        }
        Update: {
          broker_id?: number | null
          created_at?: string
          created_by?: number | null
          disabled_at?: string | null
          id?: never
          key_hash?: string
          key_id?: string
          key_salt?: string
          last_rotated_at?: string | null
          last_used_at?: string | null
          name?: string
          status?: string
          tenant_id?: number
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          acted_at: string
          action: string
          actor_label: string | null
          actor_user_id: number | null
          details: Json | null
          entity_id: string
          entity_type: string
          id: number
          tenant_id: number | null
        }
        Insert: {
          acted_at: string
          action: string
          actor_label?: string | null
          actor_user_id?: number | null
          details?: Json | null
          entity_id: string
          entity_type: string
          id?: never
          tenant_id?: number | null
        }
        Update: {
          acted_at?: string
          action?: string
          actor_label?: string | null
          actor_user_id?: number | null
          details?: Json | null
          entity_id?: string
          entity_type?: string
          id?: never
          tenant_id?: number | null
        }
        Relationships: []
      }
      broker_contacts: {
        Row: {
          broker_id: number
          created_at: string
          created_by: number | null
          email: string | null
          id: number
          is_primary: boolean
          name: string
          phone: string | null
          tenant_id: number
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          broker_id: number
          created_at: string
          created_by?: number | null
          email?: string | null
          id?: never
          is_primary?: boolean
          name: string
          phone?: string | null
          tenant_id: number
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          broker_id?: number
          created_at?: string
          created_by?: number | null
          email?: string | null
          id?: never
          is_primary?: boolean
          name?: string
          phone?: string | null
          tenant_id?: number
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      brokers: {
        Row: {
          branch: string | null
          broker_type_id: number | null
          created_at: string
          created_by: number | null
          id: number
          name: string
          status: string
          tenant_id: number
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          branch?: string | null
          broker_type_id?: number | null
          created_at: string
          created_by?: number | null
          id?: never
          name: string
          status?: string
          tenant_id: number
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          branch?: string | null
          broker_type_id?: number | null
          created_at?: string
          created_by?: number | null
          id?: never
          name?: string
          status?: string
          tenant_id?: number
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      business_assignments: {
        Row: {
          created_at: string
          created_by: number | null
          id: number
          role_id: number
          slot: string
          tenant_id: number
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          created_at: string
          created_by?: number | null
          id?: never
          role_id: number
          slot: string
          tenant_id: number
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          created_at?: string
          created_by?: number | null
          id?: never
          role_id?: number
          slot?: string
          tenant_id?: number
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      default_reference_items: {
        Row: {
          canonical_key: string | null
          created_at: string
          created_by: number | null
          default_product_line_key: string | null
          display_order: number
          id: number
          is_active: boolean
          is_broker_channel: boolean | null
          is_terminal: boolean
          list_type: string
          name: string
          reporting_category: string | null
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          canonical_key?: string | null
          created_at: string
          created_by?: number | null
          default_product_line_key?: string | null
          display_order?: number
          id?: never
          is_active?: boolean
          is_broker_channel?: boolean | null
          is_terminal?: boolean
          list_type: string
          name: string
          reporting_category?: string | null
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          canonical_key?: string | null
          created_at?: string
          created_by?: number | null
          default_product_line_key?: string | null
          display_order?: number
          id?: never
          is_active?: boolean
          is_broker_channel?: boolean | null
          is_terminal?: boolean
          list_type?: string
          name?: string
          reporting_category?: string | null
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      follow_ups: {
        Row: {
          follow_up_date: string
          id: number
          lead_id: number
          logged_at: string
          logged_by: number | null
          next_follow_up_date: string | null
          outcome_note: string
          tenant_id: number
        }
        Insert: {
          follow_up_date: string
          id?: never
          lead_id: number
          logged_at: string
          logged_by?: number | null
          next_follow_up_date?: string | null
          outcome_note: string
          tenant_id: number
        }
        Update: {
          follow_up_date?: string
          id?: never
          lead_id?: number
          logged_at?: string
          logged_by?: number | null
          next_follow_up_date?: string | null
          outcome_note?: string
          tenant_id?: number
        }
        Relationships: []
      }
      group_members: {
        Row: {
          created_at: string
          created_by: number | null
          group_id: number
          id: number
          user_id: number
        }
        Insert: {
          created_at: string
          created_by?: number | null
          group_id: number
          id?: never
          user_id: number
        }
        Update: {
          created_at?: string
          created_by?: number | null
          group_id?: number
          id?: never
          user_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_group_members_group"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "user_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_group_members_user"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      group_permissions: {
        Row: {
          created_at: string
          created_by: number | null
          group_id: number
          id: number
          permission_code: string
        }
        Insert: {
          created_at: string
          created_by?: number | null
          group_id: number
          id?: never
          permission_code: string
        }
        Update: {
          created_at?: string
          created_by?: number | null
          group_id?: number
          id?: never
          permission_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_group_permissions_group"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "user_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_group_permissions_permission"
            columns: ["permission_code"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["code"]
          },
        ]
      }
      group_roles: {
        Row: {
          created_at: string
          created_by: number | null
          group_id: number
          id: number
          role_id: number
        }
        Insert: {
          created_at: string
          created_by?: number | null
          group_id: number
          id?: never
          role_id: number
        }
        Update: {
          created_at?: string
          created_by?: number | null
          group_id?: number
          id?: never
          role_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_group_roles_group"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "user_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_group_roles_role"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_cron_config: {
        Row: {
          base_url: string
          cron_secret: string
          id: boolean
          internal_job_secret: string | null
          updated_at: string
        }
        Insert: {
          base_url: string
          cron_secret: string
          id?: boolean
          internal_job_secret?: string | null
          updated_at?: string
        }
        Update: {
          base_url?: string
          cron_secret?: string
          id?: boolean
          internal_job_secret?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      job_idempotency_key: {
        Row: {
          claimed_at: string
          job_name: string
          job_run_id: number | null
          key: string
          tenant_id: number | null
        }
        Insert: {
          claimed_at?: string
          job_name: string
          job_run_id?: number | null
          key: string
          tenant_id?: number | null
        }
        Update: {
          claimed_at?: string
          job_name?: string
          job_run_id?: number | null
          key?: string
          tenant_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "job_idempotency_key_job_run_id_fkey"
            columns: ["job_run_id"]
            isOneToOne: false
            referencedRelation: "job_run"
            referencedColumns: ["id"]
          },
        ]
      }
      job_run: {
        Row: {
          attempt: number
          correlation_id: string
          counts: Json | null
          duration_ms: number | null
          environment: string
          error_class: string | null
          error_message: string | null
          error_stack: string | null
          finished_at: string | null
          id: number
          idempotency_key: string | null
          job_name: string
          message_id: number | null
          started_at: string
          status: string
          trigger: string
        }
        Insert: {
          attempt?: number
          correlation_id: string
          counts?: Json | null
          duration_ms?: number | null
          environment: string
          error_class?: string | null
          error_message?: string | null
          error_stack?: string | null
          finished_at?: string | null
          id?: never
          idempotency_key?: string | null
          job_name: string
          message_id?: number | null
          started_at?: string
          status: string
          trigger: string
        }
        Update: {
          attempt?: number
          correlation_id?: string
          counts?: Json | null
          duration_ms?: number | null
          environment?: string
          error_class?: string | null
          error_message?: string | null
          error_stack?: string | null
          finished_at?: string | null
          id?: never
          idempotency_key?: string | null
          job_name?: string
          message_id?: number | null
          started_at?: string
          status?: string
          trigger?: string
        }
        Relationships: []
      }
      lead_assignments: {
        Row: {
          business_assignment_id: number
          created_at: string
          created_by: number | null
          id: number
          lead_id: number
          tenant_id: number
          updated_at: string
          updated_by: number | null
          user_id: number
        }
        Insert: {
          business_assignment_id: number
          created_at: string
          created_by?: number | null
          id?: never
          lead_id: number
          tenant_id: number
          updated_at: string
          updated_by?: number | null
          user_id: number
        }
        Update: {
          business_assignment_id?: number
          created_at?: string
          created_by?: number | null
          id?: never
          lead_id?: number
          tenant_id?: number
          updated_at?: string
          updated_by?: number | null
          user_id?: number
        }
        Relationships: []
      }
      lead_notes: {
        Row: {
          body: string
          created_at: string
          created_by: number | null
          id: number
          lead_id: number
          tenant_id: number
        }
        Insert: {
          body: string
          created_at: string
          created_by?: number | null
          id?: never
          lead_id: number
          tenant_id: number
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: number | null
          id?: never
          lead_id?: number
          tenant_id?: number
        }
        Relationships: []
      }
      lead_status_history: {
        Row: {
          acted_at: string
          acted_by: number | null
          id: number
          inputs: Json | null
          lead_id: number
          new_status_id: number | null
          operation: string
          previous_status_id: number | null
          tenant_id: number
        }
        Insert: {
          acted_at: string
          acted_by?: number | null
          id?: never
          inputs?: Json | null
          lead_id: number
          new_status_id?: number | null
          operation: string
          previous_status_id?: number | null
          tenant_id: number
        }
        Update: {
          acted_at?: string
          acted_by?: number | null
          id?: never
          inputs?: Json | null
          lead_id?: number
          new_status_id?: number | null
          operation?: string
          previous_status_id?: number | null
          tenant_id?: number
        }
        Relationships: []
      }
      leads: {
        Row: {
          broker_id: number | null
          competitor: string | null
          competitor_premium: number | null
          cover_type_id: number
          created_at: string
          created_by: number | null
          date_assigned: string | null
          date_received: string
          decision_date: string | null
          estimated_premium: number | null
          external_ref: string | null
          follow_up_count: number
          id: number
          intake_credential_id: number | null
          is_existing_client: boolean
          last_activity_at: string | null
          last_follow_up_date: string | null
          lead_ref: string
          loss_comments: string | null
          lost_before_quote: boolean | null
          lost_reason_id: number | null
          next_follow_up_date: string | null
          party_id: number
          policy_term: string
          policy_term_other: string | null
          pricing_approval_state: string
          priority: string
          product_line_id: number
          region_id: number
          request_channel_id: number
          source: string
          status_id: number
          sum_insured: number | null
          tenant_id: number
          updated_at: string
          updated_by: number | null
          withdrawal_note: string | null
        }
        Insert: {
          broker_id?: number | null
          competitor?: string | null
          competitor_premium?: number | null
          cover_type_id: number
          created_at: string
          created_by?: number | null
          date_assigned?: string | null
          date_received: string
          decision_date?: string | null
          estimated_premium?: number | null
          external_ref?: string | null
          follow_up_count?: number
          id?: never
          intake_credential_id?: number | null
          is_existing_client?: boolean
          last_activity_at?: string | null
          last_follow_up_date?: string | null
          lead_ref: string
          loss_comments?: string | null
          lost_before_quote?: boolean | null
          lost_reason_id?: number | null
          next_follow_up_date?: string | null
          party_id: number
          policy_term: string
          policy_term_other?: string | null
          pricing_approval_state?: string
          priority?: string
          product_line_id: number
          region_id: number
          request_channel_id: number
          source: string
          status_id: number
          sum_insured?: number | null
          tenant_id: number
          updated_at: string
          updated_by?: number | null
          withdrawal_note?: string | null
        }
        Update: {
          broker_id?: number | null
          competitor?: string | null
          competitor_premium?: number | null
          cover_type_id?: number
          created_at?: string
          created_by?: number | null
          date_assigned?: string | null
          date_received?: string
          decision_date?: string | null
          estimated_premium?: number | null
          external_ref?: string | null
          follow_up_count?: number
          id?: never
          intake_credential_id?: number | null
          is_existing_client?: boolean
          last_activity_at?: string | null
          last_follow_up_date?: string | null
          lead_ref?: string
          loss_comments?: string | null
          lost_before_quote?: boolean | null
          lost_reason_id?: number | null
          next_follow_up_date?: string | null
          party_id?: number
          policy_term?: string
          policy_term_other?: string | null
          pricing_approval_state?: string
          priority?: string
          product_line_id?: number
          region_id?: number
          request_channel_id?: number
          source?: string
          status_id?: number
          sum_insured?: number | null
          tenant_id?: number
          updated_at?: string
          updated_by?: number | null
          withdrawal_note?: string | null
        }
        Relationships: []
      }
      parties: {
        Row: {
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          created_by: number | null
          id: number
          industry_id: number | null
          is_strategic: boolean
          last_activity_at: string | null
          name: string
          party_type_id: number
          region_id: number | null
          segment_id: number | null
          tenant_id: number
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at: string
          created_by?: number | null
          id?: never
          industry_id?: number | null
          is_strategic?: boolean
          last_activity_at?: string | null
          name: string
          party_type_id: number
          region_id?: number | null
          segment_id?: number | null
          tenant_id: number
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by?: number | null
          id?: never
          industry_id?: number | null
          is_strategic?: boolean
          last_activity_at?: string | null
          name?: string
          party_type_id?: number
          region_id?: number | null
          segment_id?: number | null
          tenant_id?: number
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      permissions: {
        Row: {
          category: string
          code: string
          description: string
        }
        Insert: {
          category: string
          code: string
          description: string
        }
        Update: {
          category?: string
          code?: string
          description?: string
        }
        Relationships: []
      }
      pricing_approvals: {
        Row: {
          approver_id: number
          decided_at: string | null
          decided_by: number | null
          decision_note: string | null
          id: number
          lead_id: number
          proposed_premium: number | null
          rejection_reason: string | null
          request_note: string | null
          requested_at: string
          requested_by: number
          state: string
          tenant_id: number
        }
        Insert: {
          approver_id: number
          decided_at?: string | null
          decided_by?: number | null
          decision_note?: string | null
          id?: never
          lead_id: number
          proposed_premium?: number | null
          rejection_reason?: string | null
          request_note?: string | null
          requested_at: string
          requested_by: number
          state: string
          tenant_id: number
        }
        Update: {
          approver_id?: number
          decided_at?: string | null
          decided_by?: number | null
          decision_note?: string | null
          id?: never
          lead_id?: number
          proposed_premium?: number | null
          rejection_reason?: string | null
          request_note?: string | null
          requested_at?: string
          requested_by?: number
          state?: string
          tenant_id?: number
        }
        Relationships: []
      }
      quote_assignments: {
        Row: {
          business_assignment_id: number
          created_at: string
          created_by: number | null
          id: number
          quote_id: number
          tenant_id: number
          updated_at: string
          updated_by: number | null
          user_id: number
        }
        Insert: {
          business_assignment_id: number
          created_at: string
          created_by?: number | null
          id?: never
          quote_id: number
          tenant_id: number
          updated_at: string
          updated_by?: number | null
          user_id: number
        }
        Update: {
          business_assignment_id?: number
          created_at?: string
          created_by?: number | null
          id?: never
          quote_id?: number
          tenant_id?: number
          updated_at?: string
          updated_by?: number | null
          user_id?: number
        }
        Relationships: []
      }
      quote_attachments: {
        Row: {
          confirmed_at: string | null
          content_type: string
          file_name: string
          id: number
          quote_id: number
          removed_at: string | null
          removed_by: number | null
          size_bytes: number
          storage_key: string
          tenant_id: number
          uploaded_at: string
          uploaded_by: number | null
        }
        Insert: {
          confirmed_at?: string | null
          content_type: string
          file_name: string
          id?: never
          quote_id: number
          removed_at?: string | null
          removed_by?: number | null
          size_bytes: number
          storage_key: string
          tenant_id: number
          uploaded_at: string
          uploaded_by?: number | null
        }
        Update: {
          confirmed_at?: string | null
          content_type?: string
          file_name?: string
          id?: never
          quote_id?: number
          removed_at?: string | null
          removed_by?: number | null
          size_bytes?: number
          storage_key?: string
          tenant_id?: number
          uploaded_at?: string
          uploaded_by?: number | null
        }
        Relationships: []
      }
      quote_status_history: {
        Row: {
          acted_at: string
          acted_by: number | null
          id: number
          inputs: Json | null
          new_status_id: number | null
          operation: string
          previous_status_id: number | null
          quote_id: number
          tenant_id: number
        }
        Insert: {
          acted_at: string
          acted_by?: number | null
          id?: never
          inputs?: Json | null
          new_status_id?: number | null
          operation: string
          previous_status_id?: number | null
          quote_id: number
          tenant_id: number
        }
        Update: {
          acted_at?: string
          acted_by?: number | null
          id?: never
          inputs?: Json | null
          new_status_id?: number | null
          operation?: string
          previous_status_id?: number | null
          quote_id?: number
          tenant_id?: number
        }
        Relationships: []
      }
      quote_versions: {
        Row: {
          created_at: string
          created_by: number | null
          id: number
          is_current: boolean
          quote_id: number
          quoted_premium: number
          revision_note: string | null
          tenant_id: number
          terms_notes: string | null
          version_no: number
        }
        Insert: {
          created_at: string
          created_by?: number | null
          id?: never
          is_current?: boolean
          quote_id: number
          quoted_premium: number
          revision_note?: string | null
          tenant_id: number
          terms_notes?: string | null
          version_no: number
        }
        Update: {
          created_at?: string
          created_by?: number | null
          id?: never
          is_current?: boolean
          quote_id?: number
          quoted_premium?: number
          revision_note?: string | null
          tenant_id?: number
          terms_notes?: string | null
          version_no?: number
        }
        Relationships: []
      }
      quotes: {
        Row: {
          bound_premium: number | null
          competitor: string | null
          competitor_premium: number | null
          cover_type_id: number
          created_at: string
          created_by: number | null
          decision_date: string | null
          id: number
          is_current: boolean
          lead_id: number
          loss_comments: string | null
          lost_reason_id: number | null
          notes: string | null
          prepared_date: string
          product_line_id: number
          quote_ref: string
          sent_date: string | null
          status_id: number
          tenant_id: number
          updated_at: string
          updated_by: number | null
          valid_until: string | null
          withdrawal_note: string | null
        }
        Insert: {
          bound_premium?: number | null
          competitor?: string | null
          competitor_premium?: number | null
          cover_type_id: number
          created_at: string
          created_by?: number | null
          decision_date?: string | null
          id?: never
          is_current?: boolean
          lead_id: number
          loss_comments?: string | null
          lost_reason_id?: number | null
          notes?: string | null
          prepared_date: string
          product_line_id: number
          quote_ref: string
          sent_date?: string | null
          status_id: number
          tenant_id: number
          updated_at: string
          updated_by?: number | null
          valid_until?: string | null
          withdrawal_note?: string | null
        }
        Update: {
          bound_premium?: number | null
          competitor?: string | null
          competitor_premium?: number | null
          cover_type_id?: number
          created_at?: string
          created_by?: number | null
          decision_date?: string | null
          id?: never
          is_current?: boolean
          lead_id?: number
          loss_comments?: string | null
          lost_reason_id?: number | null
          notes?: string | null
          prepared_date?: string
          product_line_id?: number
          quote_ref?: string
          sent_date?: string | null
          status_id?: number
          tenant_id?: number
          updated_at?: string
          updated_by?: number | null
          valid_until?: string | null
          withdrawal_note?: string | null
        }
        Relationships: []
      }
      reference_items: {
        Row: {
          canonical_key: string | null
          created_at: string
          created_by: number | null
          display_order: number
          id: number
          is_active: boolean
          is_broker_channel: boolean | null
          is_terminal: boolean
          list_type: string
          name: string
          product_line_id: number | null
          reporting_category: string | null
          tenant_id: number
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          canonical_key?: string | null
          created_at: string
          created_by?: number | null
          display_order?: number
          id?: never
          is_active?: boolean
          is_broker_channel?: boolean | null
          is_terminal?: boolean
          list_type: string
          name: string
          product_line_id?: number | null
          reporting_category?: string | null
          tenant_id: number
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          canonical_key?: string | null
          created_at?: string
          created_by?: number | null
          display_order?: number
          id?: never
          is_active?: boolean
          is_broker_channel?: boolean | null
          is_terminal?: boolean
          list_type?: string
          name?: string
          product_line_id?: number | null
          reporting_category?: string | null
          tenant_id?: number
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      reference_sequences: {
        Row: {
          entity_type: string
          id: number
          next_value: number
          tenant_id: number
          year: number
        }
        Insert: {
          entity_type: string
          id?: never
          next_value?: number
          tenant_id: number
          year: number
        }
        Update: {
          entity_type?: string
          id?: never
          next_value?: number
          tenant_id?: number
          year?: number
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          created_at: string
          created_by: number | null
          id: number
          permission_code: string
          role_id: number
        }
        Insert: {
          created_at: string
          created_by?: number | null
          id?: never
          permission_code: string
          role_id: number
        }
        Update: {
          created_at?: string
          created_by?: number | null
          id?: never
          permission_code?: string
          role_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_role_permissions_permission"
            columns: ["permission_code"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "fk_role_permissions_role"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          created_by: number | null
          id: number
          is_active: boolean
          name: string
          tenant_id: number | null
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          created_at: string
          created_by?: number | null
          id?: never
          is_active?: boolean
          name: string
          tenant_id?: number | null
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          created_at?: string
          created_by?: number | null
          id?: never
          is_active?: boolean
          name?: string
          tenant_id?: number | null
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      tenant_settings: {
        Row: {
          aging_amber_days: number
          aging_red_days: number
          created_at: string
          created_by: number | null
          currency_code: string
          currency_symbol: string
          duplicate_check_days: number
          expire_lead_when_last_quote_expires: boolean
          follow_up_overdue_grace_days: number
          high_value_threshold: number | null
          id: number
          lead_inactivity_expiry_days: number
          lead_ref_format: string
          manual_external_ref_enabled: boolean
          max_attachment_mb: number
          pricing_approval_target_days: number
          quote_expiry_alert_days: number
          quote_ref_format: string
          require_pricing_approval_for_high_value: boolean
          sla_assignment_days: number
          sla_received_to_sent_days: number
          sla_underwriting_days: number
          stalled_lead_days: number
          stalled_quote_days: number
          tenant_id: number
          unassigned_lead_hours: number
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          aging_amber_days?: number
          aging_red_days?: number
          created_at: string
          created_by?: number | null
          currency_code?: string
          currency_symbol?: string
          duplicate_check_days?: number
          expire_lead_when_last_quote_expires?: boolean
          follow_up_overdue_grace_days?: number
          high_value_threshold?: number | null
          id?: never
          lead_inactivity_expiry_days?: number
          lead_ref_format?: string
          manual_external_ref_enabled?: boolean
          max_attachment_mb?: number
          pricing_approval_target_days?: number
          quote_expiry_alert_days?: number
          quote_ref_format?: string
          require_pricing_approval_for_high_value?: boolean
          sla_assignment_days?: number
          sla_received_to_sent_days?: number
          sla_underwriting_days?: number
          stalled_lead_days?: number
          stalled_quote_days?: number
          tenant_id: number
          unassigned_lead_hours?: number
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          aging_amber_days?: number
          aging_red_days?: number
          created_at?: string
          created_by?: number | null
          currency_code?: string
          currency_symbol?: string
          duplicate_check_days?: number
          expire_lead_when_last_quote_expires?: boolean
          follow_up_overdue_grace_days?: number
          high_value_threshold?: number | null
          id?: never
          lead_inactivity_expiry_days?: number
          lead_ref_format?: string
          manual_external_ref_enabled?: boolean
          max_attachment_mb?: number
          pricing_approval_target_days?: number
          quote_expiry_alert_days?: number
          quote_ref_format?: string
          require_pricing_approval_for_high_value?: boolean
          sla_assignment_days?: number
          sla_received_to_sent_days?: number
          sla_underwriting_days?: number
          stalled_lead_days?: number
          stalled_quote_days?: number
          tenant_id?: number
          unassigned_lead_hours?: number
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      tenants: {
        Row: {
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          created_by: number | null
          id: number
          name: string
          removed_at: string | null
          removed_by: number | null
          status: string
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at: string
          created_by?: number | null
          id?: never
          name: string
          removed_at?: string | null
          removed_by?: number | null
          status?: string
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by?: number | null
          id?: never
          name?: string
          removed_at?: string | null
          removed_by?: number | null
          status?: string
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      user_alert_views: {
        Row: {
          id: number
          last_opened_at: string
          tenant_id: number
          user_id: number
        }
        Insert: {
          id?: never
          last_opened_at: string
          tenant_id: number
          user_id: number
        }
        Update: {
          id?: never
          last_opened_at?: string
          tenant_id?: number
          user_id?: number
        }
        Relationships: []
      }
      user_groups: {
        Row: {
          created_at: string
          created_by: number | null
          id: number
          is_active: boolean
          name: string
          tenant_id: number | null
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          created_at: string
          created_by?: number | null
          id?: never
          is_active?: boolean
          name: string
          tenant_id?: number | null
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          created_at?: string
          created_by?: number | null
          id?: never
          is_active?: boolean
          name?: string
          tenant_id?: number | null
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
      user_permissions: {
        Row: {
          created_at: string
          created_by: number | null
          id: number
          permission_code: string
          tenant_id: number | null
          user_id: number
        }
        Insert: {
          created_at: string
          created_by?: number | null
          id?: never
          permission_code: string
          tenant_id?: number | null
          user_id: number
        }
        Update: {
          created_at?: string
          created_by?: number | null
          id?: never
          permission_code?: string
          tenant_id?: number | null
          user_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_user_permissions_permission"
            columns: ["permission_code"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "fk_user_permissions_user"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          created_by: number | null
          id: number
          role_id: number
          tenant_id: number | null
          user_id: number
        }
        Insert: {
          created_at: string
          created_by?: number | null
          id?: never
          role_id: number
          tenant_id?: number | null
          user_id: number
        }
        Update: {
          created_at?: string
          created_by?: number | null
          id?: never
          role_id?: number
          tenant_id?: number | null
          user_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_user_roles_role"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_user_roles_user"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_tenants: {
        Row: {
          created_at: string
          created_by: number | null
          id: number
          tenant_id: number
          user_id: number
        }
        Insert: {
          created_at: string
          created_by?: number | null
          id?: never
          tenant_id: number
          user_id: number
        }
        Update: {
          created_at?: string
          created_by?: number | null
          id?: never
          tenant_id?: number
          user_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_tenants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          auth_user_id: string
          created_at: string
          created_by: number | null
          email: string
          first_name: string
          id: number
          is_active: boolean
          last_name: string
          last_tenant_id: number | null
          theme_preference: string | null
          updated_at: string
          updated_by: number | null
        }
        Insert: {
          auth_user_id: string
          created_at: string
          created_by?: number | null
          email: string
          first_name: string
          id?: never
          is_active?: boolean
          last_name: string
          last_tenant_id?: number | null
          theme_preference?: string | null
          updated_at: string
          updated_by?: number | null
        }
        Update: {
          auth_user_id?: string
          created_at?: string
          created_by?: number | null
          email?: string
          first_name?: string
          id?: never
          is_active?: boolean
          last_name?: string
          last_tenant_id?: number | null
          theme_preference?: string | null
          updated_at?: string
          updated_by?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_tenant_partitions: {
        Args: { p_tenant_id: number }
        Returns: undefined
      }
      invoke_cron_endpoint: { Args: { job_name: string }; Returns: undefined }
      invoke_queue_drain: { Args: never; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
