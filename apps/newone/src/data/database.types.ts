export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      announcement_acknowledgements: {
        Row: {
          acknowledged_at: string
          announcement_id: string
          announcement_version_id: string
          attestation: Json
          client_family: string | null
          device_id: string | null
          installation_id: string | null
          organization_id: string
          platform: string | null
          role_snapshot: string
          scope_snapshot: Json
          session_evidence_hash: string | null
          session_id: string | null
          user_id: string
        }
        Insert: {
          acknowledged_at?: string
          announcement_id: string
          announcement_version_id: string
          attestation?: Json
          client_family?: string | null
          device_id?: string | null
          installation_id?: string | null
          organization_id: string
          platform?: string | null
          role_snapshot?: string
          scope_snapshot?: Json
          session_evidence_hash?: string | null
          session_id?: string | null
          user_id: string
        }
        Update: {
          acknowledged_at?: string
          announcement_id?: string
          announcement_version_id?: string
          attestation?: Json
          client_family?: string | null
          device_id?: string | null
          installation_id?: string | null
          organization_id?: string
          platform?: string | null
          role_snapshot?: string
          scope_snapshot?: Json
          session_evidence_hash?: string | null
          session_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_acknowledgement_organization_id_announcement_fkey1"
            columns: [
              "organization_id",
              "announcement_id",
              "announcement_version_id",
            ]
            isOneToOne: false
            referencedRelation: "announcement_versions"
            referencedColumns: ["organization_id", "announcement_id", "id"]
          },
          {
            foreignKeyName: "announcement_acknowledgements_organization_id_announcement_fkey"
            columns: ["organization_id", "announcement_id", "user_id"]
            isOneToOne: false
            referencedRelation: "announcement_recipients"
            referencedColumns: ["organization_id", "announcement_id", "user_id"]
          },
          {
            foreignKeyName: "announcement_acknowledgements_organization_id_device_id_fkey"
            columns: ["organization_id", "device_id"]
            isOneToOne: false
            referencedRelation: "device_registrations"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      announcement_recipients: {
        Row: {
          announcement_id: string
          audience_snapshot: Json
          created_at: string
          delivered_at: string | null
          escalated_at: string | null
          last_reminded_at: string | null
          organization_id: string
          read_at: string | null
          reminder_count: number
          user_id: string
        }
        Insert: {
          announcement_id: string
          audience_snapshot?: Json
          created_at?: string
          delivered_at?: string | null
          escalated_at?: string | null
          last_reminded_at?: string | null
          organization_id: string
          read_at?: string | null
          reminder_count?: number
          user_id: string
        }
        Update: {
          announcement_id?: string
          audience_snapshot?: Json
          created_at?: string
          delivered_at?: string | null
          escalated_at?: string | null
          last_reminded_at?: string | null
          organization_id?: string
          read_at?: string | null
          reminder_count?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_recipients_organization_id_announcement_id_fkey"
            columns: ["organization_id", "announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "announcement_recipients_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      announcement_versions: {
        Row: {
          acknowledgement_schema: Json
          announcement_id: string
          conversation_id: string
          correction_of_version_id: string | null
          correction_reason: string | null
          created_by_user_id: string
          critical_category: string | null
          expires_at: string | null
          id: string
          message_id: number
          notification_class: string
          organization_id: string
          priority: string
          published_at: string | null
          quiet_hours_override_reason: string | null
          reminder_policy: Json
          requires_acknowledgement: boolean
          scheduled_at: string | null
          title: string
          version_number: number
        }
        Insert: {
          acknowledgement_schema: Json
          announcement_id: string
          conversation_id: string
          correction_of_version_id?: string | null
          correction_reason?: string | null
          created_by_user_id: string
          critical_category?: string | null
          expires_at?: string | null
          id?: string
          message_id: number
          notification_class: string
          organization_id: string
          priority: string
          published_at?: string | null
          quiet_hours_override_reason?: string | null
          reminder_policy: Json
          requires_acknowledgement: boolean
          scheduled_at?: string | null
          title: string
          version_number: number
        }
        Update: {
          acknowledgement_schema?: Json
          announcement_id?: string
          conversation_id?: string
          correction_of_version_id?: string | null
          correction_reason?: string | null
          created_by_user_id?: string
          critical_category?: string | null
          expires_at?: string | null
          id?: string
          message_id?: number
          notification_class?: string
          organization_id?: string
          priority?: string
          published_at?: string | null
          quiet_hours_override_reason?: string | null
          reminder_policy?: Json
          requires_acknowledgement?: boolean
          scheduled_at?: string | null
          title?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "announcement_versions_organization_id_announcement_id_corr_fkey"
            columns: [
              "organization_id",
              "announcement_id",
              "correction_of_version_id",
            ]
            isOneToOne: false
            referencedRelation: "announcement_versions"
            referencedColumns: ["organization_id", "announcement_id", "id"]
          },
          {
            foreignKeyName: "announcement_versions_organization_id_announcement_id_fkey"
            columns: ["organization_id", "announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "announcement_versions_organization_id_conversation_id_crea_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "created_by_user_id",
            ]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "announcement_versions_organization_id_conversation_id_mess_fkey"
            columns: ["organization_id", "conversation_id", "message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
        ]
      }
      announcements: {
        Row: {
          acknowledgement_schema: Json
          audience_snapshotted_at: string | null
          audience_spec: Json
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by_user_id: string | null
          conversation_id: string
          created_at: string
          created_by_user_id: string
          critical_category: string | null
          expires_at: string | null
          id: string
          message_id: number
          notification_class: string
          organization_id: string
          priority: string
          published_at: string | null
          quiet_hours_override_reason: string | null
          reminder_policy: Json
          requires_acknowledgement: boolean
          scheduled_at: string | null
          status: string
          title: string
        }
        Insert: {
          acknowledgement_schema?: Json
          audience_snapshotted_at?: string | null
          audience_spec?: Json
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by_user_id?: string | null
          conversation_id: string
          created_at?: string
          created_by_user_id: string
          critical_category?: string | null
          expires_at?: string | null
          id?: string
          message_id: number
          notification_class?: string
          organization_id: string
          priority?: string
          published_at?: string | null
          quiet_hours_override_reason?: string | null
          reminder_policy?: Json
          requires_acknowledgement?: boolean
          scheduled_at?: string | null
          status?: string
          title: string
        }
        Update: {
          acknowledgement_schema?: Json
          audience_snapshotted_at?: string | null
          audience_spec?: Json
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by_user_id?: string | null
          conversation_id?: string
          created_at?: string
          created_by_user_id?: string
          critical_category?: string | null
          expires_at?: string | null
          id?: string
          message_id?: number
          notification_class?: string
          organization_id?: string
          priority?: string
          published_at?: string | null
          quiet_hours_override_reason?: string | null
          reminder_policy?: Json
          requires_acknowledgement?: boolean
          scheduled_at?: string | null
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_organization_id_cancelled_by_user_id_fkey"
            columns: ["organization_id", "cancelled_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "announcements_organization_id_conversation_id_created_by_u_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "created_by_user_id",
            ]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "announcements_organization_id_conversation_id_message_id_fkey"
            columns: ["organization_id", "conversation_id", "message_id"]
            isOneToOne: true
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
        ]
      }
      audit_events: {
        Row: {
          actor_user_id: string | null
          event_type: string
          id: number
          ip_hash: string | null
          metadata: Json
          occurred_at: string
          organization_id: string
          request_id: string | null
          target_id: string
          target_type: string
          user_agent_hash: string | null
        }
        Insert: {
          actor_user_id?: string | null
          event_type: string
          id?: never
          ip_hash?: string | null
          metadata?: Json
          occurred_at?: string
          organization_id: string
          request_id?: string | null
          target_id: string
          target_type: string
          user_agent_hash?: string | null
        }
        Update: {
          actor_user_id?: string | null
          event_type?: string
          id?: never
          ip_hash?: string | null
          metadata?: Json
          occurred_at?: string
          organization_id?: string
          request_id?: string | null
          target_id?: string
          target_type?: string
          user_agent_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_organization_id_actor_user_id_fkey"
            columns: ["organization_id", "actor_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "audit_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_connections: {
        Row: {
          created_at: string
          member_high_user_id: string
          member_low_user_id: string
          organization_id: string
          requested_by_user_id: string
          responded_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          member_high_user_id: string
          member_low_user_id: string
          organization_id: string
          requested_by_user_id: string
          responded_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          member_high_user_id?: string
          member_low_user_id?: string
          organization_id?: string
          requested_by_user_id?: string
          responded_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_connections_organization_id_member_high_user_id_fkey"
            columns: ["organization_id", "member_high_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "contact_connections_organization_id_member_low_user_id_fkey"
            columns: ["organization_id", "member_low_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "contact_connections_organization_id_requested_by_user_id_fkey"
            columns: ["organization_id", "requested_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      conversation_join_requests: {
        Row: {
          conversation_id: string
          decided_at: string | null
          decided_by_user_id: string | null
          decision_reason: string | null
          expires_at: string
          id: string
          organization_id: string
          requested_at: string
          requester_user_id: string
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          conversation_id: string
          decided_at?: string | null
          decided_by_user_id?: string | null
          decision_reason?: string | null
          expires_at: string
          id?: string
          organization_id: string
          requested_at?: string
          requester_user_id: string
          status?: string
          updated_at?: string
          version?: number
        }
        Update: {
          conversation_id?: string
          decided_at?: string | null
          decided_by_user_id?: string | null
          decision_reason?: string | null
          expires_at?: string
          id?: string
          organization_id?: string
          requested_at?: string
          requester_user_id?: string
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "conversation_join_requests_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "conversation_join_requests_organization_id_decided_by_user_fkey"
            columns: ["organization_id", "decided_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "conversation_join_requests_organization_id_requester_user__fkey"
            columns: ["organization_id", "requester_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      conversation_members: {
        Row: {
          can_post: boolean
          conversation_id: string
          history_visible_from: string | null
          joined_at: string
          joined_by_user_id: string | null
          left_at: string | null
          managed_by_policy_id: string | null
          muted_until: string | null
          notification_level: string
          organization_id: string
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          can_post?: boolean
          conversation_id: string
          history_visible_from?: string | null
          joined_at?: string
          joined_by_user_id?: string | null
          left_at?: string | null
          managed_by_policy_id?: string | null
          muted_until?: string | null
          notification_level?: string
          organization_id: string
          role?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          can_post?: boolean
          conversation_id?: string
          history_visible_from?: string | null
          joined_at?: string
          joined_by_user_id?: string | null
          left_at?: string | null
          managed_by_policy_id?: string | null
          muted_until?: string | null
          notification_level?: string
          organization_id?: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_members_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "conversation_members_organization_id_joined_by_user_id_fkey"
            columns: ["organization_id", "joined_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "conversation_members_organization_id_managed_by_policy_id_fkey"
            columns: ["organization_id", "managed_by_policy_id"]
            isOneToOne: false
            referencedRelation: "dynamic_group_policies"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "conversation_members_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      conversation_preferences: {
        Row: {
          conversation_id: string
          is_favorite: boolean
          is_hidden: boolean
          is_pinned: boolean
          muted_until: string | null
          notification_level: string
          organization_id: string
          translation_mode: string
          updated_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          is_favorite?: boolean
          is_hidden?: boolean
          is_pinned?: boolean
          muted_until?: string | null
          notification_level?: string
          organization_id: string
          translation_mode?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          is_favorite?: boolean
          is_hidden?: boolean
          is_pinned?: boolean
          muted_until?: string | null
          notification_level?: string
          organization_id?: string
          translation_mode?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_preferences_organization_id_conversation_id_u_fkey"
            columns: ["organization_id", "conversation_id", "user_id"]
            isOneToOne: true
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
        ]
      }
      conversation_read_cursors: {
        Row: {
          conversation_id: string
          last_read_at: string
          last_read_message_id: number | null
          organization_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          last_read_at?: string
          last_read_message_id?: number | null
          organization_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          last_read_at?: string
          last_read_message_id?: number | null
          organization_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_read_cursors_organization_id_conversation_id__fkey"
            columns: ["organization_id", "conversation_id", "user_id"]
            isOneToOne: true
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "conversation_read_cursors_organization_id_conversation_id_fkey1"
            columns: [
              "organization_id",
              "conversation_id",
              "last_read_message_id",
            ]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
        ]
      }
      conversation_summaries: {
        Row: {
          action_items: Json | null
          ambiguities: string[] | null
          conversation_id: string
          correction_of_summary_id: string | null
          created_at: string
          decisions: Json | null
          failure_code: string | null
          id: string
          key_topics: string[] | null
          language_code: string
          model: string | null
          organization_id: string
          output_fingerprint: string | null
          primary_topic: string | null
          processor_provenance: Json
          processor_type: string | null
          provider: string | null
          request_mode: string
          requested_by_user_id: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by_user_id: string | null
          source_fingerprint: string
          source_first_message_id: number
          source_last_message_id: number
          source_message_ids: number[]
          status: string
          summary_body: string | null
          updated_at: string
          version_number: number
        }
        Insert: {
          action_items?: Json | null
          ambiguities?: string[] | null
          conversation_id: string
          correction_of_summary_id?: string | null
          created_at?: string
          decisions?: Json | null
          failure_code?: string | null
          id?: string
          key_topics?: string[] | null
          language_code: string
          model?: string | null
          organization_id: string
          output_fingerprint?: string | null
          primary_topic?: string | null
          processor_provenance?: Json
          processor_type?: string | null
          provider?: string | null
          request_mode?: string
          requested_by_user_id: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          source_fingerprint: string
          source_first_message_id: number
          source_last_message_id: number
          source_message_ids: number[]
          status?: string
          summary_body?: string | null
          updated_at?: string
          version_number: number
        }
        Update: {
          action_items?: Json | null
          ambiguities?: string[] | null
          conversation_id?: string
          correction_of_summary_id?: string | null
          created_at?: string
          decisions?: Json | null
          failure_code?: string | null
          id?: string
          key_topics?: string[] | null
          language_code?: string
          model?: string | null
          organization_id?: string
          output_fingerprint?: string | null
          primary_topic?: string | null
          processor_provenance?: Json
          processor_type?: string | null
          provider?: string | null
          request_mode?: string
          requested_by_user_id?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          source_fingerprint?: string
          source_first_message_id?: number
          source_last_message_id?: number
          source_message_ids?: number[]
          status?: string
          summary_body?: string | null
          updated_at?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "conversation_summaries_organization_id_conversation_id_req_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "requested_by_user_id",
            ]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "conversation_summaries_organization_id_conversation_id_so_fkey1"
            columns: [
              "organization_id",
              "conversation_id",
              "source_last_message_id",
            ]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "conversation_summaries_organization_id_conversation_id_sou_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "source_first_message_id",
            ]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "conversation_summaries_organization_id_correction_of_summa_fkey"
            columns: ["organization_id", "correction_of_summary_id"]
            isOneToOne: false
            referencedRelation: "conversation_summaries"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "conversation_summaries_organization_id_reviewed_by_user_id_fkey"
            columns: ["organization_id", "reviewed_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      conversation_summary_policies: {
        Row: {
          conversation_id: string
          message_count_threshold: number | null
          mode: string
          organization_id: string
          require_human_review: boolean
          updated_at: string
          updated_by_user_id: string
        }
        Insert: {
          conversation_id: string
          message_count_threshold?: number | null
          mode?: string
          organization_id: string
          require_human_review?: boolean
          updated_at?: string
          updated_by_user_id: string
        }
        Update: {
          conversation_id?: string
          message_count_threshold?: number | null
          mode?: string
          organization_id?: string
          require_human_review?: boolean
          updated_at?: string
          updated_by_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_summary_policies_organization_id_conversation_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "updated_by_user_id",
            ]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
        ]
      }
      conversations: {
        Row: {
          avatar_path: string | null
          closed_at: string | null
          closed_by_user_id: string | null
          closure_reason: string | null
          created_at: string
          created_by_user_id: string
          description: string | null
          history_policy: string
          id: string
          incident_classification: string | null
          incident_severity: string | null
          is_archived: boolean
          join_policy: string
          kind: string
          member_limit: number
          name: string | null
          organization_id: string
          posting_mode: string
          unit_id: string | null
          updated_at: string
          visibility: string
        }
        Insert: {
          avatar_path?: string | null
          closed_at?: string | null
          closed_by_user_id?: string | null
          closure_reason?: string | null
          created_at?: string
          created_by_user_id: string
          description?: string | null
          history_policy?: string
          id?: string
          incident_classification?: string | null
          incident_severity?: string | null
          is_archived?: boolean
          join_policy?: string
          kind: string
          member_limit?: number
          name?: string | null
          organization_id: string
          posting_mode?: string
          unit_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Update: {
          avatar_path?: string | null
          closed_at?: string | null
          closed_by_user_id?: string | null
          closure_reason?: string | null
          created_at?: string
          created_by_user_id?: string
          description?: string | null
          history_policy?: string
          id?: string
          incident_classification?: string | null
          incident_severity?: string | null
          is_archived?: boolean
          join_policy?: string
          kind?: string
          member_limit?: number
          name?: string | null
          organization_id?: string
          posting_mode?: string
          unit_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_organization_id_closed_by_user_id_fkey"
            columns: ["organization_id", "closed_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "conversations_organization_id_created_by_user_id_fkey"
            columns: ["organization_id", "created_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "conversations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_organization_id_unit_id_fkey"
            columns: ["organization_id", "unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      device_registrations: {
        Row: {
          app_version: string | null
          created_at: string
          id: string
          installation_id: string
          last_seen_at: string
          locale: string | null
          notification_preferences_updated_at: string
          notification_preferences_version: number
          notification_preview_override: string | null
          organization_id: string
          platform: string
          push_environment: string
          push_project_id: string
          push_token_ciphertext: string
          push_token_type: string
          revoked_at: string | null
          session_id: string | null
          sound_enabled_override: boolean | null
          updated_at: string
          user_id: string
          vibration_enabled_override: boolean | null
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          id?: string
          installation_id: string
          last_seen_at?: string
          locale?: string | null
          notification_preferences_updated_at?: string
          notification_preferences_version?: number
          notification_preview_override?: string | null
          organization_id: string
          platform: string
          push_environment: string
          push_project_id: string
          push_token_ciphertext: string
          push_token_type: string
          revoked_at?: string | null
          session_id?: string | null
          sound_enabled_override?: boolean | null
          updated_at?: string
          user_id: string
          vibration_enabled_override?: boolean | null
        }
        Update: {
          app_version?: string | null
          created_at?: string
          id?: string
          installation_id?: string
          last_seen_at?: string
          locale?: string | null
          notification_preferences_updated_at?: string
          notification_preferences_version?: number
          notification_preview_override?: string | null
          organization_id?: string
          platform?: string
          push_environment?: string
          push_project_id?: string
          push_token_ciphertext?: string
          push_token_type?: string
          revoked_at?: string | null
          session_id?: string | null
          sound_enabled_override?: boolean | null
          updated_at?: string
          user_id?: string
          vibration_enabled_override?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "device_registrations_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      direct_conversation_pairs: {
        Row: {
          conversation_id: string
          created_at: string
          member_high_user_id: string
          member_low_user_id: string
          organization_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          member_high_user_id: string
          member_low_user_id: string
          organization_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          member_high_user_id?: string
          member_low_user_id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "direct_conversation_pairs_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: true
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "direct_conversation_pairs_organization_id_member_high_user_fkey"
            columns: ["organization_id", "member_high_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "direct_conversation_pairs_organization_id_member_low_user__fkey"
            columns: ["organization_id", "member_low_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      dynamic_group_policies: {
        Row: {
          approved_at: string | null
          approved_by_user_id: string | null
          conversation_id: string
          created_at: string
          created_by_user_id: string
          draft_state: string
          id: string
          include_unit_descendants: boolean
          last_preview_fingerprint: string | null
          last_previewed_at: string | null
          last_synced_at: string | null
          maximum_members: number
          member_roles: string[]
          next_evaluation_at: string | null
          organization_id: string
          policy_spec: Json
          published_version_id: string | null
          selector_fingerprint: string
          source_changed_at: string | null
          status: string
          unit_id: string | null
          updated_at: string
          version: number
        }
        Insert: {
          approved_at?: string | null
          approved_by_user_id?: string | null
          conversation_id: string
          created_at?: string
          created_by_user_id: string
          draft_state?: string
          id?: string
          include_unit_descendants?: boolean
          last_preview_fingerprint?: string | null
          last_previewed_at?: string | null
          last_synced_at?: string | null
          maximum_members?: number
          member_roles?: string[]
          next_evaluation_at?: string | null
          organization_id: string
          policy_spec?: Json
          published_version_id?: string | null
          selector_fingerprint?: string
          source_changed_at?: string | null
          status?: string
          unit_id?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          approved_at?: string | null
          approved_by_user_id?: string | null
          conversation_id?: string
          created_at?: string
          created_by_user_id?: string
          draft_state?: string
          id?: string
          include_unit_descendants?: boolean
          last_preview_fingerprint?: string | null
          last_previewed_at?: string | null
          last_synced_at?: string | null
          maximum_members?: number
          member_roles?: string[]
          next_evaluation_at?: string | null
          organization_id?: string
          policy_spec?: Json
          published_version_id?: string | null
          selector_fingerprint?: string
          source_changed_at?: string | null
          status?: string
          unit_id?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "dynamic_group_policies_organization_id_approved_by_user_id_fkey"
            columns: ["organization_id", "approved_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "dynamic_group_policies_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: true
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "dynamic_group_policies_organization_id_created_by_user_id_fkey"
            columns: ["organization_id", "created_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "dynamic_group_policies_organization_id_unit_id_fkey"
            columns: ["organization_id", "unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "dynamic_group_policies_published_version_fkey"
            columns: ["organization_id", "published_version_id"]
            isOneToOne: false
            referencedRelation: "dynamic_group_policy_versions"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      dynamic_group_policy_versions: {
        Row: {
          added_count: number
          conversation_id: string
          eligible_count: number
          evaluated_at: string
          id: string
          membership_state_fingerprint: string
          next_boundary_at: string | null
          organization_id: string
          policy_id: string
          policy_spec: Json
          policy_version: number
          published_at: string
          published_by_user_id: string
          removed_count: number
          selector_fingerprint: string
          unchanged_count: number
        }
        Insert: {
          added_count: number
          conversation_id: string
          eligible_count: number
          evaluated_at: string
          id?: string
          membership_state_fingerprint: string
          next_boundary_at?: string | null
          organization_id: string
          policy_id: string
          policy_spec: Json
          policy_version: number
          published_at?: string
          published_by_user_id: string
          removed_count: number
          selector_fingerprint: string
          unchanged_count: number
        }
        Update: {
          added_count?: number
          conversation_id?: string
          eligible_count?: number
          evaluated_at?: string
          id?: string
          membership_state_fingerprint?: string
          next_boundary_at?: string | null
          organization_id?: string
          policy_id?: string
          policy_spec?: Json
          policy_version?: number
          published_at?: string
          published_by_user_id?: string
          removed_count?: number
          selector_fingerprint?: string
          unchanged_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "dynamic_group_policy_versions_organization_id_conversation_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "dynamic_group_policy_versions_organization_id_policy_id_fkey"
            columns: ["organization_id", "policy_id"]
            isOneToOne: false
            referencedRelation: "dynamic_group_policies"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "dynamic_group_policy_versions_organization_id_published_by_fkey"
            columns: ["organization_id", "published_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      glossary_reviews: {
        Row: {
          decision: string
          id: string
          note: string | null
          organization_id: string
          reviewed_at: string
          reviewer_user_id: string
          term_id: string
          term_version_id: string
        }
        Insert: {
          decision: string
          id?: string
          note?: string | null
          organization_id: string
          reviewed_at?: string
          reviewer_user_id: string
          term_id: string
          term_version_id: string
        }
        Update: {
          decision?: string
          id?: string
          note?: string | null
          organization_id?: string
          reviewed_at?: string
          reviewer_user_id?: string
          term_id?: string
          term_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "glossary_reviews_organization_id_reviewer_user_id_fkey"
            columns: ["organization_id", "reviewer_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "glossary_reviews_organization_id_term_id_term_version_id_fkey"
            columns: ["organization_id", "term_id", "term_version_id"]
            isOneToOne: false
            referencedRelation: "glossary_term_versions"
            referencedColumns: ["organization_id", "term_id", "id"]
          },
        ]
      }
      glossary_term_versions: {
        Row: {
          change_reason: string | null
          correction_of_version_id: string | null
          created_at: string
          created_by_user_id: string
          definition: string | null
          id: string
          organization_id: string
          term_id: string
          translated_term: string
          version_number: number
        }
        Insert: {
          change_reason?: string | null
          correction_of_version_id?: string | null
          created_at?: string
          created_by_user_id: string
          definition?: string | null
          id?: string
          organization_id: string
          term_id: string
          translated_term: string
          version_number: number
        }
        Update: {
          change_reason?: string | null
          correction_of_version_id?: string | null
          created_at?: string
          created_by_user_id?: string
          definition?: string | null
          id?: string
          organization_id?: string
          term_id?: string
          translated_term?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "glossary_term_versions_organization_id_created_by_user_id_fkey"
            columns: ["organization_id", "created_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "glossary_term_versions_organization_id_term_id_correction__fkey"
            columns: ["organization_id", "term_id", "correction_of_version_id"]
            isOneToOne: false
            referencedRelation: "glossary_term_versions"
            referencedColumns: ["organization_id", "term_id", "id"]
          },
          {
            foreignKeyName: "glossary_term_versions_organization_id_term_id_fkey"
            columns: ["organization_id", "term_id"]
            isOneToOne: false
            referencedRelation: "glossary_terms"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      glossary_terms: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by_user_id: string
          id: string
          organization_id: string
          source_language: string
          source_term: string
          target_language: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by_user_id: string
          id?: string
          organization_id: string
          source_language: string
          source_term: string
          target_language: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by_user_id?: string
          id?: string
          organization_id?: string
          source_language?: string
          source_term?: string
          target_language?: string
        }
        Relationships: [
          {
            foreignKeyName: "glossary_terms_organization_id_created_by_user_id_fkey"
            columns: ["organization_id", "created_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "glossary_terms_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_acknowledgements: {
        Row: {
          acknowledged_at: string
          device_id: string | null
          handoff_id: string
          handoff_version_id: string
          note: string | null
          organization_id: string
          role_snapshot: string
          scope_snapshot: Json
          session_id: string | null
          user_id: string
        }
        Insert: {
          acknowledged_at?: string
          device_id?: string | null
          handoff_id: string
          handoff_version_id: string
          note?: string | null
          organization_id: string
          role_snapshot?: string
          scope_snapshot?: Json
          session_id?: string | null
          user_id: string
        }
        Update: {
          acknowledged_at?: string
          device_id?: string | null
          handoff_id?: string
          handoff_version_id?: string
          note?: string | null
          organization_id?: string
          role_snapshot?: string
          scope_snapshot?: Json
          session_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_acknowledgements_organization_id_device_id_fkey"
            columns: ["organization_id", "device_id"]
            isOneToOne: false
            referencedRelation: "device_registrations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "handoff_acknowledgements_organization_id_handoff_id_fkey"
            columns: ["organization_id", "handoff_id"]
            isOneToOne: false
            referencedRelation: "shift_handoffs"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "handoff_acknowledgements_organization_id_handoff_id_handof_fkey"
            columns: ["organization_id", "handoff_id", "handoff_version_id"]
            isOneToOne: false
            referencedRelation: "handoff_versions"
            referencedColumns: ["organization_id", "handoff_id", "id"]
          },
          {
            foreignKeyName: "handoff_acknowledgements_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      handoff_versions: {
        Row: {
          acknowledgement_due_at: string | null
          conversation_id: string
          correction_of_version_id: string | null
          correction_reason: string | null
          created_at: string
          created_by_user_id: string
          details: string
          handoff_id: string
          id: string
          organization_id: string
          shift_ended_at: string
          shift_started_at: string
          source_fingerprint: string
          source_language: string
          source_message_ids: number[]
          title: string
          version_number: number
        }
        Insert: {
          acknowledgement_due_at?: string | null
          conversation_id: string
          correction_of_version_id?: string | null
          correction_reason?: string | null
          created_at?: string
          created_by_user_id: string
          details: string
          handoff_id: string
          id?: string
          organization_id: string
          shift_ended_at: string
          shift_started_at: string
          source_fingerprint: string
          source_language: string
          source_message_ids?: number[]
          title: string
          version_number: number
        }
        Update: {
          acknowledgement_due_at?: string | null
          conversation_id?: string
          correction_of_version_id?: string | null
          correction_reason?: string | null
          created_at?: string
          created_by_user_id?: string
          details?: string
          handoff_id?: string
          id?: string
          organization_id?: string
          shift_ended_at?: string
          shift_started_at?: string
          source_fingerprint?: string
          source_language?: string
          source_message_ids?: number[]
          title?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "handoff_versions_organization_id_conversation_id_created_b_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "created_by_user_id",
            ]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "handoff_versions_organization_id_handoff_id_correction_of__fkey"
            columns: [
              "organization_id",
              "handoff_id",
              "correction_of_version_id",
            ]
            isOneToOne: false
            referencedRelation: "handoff_versions"
            referencedColumns: ["organization_id", "handoff_id", "id"]
          },
          {
            foreignKeyName: "handoff_versions_organization_id_handoff_id_fkey"
            columns: ["organization_id", "handoff_id"]
            isOneToOne: false
            referencedRelation: "shift_handoffs"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      member_blocks: {
        Row: {
          blocked_user_id: string
          blocker_user_id: string
          created_at: string
          organization_id: string
        }
        Insert: {
          blocked_user_id: string
          blocker_user_id: string
          created_at?: string
          organization_id: string
        }
        Update: {
          blocked_user_id?: string
          blocker_user_id?: string
          created_at?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_blocks_organization_id_blocked_user_id_fkey"
            columns: ["organization_id", "blocked_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "member_blocks_organization_id_blocker_user_id_fkey"
            columns: ["organization_id", "blocker_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      message_attachments: {
        Row: {
          bucket_id: string
          byte_size: number
          conversation_id: string
          created_at: string
          created_by_user_id: string
          detected_mime_type: string | null
          file_name: string
          file_name_search: unknown
          id: string
          message_id: number
          mime_type: string
          organization_id: string
          purge_requested_at: string | null
          scan_completed_at: string | null
          scan_failure_code: string | null
          scan_policy_code: string | null
          scan_status: string
          scanner_name: string | null
          scanner_version: string | null
          sha256_hex: string | null
          storage_path: string
        }
        Insert: {
          bucket_id?: string
          byte_size: number
          conversation_id: string
          created_at?: string
          created_by_user_id: string
          detected_mime_type?: string | null
          file_name: string
          file_name_search?: unknown
          id?: string
          message_id: number
          mime_type: string
          organization_id: string
          purge_requested_at?: string | null
          scan_completed_at?: string | null
          scan_failure_code?: string | null
          scan_policy_code?: string | null
          scan_status?: string
          scanner_name?: string | null
          scanner_version?: string | null
          sha256_hex?: string | null
          storage_path: string
        }
        Update: {
          bucket_id?: string
          byte_size?: number
          conversation_id?: string
          created_at?: string
          created_by_user_id?: string
          detected_mime_type?: string | null
          file_name?: string
          file_name_search?: unknown
          id?: string
          message_id?: number
          mime_type?: string
          organization_id?: string
          purge_requested_at?: string | null
          scan_completed_at?: string | null
          scan_failure_code?: string | null
          scan_policy_code?: string | null
          scan_status?: string
          scanner_name?: string | null
          scanner_version?: string | null
          sha256_hex?: string | null
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_attachments_organization_id_conversation_id_create_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "created_by_user_id",
            ]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "message_attachments_organization_id_conversation_id_messag_fkey"
            columns: ["organization_id", "conversation_id", "message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
        ]
      }
      message_forward_provenance: {
        Row: {
          forwarded_at: string
          forwarded_by_user_id: string
          organization_id: string
          source_conversation_id: string
          source_message_id: number
          target_conversation_id: string
          target_message_id: number
        }
        Insert: {
          forwarded_at?: string
          forwarded_by_user_id: string
          organization_id: string
          source_conversation_id: string
          source_message_id: number
          target_conversation_id: string
          target_message_id: number
        }
        Update: {
          forwarded_at?: string
          forwarded_by_user_id?: string
          organization_id?: string
          source_conversation_id?: string
          source_message_id?: number
          target_conversation_id?: string
          target_message_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "message_forward_provenance_organization_id_source_conversa_fkey"
            columns: [
              "organization_id",
              "source_conversation_id",
              "source_message_id",
            ]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "message_forward_provenance_organization_id_target_convers_fkey1"
            columns: [
              "organization_id",
              "target_conversation_id",
              "forwarded_by_user_id",
            ]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "message_forward_provenance_organization_id_target_conversa_fkey"
            columns: [
              "organization_id",
              "target_conversation_id",
              "target_message_id",
            ]
            isOneToOne: true
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
        ]
      }
      message_mentions: {
        Row: {
          conversation_id: string
          created_at: string
          mentioned_user_id: string
          message_id: number
          organization_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          mentioned_user_id: string
          message_id: number
          organization_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          mentioned_user_id?: string
          message_id?: number
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_mentions_organization_id_conversation_id_mentioned_fkey"
            columns: ["organization_id", "conversation_id", "mentioned_user_id"]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "message_mentions_organization_id_conversation_id_message_i_fkey"
            columns: ["organization_id", "conversation_id", "message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
        ]
      }
      message_pins: {
        Row: {
          conversation_id: string
          message_id: number
          organization_id: string
          pinned_at: string
          pinned_by_user_id: string
        }
        Insert: {
          conversation_id: string
          message_id: number
          organization_id: string
          pinned_at?: string
          pinned_by_user_id: string
        }
        Update: {
          conversation_id?: string
          message_id?: number
          organization_id?: string
          pinned_at?: string
          pinned_by_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_pins_organization_id_conversation_id_message_id_fkey"
            columns: ["organization_id", "conversation_id", "message_id"]
            isOneToOne: true
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "message_pins_organization_id_conversation_id_pinned_by_use_fkey"
            columns: ["organization_id", "conversation_id", "pinned_by_user_id"]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
        ]
      }
      message_reactions: {
        Row: {
          conversation_id: string
          created_at: string
          emoji: string
          message_id: number
          organization_id: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          emoji: string
          message_id: number
          organization_id: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          emoji?: string
          message_id?: number
          organization_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_reactions_organization_id_conversation_id_message__fkey"
            columns: ["organization_id", "conversation_id", "message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "message_reactions_organization_id_conversation_id_user_id_fkey"
            columns: ["organization_id", "conversation_id", "user_id"]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
        ]
      }
      message_receipts: {
        Row: {
          conversation_id: string
          delivered_at: string | null
          message_id: number
          organization_id: string
          read_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          delivered_at?: string | null
          message_id: number
          organization_id: string
          read_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          delivered_at?: string | null
          message_id?: number
          organization_id?: string
          read_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_receipts_organization_id_conversation_id_message_i_fkey"
            columns: ["organization_id", "conversation_id", "message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "message_receipts_organization_id_conversation_id_user_id_fkey"
            columns: ["organization_id", "conversation_id", "user_id"]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
        ]
      }
      message_translations: {
        Row: {
          confidence: number | null
          conversation_id: string
          created_at: string
          failure_code: string | null
          id: number
          message_id: number
          model: string | null
          organization_id: string
          provider: string | null
          reviewed_at: string | null
          reviewed_by_user_id: string | null
          source_body_sha256: string
          source_language: string
          status: string
          target_language: string
          translated_body: string | null
          translated_body_search: unknown
          updated_at: string
        }
        Insert: {
          confidence?: number | null
          conversation_id: string
          created_at?: string
          failure_code?: string | null
          id?: never
          message_id: number
          model?: string | null
          organization_id: string
          provider?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          source_body_sha256: string
          source_language: string
          status?: string
          target_language: string
          translated_body?: string | null
          translated_body_search?: unknown
          updated_at?: string
        }
        Update: {
          confidence?: number | null
          conversation_id?: string
          created_at?: string
          failure_code?: string | null
          id?: never
          message_id?: number
          model?: string | null
          organization_id?: string
          provider?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          source_body_sha256?: string
          source_language?: string
          status?: string
          target_language?: string
          translated_body?: string | null
          translated_body_search?: unknown
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_translations_organization_id_conversation_id_messa_fkey"
            columns: ["organization_id", "conversation_id", "message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "message_translations_organization_id_reviewed_by_user_id_fkey"
            columns: ["organization_id", "reviewed_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      message_user_visibility: {
        Row: {
          conversation_id: string
          hidden_at: string
          message_id: number
          organization_id: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          hidden_at?: string
          message_id: number
          organization_id: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          hidden_at?: string
          message_id?: number
          organization_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_user_visibility_organization_id_conversation_id_me_fkey"
            columns: ["organization_id", "conversation_id", "message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "message_user_visibility_organization_id_conversation_id_us_fkey"
            columns: ["organization_id", "conversation_id", "user_id"]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
        ]
      }
      messages: {
        Row: {
          available_at: string
          body: string | null
          body_search: unknown
          client_nonce: string
          conversation_id: string
          created_at: string
          deleted_at: string | null
          deleted_by_user_id: string | null
          deletion_reason: string | null
          detected_language: string | null
          edited_at: string | null
          id: number
          kind: string
          language_code: string | null
          language_detected_at: string | null
          language_detection_confidence: number | null
          language_detection_method: string | null
          language_detection_state: string
          metadata: Json
          organization_id: string
          reply_to_message_id: number | null
          sender_user_id: string
          thread_root_message_id: number | null
        }
        Insert: {
          available_at?: string
          body?: string | null
          body_search?: unknown
          client_nonce?: string
          conversation_id: string
          created_at?: string
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          deletion_reason?: string | null
          detected_language?: string | null
          edited_at?: string | null
          id?: never
          kind?: string
          language_code?: string | null
          language_detected_at?: string | null
          language_detection_confidence?: number | null
          language_detection_method?: string | null
          language_detection_state?: string
          metadata?: Json
          organization_id: string
          reply_to_message_id?: number | null
          sender_user_id: string
          thread_root_message_id?: number | null
        }
        Update: {
          available_at?: string
          body?: string | null
          body_search?: unknown
          client_nonce?: string
          conversation_id?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          deletion_reason?: string | null
          detected_language?: string | null
          edited_at?: string | null
          id?: never
          kind?: string
          language_code?: string | null
          language_detected_at?: string | null
          language_detection_confidence?: number | null
          language_detection_method?: string | null
          language_detection_state?: string
          metadata?: Json
          organization_id?: string
          reply_to_message_id?: number | null
          sender_user_id?: string
          thread_root_message_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "messages_organization_id_conversation_id_reply_to_message__fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "reply_to_message_id",
            ]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "messages_organization_id_conversation_id_sender_user_id_fkey"
            columns: ["organization_id", "conversation_id", "sender_user_id"]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "messages_organization_id_conversation_id_thread_root_messa_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "thread_root_message_id",
            ]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "messages_organization_id_deleted_by_user_id_fkey"
            columns: ["organization_id", "deleted_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      operational_action_events: {
        Row: {
          action_id: string
          actor_user_id: string
          event_type: string
          from_status: string | null
          id: number
          note: string | null
          occurred_at: string
          organization_id: string
          to_status: string
        }
        Insert: {
          action_id: string
          actor_user_id: string
          event_type: string
          from_status?: string | null
          id?: never
          note?: string | null
          occurred_at?: string
          organization_id: string
          to_status: string
        }
        Update: {
          action_id?: string
          actor_user_id?: string
          event_type?: string
          from_status?: string | null
          id?: never
          note?: string | null
          occurred_at?: string
          organization_id?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "operational_action_events_organization_id_action_id_fkey"
            columns: ["organization_id", "action_id"]
            isOneToOne: false
            referencedRelation: "operational_actions"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "operational_action_events_organization_id_actor_user_id_fkey"
            columns: ["organization_id", "actor_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      operational_actions: {
        Row: {
          assignee_user_id: string | null
          completed_at: string | null
          confirmed_at: string | null
          confirmed_by_user_id: string | null
          conversation_id: string
          created_at: string
          details: string | null
          due_at: string | null
          id: string
          organization_id: string
          proposed_by_user_id: string
          source_message_id: number | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          assignee_user_id?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          confirmed_by_user_id?: string | null
          conversation_id: string
          created_at?: string
          details?: string | null
          due_at?: string | null
          id?: string
          organization_id: string
          proposed_by_user_id: string
          source_message_id?: number | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          assignee_user_id?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          confirmed_by_user_id?: string | null
          conversation_id?: string
          created_at?: string
          details?: string | null
          due_at?: string | null
          id?: string
          organization_id?: string
          proposed_by_user_id?: string
          source_message_id?: number | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operational_actions_organization_id_assignee_user_id_fkey"
            columns: ["organization_id", "assignee_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "operational_actions_organization_id_confirmed_by_user_id_fkey"
            columns: ["organization_id", "confirmed_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "operational_actions_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "operational_actions_organization_id_conversation_id_propos_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "proposed_by_user_id",
            ]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "operational_actions_organization_id_conversation_id_source_fkey"
            columns: ["organization_id", "conversation_id", "source_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
        ]
      }
      organization_ai_policies: {
        Row: {
          approved_at: string | null
          approved_by_user_id: string | null
          approved_use_cases: string[]
          enabled: boolean
          organization_id: string
          policy_version: number
          provider_allowlist: string[]
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by_user_id: string | null
          route_policy: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by_user_id?: string | null
          approved_use_cases?: string[]
          enabled?: boolean
          organization_id: string
          policy_version?: number
          provider_allowlist?: string[]
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_user_id?: string | null
          route_policy?: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by_user_id?: string | null
          approved_use_cases?: string[]
          enabled?: boolean
          organization_id?: string
          policy_version?: number
          provider_allowlist?: string[]
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_user_id?: string | null
          route_policy?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_ai_policies_organization_id_approved_by_user__fkey"
            columns: ["organization_id", "approved_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_ai_policies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_ai_policies_organization_id_revoked_by_user_i_fkey"
            columns: ["organization_id", "revoked_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      organization_ai_policy_versions: {
        Row: {
          approved_use_cases: string[]
          change_reason: string
          changed_at: string
          changed_by_user_id: string
          enabled: boolean
          organization_id: string
          policy_version: number
          provenance: Json
          provider_allowlist: string[]
          request_sha256: string
          route_policy: string
        }
        Insert: {
          approved_use_cases?: string[]
          change_reason: string
          changed_at?: string
          changed_by_user_id: string
          enabled: boolean
          organization_id: string
          policy_version: number
          provenance?: Json
          provider_allowlist?: string[]
          request_sha256: string
          route_policy: string
        }
        Update: {
          approved_use_cases?: string[]
          change_reason?: string
          changed_at?: string
          changed_by_user_id?: string
          enabled?: boolean
          organization_id?: string
          policy_version?: number
          provenance?: Json
          provider_allowlist?: string[]
          request_sha256?: string
          route_policy?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_ai_policy_versio_organization_id_changed_by_u_fkey"
            columns: ["organization_id", "changed_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_ai_policy_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invites: {
        Row: {
          accepted_at: string | null
          accepted_by_user_id: string | null
          activation_mode: string
          created_at: string
          created_by_user_id: string
          destination: string
          destination_type: string
          email: string | null
          employee_code_hash: string | null
          expires_at: string
          guest_sponsor_user_id: string | null
          id: string
          invited_user_id: string | null
          max_uses: number
          membership_access_expires_at: string | null
          membership_type: string
          organization_id: string
          revoked_at: string | null
          role: string
          token_hash: string
          updated_at: string
          use_count: number
        }
        Insert: {
          accepted_at?: string | null
          accepted_by_user_id?: string | null
          activation_mode?: string
          created_at?: string
          created_by_user_id: string
          destination: string
          destination_type: string
          email?: string | null
          employee_code_hash?: string | null
          expires_at: string
          guest_sponsor_user_id?: string | null
          id?: string
          invited_user_id?: string | null
          max_uses?: number
          membership_access_expires_at?: string | null
          membership_type?: string
          organization_id: string
          revoked_at?: string | null
          role?: string
          token_hash: string
          updated_at?: string
          use_count?: number
        }
        Update: {
          accepted_at?: string | null
          accepted_by_user_id?: string | null
          activation_mode?: string
          created_at?: string
          created_by_user_id?: string
          destination?: string
          destination_type?: string
          email?: string | null
          employee_code_hash?: string | null
          expires_at?: string
          guest_sponsor_user_id?: string | null
          id?: string
          invited_user_id?: string | null
          max_uses?: number
          membership_access_expires_at?: string | null
          membership_type?: string
          organization_id?: string
          revoked_at?: string | null
          role?: string
          token_hash?: string
          updated_at?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "organization_invites_guest_sponsor_fkey"
            columns: ["organization_id", "guest_sponsor_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_invites_organization_id_accepted_by_user_id_fkey"
            columns: ["organization_id", "accepted_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_invites_organization_id_created_by_user_id_fkey"
            columns: ["organization_id", "created_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_invites_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_memberships: {
        Row: {
          access_expires_at: string | null
          deactivated_at: string | null
          directory_visibility: string
          employee_code: string | null
          guest_sponsor_user_id: string | null
          invited_by_user_id: string | null
          job_title: string | null
          joined_at: string
          membership_type: string
          organization_id: string
          revocation_generation: number
          role: string
          security_changed_at: string | null
          security_changed_by_user_id: string | null
          status: string
          status_change_reason: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_expires_at?: string | null
          deactivated_at?: string | null
          directory_visibility?: string
          employee_code?: string | null
          guest_sponsor_user_id?: string | null
          invited_by_user_id?: string | null
          job_title?: string | null
          joined_at?: string
          membership_type?: string
          organization_id: string
          revocation_generation?: number
          role?: string
          security_changed_at?: string | null
          security_changed_by_user_id?: string | null
          status?: string
          status_change_reason?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_expires_at?: string | null
          deactivated_at?: string | null
          directory_visibility?: string
          employee_code?: string | null
          guest_sponsor_user_id?: string | null
          invited_by_user_id?: string | null
          job_title?: string | null
          joined_at?: string
          membership_type?: string
          organization_id?: string
          revocation_generation?: number
          role?: string
          security_changed_at?: string | null
          security_changed_by_user_id?: string | null
          status?: string
          status_change_reason?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_memberships_guest_sponsor_fkey"
            columns: ["organization_id", "guest_sponsor_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_organization_id_invited_by_user_i_fkey"
            columns: ["organization_id", "invited_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_memberships_organization_id_security_changed__fkey"
            columns: ["organization_id", "security_changed_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      organization_role_assignments: {
        Row: {
          expires_at: string | null
          grant_reason: string
          granted_at: string
          granted_by_user_id: string
          id: string
          organization_id: string
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by_user_id: string | null
          role_name: string
          scope_type: string
          unit_id: string | null
          user_id: string
        }
        Insert: {
          expires_at?: string | null
          grant_reason: string
          granted_at?: string
          granted_by_user_id: string
          id?: string
          organization_id: string
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_user_id?: string | null
          role_name: string
          scope_type?: string
          unit_id?: string | null
          user_id: string
        }
        Update: {
          expires_at?: string | null
          grant_reason?: string
          granted_at?: string
          granted_by_user_id?: string
          id?: string
          organization_id?: string
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_user_id?: string | null
          role_name?: string
          scope_type?: string
          unit_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_role_assignments_organization_id_granted_by_u_fkey"
            columns: ["organization_id", "granted_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_role_assignments_organization_id_revoked_by_u_fkey"
            columns: ["organization_id", "revoked_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_role_assignments_organization_id_unit_id_fkey"
            columns: ["organization_id", "unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "organization_role_assignments_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_role_assignments_role_name_fkey"
            columns: ["role_name"]
            isOneToOne: false
            referencedRelation: "organization_roles"
            referencedColumns: ["role_name"]
          },
        ]
      }
      organization_role_permissions: {
        Row: {
          permission: string
          role_name: string
        }
        Insert: {
          permission: string
          role_name: string
        }
        Update: {
          permission?: string
          role_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_role_permissions_role_name_fkey"
            columns: ["role_name"]
            isOneToOne: false
            referencedRelation: "organization_roles"
            referencedColumns: ["role_name"]
          },
        ]
      }
      organization_roles: {
        Row: {
          description: string
          role_name: string
          sensitive: boolean
        }
        Insert: {
          description: string
          role_name: string
          sensitive?: boolean
        }
        Update: {
          description?: string
          role_name?: string
          sensitive?: boolean
        }
        Relationships: []
      }
      organization_unit_members: {
        Row: {
          added_at: string
          is_lead: boolean
          organization_id: string
          unit_id: string
          user_id: string
        }
        Insert: {
          added_at?: string
          is_lead?: boolean
          organization_id: string
          unit_id: string
          user_id: string
        }
        Update: {
          added_at?: string
          is_lead?: boolean
          organization_id?: string
          unit_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_unit_members_organization_id_unit_id_fkey"
            columns: ["organization_id", "unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "organization_unit_members_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      organization_units: {
        Row: {
          created_at: string
          created_by_user_id: string
          id: string
          is_active: boolean
          kind: string
          name: string
          organization_id: string
          parent_unit_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_user_id: string
          id?: string
          is_active?: boolean
          kind: string
          name: string
          organization_id: string
          parent_unit_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string
          id?: string
          is_active?: boolean
          kind?: string
          name?: string
          organization_id?: string
          parent_unit_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_units_created_by_membership_fkey"
            columns: ["organization_id", "created_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "organization_units_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_units_organization_id_parent_unit_id_fkey"
            columns: ["organization_id", "parent_unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      organization_user_preferences: {
        Row: {
          message_language: string | null
          notification_preview: string
          organization_id: string
          quiet_days: number[]
          quiet_hours_end: string | null
          quiet_hours_start: string | null
          read_visibility: string
          shift_aware_suppression: boolean
          sound_enabled: boolean
          time_zone: string
          ui_language: string
          updated_at: string
          user_id: string
          vibration_enabled: boolean
        }
        Insert: {
          message_language?: string | null
          notification_preview?: string
          organization_id: string
          quiet_days?: number[]
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          read_visibility?: string
          shift_aware_suppression?: boolean
          sound_enabled?: boolean
          time_zone?: string
          ui_language?: string
          updated_at?: string
          user_id: string
          vibration_enabled?: boolean
        }
        Update: {
          message_language?: string | null
          notification_preview?: string
          organization_id?: string
          quiet_days?: number[]
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          read_visibility?: string
          shift_aware_suppression?: boolean
          sound_enabled?: boolean
          time_zone?: string
          ui_language?: string
          updated_at?: string
          user_id?: string
          vibration_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "organization_user_preferences_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: true
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      organizations: {
        Row: {
          allow_external_guests: boolean
          allow_member_direct_messages: boolean
          conversation_controls_version: number
          created_at: string
          created_by_user_id: string
          default_group_join_policy: string
          default_group_member_limit: number
          default_language: string
          dm_policy: string
          external_guest_max_access_days: number
          group_creation_policy: string
          id: string
          join_request_expiry_days: number
          max_pending_join_requests_per_user: number
          message_retention_days: number
          name: string
          organization_policy_version: number
          require_mfa_for_admins: boolean
          shift_schedule_authoritative: boolean
          slug: string
          updated_at: string
        }
        Insert: {
          allow_external_guests?: boolean
          allow_member_direct_messages?: boolean
          conversation_controls_version?: number
          created_at?: string
          created_by_user_id: string
          default_group_join_policy?: string
          default_group_member_limit?: number
          default_language?: string
          dm_policy?: string
          external_guest_max_access_days?: number
          group_creation_policy?: string
          id?: string
          join_request_expiry_days?: number
          max_pending_join_requests_per_user?: number
          message_retention_days?: number
          name: string
          organization_policy_version?: number
          require_mfa_for_admins?: boolean
          shift_schedule_authoritative?: boolean
          slug: string
          updated_at?: string
        }
        Update: {
          allow_external_guests?: boolean
          allow_member_direct_messages?: boolean
          conversation_controls_version?: number
          created_at?: string
          created_by_user_id?: string
          default_group_join_policy?: string
          default_group_member_limit?: number
          default_language?: string
          dm_policy?: string
          external_guest_max_access_days?: number
          group_creation_policy?: string
          id?: string
          join_request_expiry_days?: number
          max_pending_join_requests_per_user?: number
          message_retention_days?: number
          name?: string
          organization_policy_version?: number
          require_mfa_for_admins?: boolean
          shift_schedule_authoritative?: boolean
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_path: string | null
          created_at: string
          display_name: string
          preferred_language: string
          status_message: string | null
          time_zone: string
          updated_at: string
          user_id: string
          username: string | null
        }
        Insert: {
          avatar_path?: string | null
          created_at?: string
          display_name: string
          preferred_language?: string
          status_message?: string | null
          time_zone?: string
          updated_at?: string
          user_id: string
          username?: string | null
        }
        Update: {
          avatar_path?: string | null
          created_at?: string
          display_name?: string
          preferred_language?: string
          status_message?: string | null
          time_zone?: string
          updated_at?: string
          user_id?: string
          username?: string | null
        }
        Relationships: []
      }
      saved_contacts: {
        Row: {
          alias: string | null
          contact_user_id: string
          created_at: string
          is_favorite: boolean
          organization_id: string
          owner_user_id: string
          updated_at: string
        }
        Insert: {
          alias?: string | null
          contact_user_id: string
          created_at?: string
          is_favorite?: boolean
          organization_id: string
          owner_user_id: string
          updated_at?: string
        }
        Update: {
          alias?: string | null
          contact_user_id?: string
          created_at?: string
          is_favorite?: boolean
          organization_id?: string
          owner_user_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_contacts_organization_id_contact_user_id_fkey"
            columns: ["organization_id", "contact_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "saved_contacts_organization_id_owner_user_id_fkey"
            columns: ["organization_id", "owner_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      shift_assignments: {
        Row: {
          created_at: string
          created_by_user_id: string
          ends_at: string
          id: string
          organization_id: string
          starts_at: string
          status: string
          unit_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by_user_id: string
          ends_at: string
          id?: string
          organization_id: string
          starts_at: string
          status?: string
          unit_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string
          ends_at?: string
          id?: string
          organization_id?: string
          starts_at?: string
          status?: string
          unit_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_assignments_organization_id_created_by_user_id_fkey"
            columns: ["organization_id", "created_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "shift_assignments_organization_id_unit_id_fkey"
            columns: ["organization_id", "unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "shift_assignments_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      shift_handoffs: {
        Row: {
          acknowledgement_due_at: string | null
          author_user_id: string
          conversation_id: string
          created_at: string
          details: string
          escalated_at: string | null
          id: string
          last_reminded_at: string | null
          organization_id: string
          reminder_count: number
          shift_ended_at: string
          shift_started_at: string
          signed_device_id: string | null
          signed_role_snapshot: string | null
          signed_scope_snapshot: Json | null
          signed_session_id: string | null
          source_fingerprint: string
          source_language: string
          source_message_ids: number[]
          status: string
          submitted_at: string | null
          submitted_version_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          acknowledgement_due_at?: string | null
          author_user_id: string
          conversation_id: string
          created_at?: string
          details: string
          escalated_at?: string | null
          id?: string
          last_reminded_at?: string | null
          organization_id: string
          reminder_count?: number
          shift_ended_at: string
          shift_started_at: string
          signed_device_id?: string | null
          signed_role_snapshot?: string | null
          signed_scope_snapshot?: Json | null
          signed_session_id?: string | null
          source_fingerprint?: string
          source_language: string
          source_message_ids?: number[]
          status?: string
          submitted_at?: string | null
          submitted_version_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          acknowledgement_due_at?: string | null
          author_user_id?: string
          conversation_id?: string
          created_at?: string
          details?: string
          escalated_at?: string | null
          id?: string
          last_reminded_at?: string | null
          organization_id?: string
          reminder_count?: number
          shift_ended_at?: string
          shift_started_at?: string
          signed_device_id?: string | null
          signed_role_snapshot?: string | null
          signed_scope_snapshot?: Json | null
          signed_session_id?: string | null
          source_fingerprint?: string
          source_language?: string
          source_message_ids?: number[]
          status?: string
          submitted_at?: string | null
          submitted_version_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_handoffs_organization_id_conversation_id_author_user_fkey"
            columns: ["organization_id", "conversation_id", "author_user_id"]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "shift_handoffs_organization_id_id_submitted_version_id_fkey"
            columns: ["organization_id", "id", "submitted_version_id"]
            isOneToOne: false
            referencedRelation: "handoff_versions"
            referencedColumns: ["organization_id", "handoff_id", "id"]
          },
          {
            foreignKeyName: "shift_handoffs_organization_id_signed_device_id_fkey"
            columns: ["organization_id", "signed_device_id"]
            isOneToOne: false
            referencedRelation: "device_registrations"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      translation_corrections: {
        Row: {
          conversation_id: string
          corrected_body: string
          created_at: string
          id: string
          message_id: number
          organization_id: string
          proposed_by_user_id: string
          rationale: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by_user_id: string | null
          status: string
          target_language: string
          updated_at: string
        }
        Insert: {
          conversation_id: string
          corrected_body: string
          created_at?: string
          id?: string
          message_id: number
          organization_id: string
          proposed_by_user_id: string
          rationale?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          status?: string
          target_language: string
          updated_at?: string
        }
        Update: {
          conversation_id?: string
          corrected_body?: string
          created_at?: string
          id?: string
          message_id?: number
          organization_id?: string
          proposed_by_user_id?: string
          rationale?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          status?: string
          target_language?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "translation_corrections_organization_id_conversation_id_me_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "message_id",
              "target_language",
            ]
            isOneToOne: false
            referencedRelation: "message_translations"
            referencedColumns: [
              "organization_id",
              "conversation_id",
              "message_id",
              "target_language",
            ]
          },
          {
            foreignKeyName: "translation_corrections_organization_id_conversation_id_pr_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "proposed_by_user_id",
            ]
            isOneToOne: false
            referencedRelation: "conversation_members"
            referencedColumns: ["organization_id", "conversation_id", "user_id"]
          },
          {
            foreignKeyName: "translation_corrections_organization_id_reviewed_by_user_i_fkey"
            columns: ["organization_id", "reviewed_by_user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bff_acknowledge_announcement:
        | {
            Args: {
              p_actor_user_id: string
              p_announcement_version_id: string
              p_attestation: Json
              p_device_id: string
              p_idempotency_key: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_actor_user_id: string
              p_announcement_version_id: string
              p_idempotency_key: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
            }
            Returns: Json
          }
      bff_acknowledge_handoff:
        | {
            Args: {
              p_actor_user_id: string
              p_device_id: string
              p_handoff_version_id: string
              p_idempotency_key: string
              p_note: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_actor_user_id: string
              p_handoff_version_id: string
              p_idempotency_key: string
              p_note: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
            }
            Returns: Json
          }
      bff_activate_conversation_avatar: {
        Args: {
          p_actor_user_id: string
          p_attachment_id: string
          p_conversation_id: string
          p_expected_avatar_path: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_add_conversation_member: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_role: string
          p_session_id: string
          p_target_user_id: string
        }
        Returns: Json
      }
      bff_approve_account_recovery_case: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_assign_moderation_case: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_expected_version: number
          p_idempotency_key: string
          p_investigator_user_id: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_authorize_account_recovery_otp: {
        Args: {
          p_destination: string
          p_destination_type: string
          p_installation_hash: string
          p_ip_hash: string
          p_purpose?: string
        }
        Returns: Json
      }
      bff_authorize_attachment_download: {
        Args: {
          p_actor_user_id: string
          p_attachment_id: string
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_authorize_conversation_avatar_download: {
        Args: {
          p_actor_user_id: string
          p_attachment_id: string
          p_conversation_id: string
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_authorize_invite_otp: {
        Args: {
          p_destination: string
          p_destination_type: string
          p_employee_code: string
          p_installation_hash: string
          p_invite_token: string
          p_ip_hash: string
          p_purpose?: string
        }
        Returns: Json
      }
      bff_authorize_member_otp: {
        Args: {
          p_destination: string
          p_destination_type: string
          p_installation_hash: string
          p_ip_hash: string
          p_purpose?: string
        }
        Returns: Json
      }
      bff_authorize_request: {
        Args: {
          p_actor_user_id: string
          p_operation: string
          p_organization_id: string
          p_recent_auth_seconds: number
          p_require_aal2: boolean
          p_session_id: string
        }
        Returns: Json
      }
      bff_authorize_signup_otp: {
        Args: {
          p_destination: string
          p_destination_type: string
          p_display_name: string
          p_installation_hash: string
          p_ip_hash: string
          p_language: string
          p_purpose?: string
          p_username: string
        }
        Returns: Json
      }
      bff_begin_idempotency: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_route: string
        }
        Returns: Json
      }
      bff_bind_session_installation: {
        Args: {
          p_actor_user_id: string
          p_app_version: string
          p_installation_id: string
          p_locale: string
          p_platform: string
          p_session_id: string
          p_user_agent_family: string
          p_user_agent_hash: string
        }
        Returns: Json
      }
      bff_bootstrap_messaging_state: {
        Args: {
          p_actor_user_id: string
          p_before_message_id?: number
          p_conversation_limit?: number
          p_organization_id: string
          p_selected_conversation_id?: string
          p_session_id: string
          p_timeline_limit?: number
        }
        Returns: Json
      }
      bff_bootstrap_organization: {
        Args: {
          p_idempotency_key: string
          p_name: string
          p_owner_user_id: string
          p_request_sha256: string
          p_slug: string
        }
        Returns: Json
      }
      bff_cancel_account_recovery_execution: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_execution_version: string
          p_failure_code: string
        }
        Returns: Json
      }
      bff_cancel_conversation_join_request: {
        Args: {
          p_actor_user_id: string
          p_expected_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_request_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_cancel_scheduled_announcement: {
        Args: {
          p_actor_user_id: string
          p_announcement_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_claim_ai_regression_examples: {
        Args: { p_limit?: number; p_worker_hash: string }
        Returns: Json
      }
      bff_claim_attachment_scan_jobs: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: Json
      }
      bff_claim_language_detection_jobs: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: Json
      }
      bff_claim_moderation_case: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_expected_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_claim_outbox_jobs: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: Json
      }
      bff_claim_outbox_topics: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_topics: string[]
          p_worker_id: string
        }
        Returns: Json
      }
      bff_claim_push_receipts: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: Json
      }
      bff_claim_summary_jobs: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: Json
      }
      bff_claim_translation_jobs: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: Json
      }
      bff_close_incident: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_complete_account_recovery: {
        Args: { p_actor_user_id: string; p_current_session_id: string }
        Returns: Json
      }
      bff_complete_attachment_scan: {
        Args: {
          p_attachment_id: string
          p_detected_mime_type: string
          p_job_id: number
          p_policy_code: string
          p_scan_result: string
          p_scanner_name: string
          p_scanner_version: string
          p_worker_id: string
        }
        Returns: Json
      }
      bff_complete_idempotency: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_response: Json
          p_route: string
          p_status: number
        }
        Returns: undefined
      }
      bff_complete_language_detection_job: {
        Args: {
          p_confidence: number
          p_detected_language: string
          p_detection_state: string
          p_job_id: number
          p_method: string
          p_source_sha256: string
          p_worker_id: string
        }
        Returns: Json
      }
      bff_complete_outbox_job: {
        Args: { p_job_id: number; p_worker_id: string }
        Returns: undefined
      }
      bff_complete_push_dispatch_job: {
        Args: { p_job_id: number; p_worker_id: string }
        Returns: Json
      }
      bff_complete_summary_job: {
        Args: {
          p_action_items: Json
          p_ambiguities: string[]
          p_decisions: Json
          p_job_id: number
          p_key_topics: string[]
          p_model: string
          p_primary_topic: string
          p_provenance: Json
          p_provider: string
          p_source_fingerprint: string
          p_summary_body: string
          p_worker_id: string
        }
        Returns: Json
      }
      bff_complete_translation_job: {
        Args: {
          p_confidence: number
          p_job_id: number
          p_model: string
          p_provider: string
          p_source_sha256: string
          p_translated_body: string
          p_worker_id: string
        }
        Returns: undefined
      }
      bff_confirm_operational_action: {
        Args: {
          p_action_id: string
          p_actor_user_id: string
          p_assignee_user_id: string
          p_due_at: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_consume_rate_limit: {
        Args: {
          p_actor_user_id: string
          p_ip_hash: string
          p_operation: string
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_correct_announcement: {
        Args: {
          p_actor_user_id: string
          p_announcement_id: string
          p_body: string
          p_client_nonce: string
          p_expires_at: string
          p_idempotency_key: string
          p_organization_id: string
          p_priority: string
          p_reason: string
          p_request_sha256: string
          p_requires_acknowledgement: boolean
          p_session_id: string
          p_title: string
        }
        Returns: Json
      }
      bff_correct_handoff: {
        Args: {
          p_acknowledgement_due_at: string
          p_actor_user_id: string
          p_details: string
          p_handoff_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
          p_shift_ended_at: string
          p_shift_started_at: string
          p_source_language: string
          p_source_message_ids: number[]
          p_title: string
        }
        Returns: Json
      }
      bff_correct_handoff_v2: {
        Args: {
          p_acknowledgement_due_at: string
          p_actor_user_id: string
          p_details: string
          p_expected_version_id: string
          p_expected_version_number: number
          p_handoff_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
          p_shift_ended_at: string
          p_shift_started_at: string
          p_source_language: string
          p_source_message_ids: number[]
          p_title: string
        }
        Returns: Json
      }
      bff_create_account_recovery_case: {
        Args: {
          p_actor_user_id: string
          p_factor_id: string
          p_factor_status: string
          p_factor_type: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_create_announcement:
        | {
            Args: {
              p_acknowledgement_schema: Json
              p_actor_user_id: string
              p_audience_spec: Json
              p_body: string
              p_client_nonce: string
              p_conversation_id: string
              p_critical_category: string
              p_expires_at: string
              p_idempotency_key: string
              p_language_code: string
              p_notification_class: string
              p_organization_id: string
              p_priority: string
              p_quiet_hours_override_reason: string
              p_reminder_policy: Json
              p_request_sha256: string
              p_requires_acknowledgement: boolean
              p_scheduled_at: string
              p_session_id: string
              p_title: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_acknowledgement_schema: Json
              p_actor_user_id: string
              p_body: string
              p_client_nonce: string
              p_conversation_id: string
              p_critical_category: string
              p_expires_at: string
              p_idempotency_key: string
              p_language_code: string
              p_notification_class: string
              p_organization_id: string
              p_priority: string
              p_quiet_hours_override_reason: string
              p_reminder_policy: Json
              p_request_sha256: string
              p_requires_acknowledgement: boolean
              p_scheduled_at: string
              p_session_id: string
              p_title: string
            }
            Returns: Json
          }
      bff_create_attachment_upload: {
        Args: {
          p_actor_user_id: string
          p_byte_size: number
          p_conversation_id: string
          p_file_name: string
          p_idempotency_key: string
          p_message_id: number
          p_mime_type: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_sha256_hex: string
        }
        Returns: Json
      }
      bff_create_conversation_avatar_upload: {
        Args: {
          p_actor_user_id: string
          p_byte_size: number
          p_conversation_id: string
          p_file_name: string
          p_idempotency_key: string
          p_mime_type: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_sha256_hex: string
        }
        Returns: Json
      }
      bff_create_direct_conversation: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_other_user_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_create_group_conversation:
        | {
            Args: {
              p_actor_user_id: string
              p_history_policy: string
              p_idempotency_key: string
              p_incident_classification: string
              p_incident_severity: string
              p_kind: string
              p_member_user_ids: string[]
              p_name: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
              p_unit_id: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_actor_user_id: string
              p_idempotency_key: string
              p_kind: string
              p_member_user_ids: string[]
              p_name: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
              p_unit_id: string
            }
            Returns: Json
          }
      bff_create_group_conversation_v2: {
        Args: {
          p_actor_user_id: string
          p_description: string
          p_history_policy: string
          p_idempotency_key: string
          p_incident_classification: string
          p_incident_severity: string
          p_join_policy: string
          p_kind: string
          p_member_assignments: Json
          p_name: string
          p_organization_id: string
          p_posting_mode: string
          p_request_sha256: string
          p_session_id: string
          p_unit_id: string
        }
        Returns: Json
      }
      bff_create_handoff:
        | {
            Args: {
              p_actor_user_id: string
              p_conversation_id: string
              p_details: string
              p_idempotency_key: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
              p_shift_ended_at: string
              p_shift_started_at: string
              p_source_language: string
              p_title: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_acknowledgement_due_at: string
              p_actor_user_id: string
              p_conversation_id: string
              p_details: string
              p_idempotency_key: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
              p_shift_ended_at: string
              p_shift_started_at: string
              p_source_language: string
              p_source_message_ids: number[]
              p_title: string
            }
            Returns: Json
          }
      bff_create_manual_summary: {
        Args: {
          p_action_items: Json
          p_actor_user_id: string
          p_ambiguities: string[]
          p_conversation_id: string
          p_decisions: Json
          p_idempotency_key: string
          p_key_topics: string[]
          p_language_code: string
          p_organization_id: string
          p_primary_topic: string
          p_request_sha256: string
          p_session_id: string
          p_source_message_ids: number[]
          p_summary_body: string
        }
        Returns: Json
      }
      bff_decide_ai_regression_example: {
        Args: {
          p_actor_user_id: string
          p_decision: string
          p_decision_note: string
          p_example_id: string
          p_expected_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_decide_conversation_join_request: {
        Args: {
          p_actor_user_id: string
          p_decision: string
          p_expected_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_delete_message: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_edit_message: {
        Args: {
          p_actor_user_id: string
          p_body: string
          p_conversation_id: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_enqueue_translation: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_target_language: string
        }
        Returns: Json
      }
      bff_execute_session_revoke_job: {
        Args: { p_job_id: number; p_worker_id: string }
        Returns: Json
      }
      bff_expand_moderation_fanout: {
        Args: { p_job_id: number; p_worker_id: string }
        Returns: Json
      }
      bff_export_audit_events: {
        Args: {
          p_actor_user_id: string
          p_date_from: string
          p_date_to: string
          p_event_types?: string[]
          p_export_format: string
          p_filter_actor_user_id?: string
          p_organization_id: string
          p_reason_code: string
          p_session_id: string
          p_target_id?: string
          p_target_type?: string
        }
        Returns: Json
      }
      bff_fail_attachment_scan: {
        Args: {
          p_attachment_id: string
          p_failure_code: string
          p_job_id: number
          p_scanner_name: string
          p_scanner_version: string
          p_worker_id: string
        }
        Returns: Json
      }
      bff_fail_language_detection_job: {
        Args: {
          p_error_code: string
          p_job_id: number
          p_method: string
          p_source_sha256: string
          p_worker_id: string
        }
        Returns: Json
      }
      bff_fail_outbox_job: {
        Args: {
          p_error_code: string
          p_job_id: number
          p_retry_seconds?: number
          p_worker_id: string
        }
        Returns: undefined
      }
      bff_fail_summary_job: {
        Args: { p_failure_code: string; p_job_id: number; p_worker_id: string }
        Returns: Json
      }
      bff_fail_translation_job: {
        Args: {
          p_error_code: string
          p_job_id: number
          p_provider: string
          p_source_sha256: string
          p_worker_id: string
        }
        Returns: Json
      }
      bff_finalize_account_recovery_execution: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_execution_version: string
          p_factor_id: string
          p_target_user_id: string
        }
        Returns: Json
      }
      bff_finalize_attachment_upload: {
        Args: {
          p_actor_user_id: string
          p_attachment_id: string
          p_bucket_id: string
          p_idempotency_key: string
          p_object_byte_size: number
          p_object_sha256_hex: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_storage_path: string
        }
        Returns: Json
      }
      bff_forward_message: {
        Args: {
          p_actor_user_id: string
          p_client_nonce: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_source_conversation_id: string
          p_source_message_id: number
          p_target_conversation_id: string
        }
        Returns: Json
      }
      bff_get_attachment_state: {
        Args: {
          p_actor_user_id: string
          p_attachment_id: string
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_get_device_notification_preferences: {
        Args: {
          p_actor_user_id: string
          p_installation_id: string
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_get_organization_ai_policy: {
        Args: {
          p_actor_user_id: string
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_get_organization_preferences: {
        Args: {
          p_actor_user_id: string
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_grant_role_assignment: {
        Args: {
          p_actor_user_id: string
          p_expires_at: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_role_name: string
          p_scope_type: string
          p_session_id: string
          p_target_user_id: string
          p_unit_id: string
        }
        Returns: Json
      }
      bff_hide_message_for_me: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_issue_organization_invite: {
        Args: {
          p_activation_mode: string
          p_actor_user_id: string
          p_destination: string
          p_destination_type: string
          p_employee_code: string
          p_expires_in_seconds: number
          p_idempotency_key: string
          p_invited_user_id: string
          p_organization_id: string
          p_request_sha256: string
          p_role: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_issue_organization_invite_v2: {
        Args: {
          p_activation_mode: string
          p_actor_user_id: string
          p_destination: string
          p_destination_type: string
          p_employee_code: string
          p_expires_in_seconds: number
          p_guest_sponsor_user_id: string
          p_idempotency_key: string
          p_invited_user_id: string
          p_membership_access_expires_at: string
          p_membership_type: string
          p_organization_id: string
          p_request_sha256: string
          p_role: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_leave_conversation: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_replacement_owner_user_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_account_recovery_cases: {
        Args: {
          p_actor_user_id: string
          p_include_organization?: boolean
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_admin_members: {
        Args: {
          p_actor_user_id: string
          p_after_user_id?: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_ai_output_error_reports_for_review: {
        Args: {
          p_actor_user_id: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_announcement_non_acknowledgers: {
        Args: {
          p_actor_user_id: string
          p_after_user_id?: string
          p_announcement_id: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_conversation_join_requests: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_conversation_member_candidates: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_cursor?: string
          p_limit?: number
          p_organization_id: string
          p_query?: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_discoverable_conversations: {
        Args: {
          p_actor_user_id: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_dynamic_group_policies: {
        Args: {
          p_actor_user_id: string
          p_after_policy_id?: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_group_creation_candidates: {
        Args: {
          p_actor_user_id: string
          p_limit: number
          p_organization_id: string
          p_query: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_managed_announcements: {
        Args: {
          p_actor_user_id: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_my_ai_output_error_reports: {
        Args: {
          p_actor_user_id: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_list_role_assignments: {
        Args: {
          p_actor_user_id: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
          p_target_user_id: string
        }
        Returns: Json
      }
      bff_list_sessions: {
        Args: {
          p_actor_user_id: string
          p_current_session_id: string
          p_organization_id: string
        }
        Returns: Json
      }
      bff_mark_announcement_read: {
        Args: {
          p_actor_user_id: string
          p_announcement_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_mark_message_receipt: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_state: string
        }
        Returns: Json
      }
      bff_pause_dynamic_group_policy: {
        Args: {
          p_actor_user_id: string
          p_expected_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_policy_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_place_message_preservation_hold: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_hold_type: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_policy_reference_sha256: string
          p_reason_code: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_prepare_account_recovery_execution: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_preview_announcement_audience:
        | {
            Args: {
              p_actor_user_id: string
              p_audience_spec: Json
              p_conversation_id: string
              p_limit?: number
              p_organization_id: string
              p_session_id: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_actor_user_id: string
              p_conversation_id: string
              p_limit?: number
              p_organization_id: string
              p_session_id: string
            }
            Returns: Json
          }
      bff_preview_dynamic_group: {
        Args: {
          p_actor_user_id: string
          p_limit?: number
          p_organization_id: string
          p_policy_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_preview_dynamic_group_v2: {
        Args: {
          p_actor_user_id: string
          p_expected_version: number
          p_organization_id: string
          p_policy_id: string
          p_sample_limit?: number
          p_session_id: string
        }
        Returns: Json
      }
      bff_process_announcement_obligations: {
        Args: { p_limit?: number; p_worker_id: string }
        Returns: Json
      }
      bff_process_dynamic_group_boundaries: {
        Args: { p_policy_limit?: number }
        Returns: Json
      }
      bff_process_dynamic_group_reconciliation: {
        Args: { p_policy_limit?: number; p_user_limit?: number }
        Returns: Json
      }
      bff_process_overdue_handoffs: {
        Args: { p_limit?: number; p_worker_id: string }
        Returns: Json
      }
      bff_promote_due_announcements: {
        Args: { p_limit?: number; p_worker_id: string }
        Returns: Json
      }
      bff_propose_ai_regression_example: {
        Args: {
          p_actor_user_id: string
          p_attestation_version: string
          p_deidentification_attested: boolean
          p_deidentified_expected_output: string
          p_deidentified_observed_output: string
          p_deidentified_source_text: string
          p_expected_report_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_report_id: string
          p_request_sha256: string
          p_session_id: string
          p_source_language: string
        }
        Returns: Json
      }
      bff_propose_glossary_term: {
        Args: {
          p_actor_user_id: string
          p_definition: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
          p_source_language: string
          p_source_term: string
          p_target_language: string
          p_term_id: string
          p_translated_term: string
        }
        Returns: Json
      }
      bff_propose_operational_action: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_details: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_source_message_id: number
          p_title: string
        }
        Returns: Json
      }
      bff_propose_translation_correction: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_corrected_body: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_rationale: string
          p_request_sha256: string
          p_session_id: string
          p_target_language: string
        }
        Returns: Json
      }
      bff_publish_announcement: {
        Args: {
          p_actor_user_id: string
          p_body: string
          p_client_nonce: string
          p_conversation_id: string
          p_expires_at: string
          p_idempotency_key: string
          p_language_code: string
          p_organization_id: string
          p_priority: string
          p_request_sha256: string
          p_requires_acknowledgement: boolean
          p_session_id: string
          p_title: string
        }
        Returns: Json
      }
      bff_publish_dynamic_group_policy: {
        Args: {
          p_actor_user_id: string
          p_expected_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_policy_id: string
          p_preview_fingerprint: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_query_audit_events: {
        Args: {
          p_actor_user_id: string
          p_cursor?: string
          p_date_from: string
          p_date_to: string
          p_event_types?: string[]
          p_filter_actor_user_id?: string
          p_limit?: number
          p_organization_id: string
          p_reason_code: string
          p_session_id: string
          p_target_id?: string
          p_target_type?: string
        }
        Returns: Json
      }
      bff_query_moderation_cases: {
        Args: {
          p_actor_user_id: string
          p_before_case_id?: string
          p_before_updated_at?: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
          p_statuses: string[]
        }
        Returns: Json
      }
      bff_read_ai_output_error_report: {
        Args: {
          p_actor_user_id: string
          p_organization_id: string
          p_report_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_read_conversation_page: {
        Args: {
          p_actor_user_id: string
          p_before_message_id?: number
          p_conversation_id: string
          p_limit?: number
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_read_moderation_case: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_record_account_recovery_verification: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_verification_method: string
          p_verification_reference_hash: string
        }
        Returns: Json
      }
      bff_record_audit_access_denial: {
        Args: {
          p_actor_user_id: string
          p_operation: string
          p_organization_id: string
        }
        Returns: Json
      }
      bff_record_push_receipt: {
        Args: {
          p_attempt_id: number
          p_error_code?: string
          p_result: string
          p_worker_id: string
        }
        Returns: Json
      }
      bff_record_push_submission: {
        Args: {
          p_attempt_id: number
          p_error_code?: string
          p_job_id: number
          p_provider_ticket_id?: string
          p_result: string
          p_worker_id: string
        }
        Returns: Json
      }
      bff_redeem_signup: {
        Args: {
          p_destination: string
          p_destination_type: string
          p_user_id: string
        }
        Returns: Json
      }
      bff_register_device: {
        Args: {
          p_actor_user_id: string
          p_app_version: string
          p_idempotency_key: string
          p_installation_id: string
          p_locale: string
          p_organization_id: string
          p_platform: string
          p_push_environment: string
          p_push_project_id: string
          p_push_token_ciphertext: string
          p_push_token_type: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_reject_account_recovery_case: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_release_message_preservation_hold: {
        Args: {
          p_actor_user_id: string
          p_hold_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_release_reason_code: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_remove_contact: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_other_user_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_remove_conversation_avatar: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_expected_avatar_path: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_remove_conversation_member: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_target_user_id: string
        }
        Returns: Json
      }
      bff_remove_message_reaction: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_emoji: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_remove_saved_contact: {
        Args: {
          p_actor_user_id: string
          p_contact_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_report_ai_output_error: {
        Args: {
          p_actor_user_id: string
          p_category: string
          p_consent_version: string
          p_details: string
          p_high_consequence: boolean
          p_idempotency_key: string
          p_organization_id: string
          p_output_kind: string
          p_quality_use_consent: boolean
          p_request_sha256: string
          p_session_id: string
          p_summary_id: string
          p_translation_id: number
        }
        Returns: Json
      }
      bff_report_message: {
        Args: {
          p_actor_user_id: string
          p_category: string
          p_conversation_id: string
          p_details: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_report_message_v2: {
        Args: {
          p_actor_user_id: string
          p_category: string
          p_consent_to_share: boolean
          p_context_after: number
          p_context_before: number
          p_conversation_id: string
          p_details: string
          p_idempotency_key: string
          p_message_id: number
          p_notice_version: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_report_target_v3: {
        Args: {
          p_actor_user_id: string
          p_category: string
          p_consent_to_share: boolean
          p_context_after: number
          p_context_before: number
          p_conversation_id: string
          p_details: string
          p_idempotency_key: string
          p_message_id: number
          p_notice_version: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_subject_user_id: string
          p_target_type: string
        }
        Returns: Json
      }
      bff_request_contact: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_target_user_id: string
        }
        Returns: Json
      }
      bff_request_conversation_join: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_request_conversation_summary: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_language_code: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_source_message_ids: number[]
        }
        Returns: Json
      }
      bff_resolve_invite_principal: {
        Args: {
          p_actor_user_id: string
          p_destination: string
          p_destination_type: string
          p_organization_id: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_resolve_language_detection_job_source: {
        Args: { p_job_id: number; p_provider: string; p_worker_id: string }
        Returns: Json
      }
      bff_resolve_principal_context: {
        Args: {
          p_actor_user_id: string
          p_requested_organization_id?: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_resolve_push_job: {
        Args: {
          p_after_device_id?: string
          p_job_id: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: Json
      }
      bff_resolve_realtime_fanout: {
        Args: {
          p_conversation_id: string
          p_entity_id: string
          p_entity_type: string
          p_event: string
          p_organization_id: string
          p_reason?: string
          p_version_id?: string
        }
        Returns: Json
      }
      bff_resolve_summary_job_sources: {
        Args: { p_job_id: number; p_provider: string; p_worker_id: string }
        Returns: Json
      }
      bff_resolve_translation_job_for_egress: {
        Args: { p_job_id: number; p_provider: string; p_worker_id: string }
        Returns: Json
      }
      bff_respond_contact: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_other_user_id: string
          p_request_sha256: string
          p_session_id: string
          p_status: string
        }
        Returns: Json
      }
      bff_review_ai_output_error_report: {
        Args: {
          p_actor_user_id: string
          p_expected_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_outcome: string
          p_report_id: string
          p_request_sha256: string
          p_review_note: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_review_conversation_summary: {
        Args: {
          p_actor_user_id: string
          p_decision: string
          p_idempotency_key: string
          p_note: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_summary_id: string
        }
        Returns: Json
      }
      bff_review_glossary_version: {
        Args: {
          p_actor_user_id: string
          p_decision: string
          p_idempotency_key: string
          p_note: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_term_version_id: string
        }
        Returns: Json
      }
      bff_review_translation_correction: {
        Args: {
          p_actor_user_id: string
          p_correction_id: string
          p_decision: string
          p_idempotency_key: string
          p_note: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_revoke_role_assignment: {
        Args: {
          p_actor_user_id: string
          p_assignment_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_revoke_session: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
          p_target_session_id: string
        }
        Returns: Json
      }
      bff_save_dynamic_group_policy: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_include_unit_descendants: boolean
          p_member_roles: string[]
          p_organization_id: string
          p_policy_id: string
          p_request_sha256: string
          p_session_id: string
          p_unit_id: string
        }
        Returns: Json
      }
      bff_save_dynamic_group_policy_v2: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_expected_version: number
          p_idempotency_key: string
          p_maximum_members: number
          p_organization_id: string
          p_policy_id: string
          p_policy_spec: Json
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_scrub_retention: { Args: { p_batch_size?: number }; Returns: Json }
      bff_search: {
        Args: {
          p_actor_user_id: string
          p_conversation_id?: string
          p_cursor?: string
          p_date_from?: string
          p_date_to?: string
          p_language?: string
          p_limit?: number
          p_match_sources?: string[]
          p_organization_id: string
          p_query: string
          p_sender_user_id?: string
          p_session_id: string
          p_types: string[]
        }
        Returns: Json
      }
      bff_search_users_by_username: {
        Args: {
          p_actor_user_id: string
          p_limit?: number
          p_organization_id: string
          p_query: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_send_message: {
        Args: {
          p_actor_user_id: string
          p_body: string
          p_client_nonce: string
          p_conversation_id: string
          p_idempotency_key: string
          p_kind: string
          p_language_code: string
          p_metadata: Json
          p_organization_id: string
          p_reply_to_message_id: number
          p_request_sha256: string
          p_session_id: string
          p_thread_root_message_id: number
        }
        Returns: Json
      }
      bff_send_message_request: {
        Args: {
          p_actor_user_id: string
          p_body: string
          p_organization_id: string
          p_session_id: string
          p_target_user_id: string
        }
        Returns: Json
      }
      bff_set_member_block: {
        Args: {
          p_actor_user_id: string
          p_blocked: boolean
          p_idempotency_key: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_target_user_id: string
        }
        Returns: Json
      }
      bff_set_message_pin: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_pinned: boolean
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_set_message_reaction: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_emoji: string
          p_idempotency_key: string
          p_message_id: number
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_set_organization_ai_policy: {
        Args: {
          p_actor_user_id: string
          p_approved_use_cases: string[]
          p_enabled: boolean
          p_idempotency_key: string
          p_organization_id: string
          p_provider_allowlist: string[]
          p_reason: string
          p_request_sha256: string
          p_route_policy: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_set_organization_ai_policy_v2: {
        Args: {
          p_actor_user_id: string
          p_approved_use_cases: string[]
          p_enabled: boolean
          p_expected_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_provider_allowlist: string[]
          p_reason: string
          p_request_sha256: string
          p_route_policy: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_set_summary_policy: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_message_count_threshold: number
          p_mode: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_sign_handoff:
        | {
            Args: {
              p_actor_user_id: string
              p_device_id: string
              p_handoff_version_id: string
              p_idempotency_key: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_actor_user_id: string
              p_handoff_version_id: string
              p_idempotency_key: string
              p_organization_id: string
              p_request_sha256: string
              p_session_id: string
            }
            Returns: Json
          }
      bff_suspend_member: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
          p_target_user_id: string
        }
        Returns: Json
      }
      bff_sync_dynamic_group: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_policy_id: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_transition_moderation_case: {
        Args: {
          p_actor_user_id: string
          p_case_id: string
          p_evidence_metadata: Json
          p_expected_version: number
          p_idempotency_key: string
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
          p_status: string
        }
        Returns: Json
      }
      bff_transition_operational_action: {
        Args: {
          p_action_id: string
          p_actor_user_id: string
          p_idempotency_key: string
          p_note: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_status: string
        }
        Returns: Json
      }
      bff_update_conversation: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_patch: Json
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_update_conversation_controls: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_join_policy: string
          p_organization_id: string
          p_posting_mode: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
          p_visibility: string
        }
        Returns: Json
      }
      bff_update_conversation_member_role: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_expected_role: string
          p_idempotency_key: string
          p_new_role: string
          p_organization_id: string
          p_request_sha256: string
          p_session_id: string
          p_target_user_id: string
        }
        Returns: Json
      }
      bff_update_conversation_preferences: {
        Args: {
          p_actor_user_id: string
          p_conversation_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_patch: Json
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_update_device_notification_preferences: {
        Args: {
          p_actor_user_id: string
          p_expected_version: number
          p_idempotency_key: string
          p_installation_id: string
          p_organization_id: string
          p_patch: Json
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_update_organization_conversation_controls: {
        Args: {
          p_actor_user_id: string
          p_default_group_member_limit: number
          p_default_join_policy: string
          p_idempotency_key: string
          p_join_request_expiry_days: number
          p_max_pending_join_requests_per_user: number
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_update_organization_policy: {
        Args: {
          p_actor_user_id: string
          p_allow_external_guests: boolean
          p_allow_member_direct_messages: boolean
          p_dm_policy: string
          p_expected_version: number
          p_external_guest_max_access_days: number
          p_group_creation_policy: string
          p_idempotency_key: string
          p_message_retention_days: number
          p_organization_id: string
          p_reason: string
          p_request_sha256: string
          p_require_mfa_for_admins: boolean
          p_session_id: string
          p_shift_schedule_authoritative: boolean
        }
        Returns: Json
      }
      bff_update_organization_preferences: {
        Args: {
          p_actor_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_patch: Json
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      bff_update_saved_contact: {
        Args: {
          p_actor_user_id: string
          p_contact_user_id: string
          p_idempotency_key: string
          p_organization_id: string
          p_patch: Json
          p_request_sha256: string
          p_session_id: string
        }
        Returns: Json
      }
      hook_newone_custom_access_token: { Args: { event: Json }; Returns: Json }
      redeem_organization_invite: {
        Args: { p_employee_code?: string; p_token: string }
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
  public: {
    Enums: {},
  },
} as const
