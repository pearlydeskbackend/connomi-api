// ============================================================================
// database.types.ts — the CONTRACT. Both API and dashboard import from here.
// ----------------------------------------------------------------------------
// This is a faithful, hand-written equivalent of what
//   supabase gen types typescript --project-id <id> > database.types.ts
// produces. Once your CLI is linked, REGENERATE this file from the live schema
// so it can never drift. Until then, this is accurate to connomi_schema_v2.
// ============================================================================

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      clinics: {
        Row: {
          id: string;
          name: string;
          owner_name: string | null;
          owner_email: string | null;
          owner_phone: string | null;
          address: string | null;
          city: string | null;
          province: string | null;
          timezone: string;
          agent_name: string;
          open_time: string;
          close_time: string;
          open_days: number[];
          holidays: string[];
          slot_duration_minutes: number;
          min_lead_time_minutes: number;
          google_review_link: string | null;
          vapi_assistant_id: string | null;
          twilio_phone: string | null;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          ical_url: string | null;
          ical_sync_enabled: boolean;
          ical_last_synced_at: string | null;
          plan: string;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          owner_name?: string | null;
          owner_email?: string | null;
          owner_phone?: string | null;
          timezone?: string;
          agent_name?: string;
          open_time?: string;
          close_time?: string;
          open_days?: number[];
          holidays?: string[];
          slot_duration_minutes?: number;
          min_lead_time_minutes?: number;
          plan?: string;
          active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["clinics"]["Insert"]> & {
          address?: string | null;
          city?: string | null;
          google_review_link?: string | null;
          vapi_assistant_id?: string | null;
          twilio_phone?: string | null;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          ical_url?: string | null;
          ical_sync_enabled?: boolean;
          ical_last_synced_at?: string | null;
          close_time?: string;
          holidays?: string[];
        };
        Relationships: [];
      };
      users: {
        Row: {
          id: string;
          clinic_id: string;
          email: string;
          role: Database["public"]["Enums"]["user_role"];
          created_at: string;
        };
        Insert: {
          id: string;
          clinic_id: string;
          email: string;
          role?: Database["public"]["Enums"]["user_role"];
        };
        Update: Partial<Database["public"]["Tables"]["users"]["Insert"]>;
        Relationships: [];
      };
      providers: {
        Row: {
          id: string;
          clinic_id: string;
          name: string;
          title: string;
          color: string;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          name: string;
          title?: string;
          color?: string;
          active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["providers"]["Insert"]>;
        Relationships: [];
      };
      patients: {
        Row: {
          id: string;
          clinic_id: string;
          name: string;
          phone: string;
          last_cleaning_date: string | null;
          total_visits: number;
          notes: string;
          recall_status: Database["public"]["Enums"]["recall_status"];
          recall_sequence_step: number;
          recall_attempts: number;
          recall_next_attempt_at: string | null;
          recall_last_service: string | null;
          last_contacted_at: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          name: string;
          phone: string;
          last_cleaning_date?: string | null;
          notes?: string;
        };
        Update: Partial<Database["public"]["Tables"]["patients"]["Insert"]> & {
          last_contacted_at?: string | null;
          recall_status?: Database["public"]["Enums"]["recall_status"];
          recall_sequence_step?: number;
          recall_attempts?: number;
          recall_next_attempt_at?: string | null;
          recall_last_service?: string | null;
          last_cleaning_date?: string | null;
          total_visits?: number;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      bookings: {
        Row: {
          id: string;
          clinic_id: string;
          patient_id: string | null;
          provider_id: string | null;
          patient_name: string;
          phone: string;
          service: string;
          is_new_patient: boolean;
          starts_at: string;
          ends_at: string;
          slot_date: string | null;
          slot_time: string | null;
          status: Database["public"]["Enums"]["booking_status"];
          source: Database["public"]["Enums"]["booking_source"];
          notes: string;
          confirmed_at: string | null;
          reminder_sent_at: string | null;
          review_sent_at: string | null;
          followup_sent_at: string | null;
          cancelled_at: string | null;
          no_show_at: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          patient_id?: string | null;
          provider_id?: string | null;
          patient_name: string;
          phone: string;
          service: string;
          is_new_patient?: boolean;
          starts_at: string;
          ends_at: string;
          status?: Database["public"]["Enums"]["booking_status"];
          source?: Database["public"]["Enums"]["booking_source"];
          notes?: string;
        };
        Update: Partial<Database["public"]["Tables"]["bookings"]["Insert"]> & {
          // lifecycle event timestamps are set AFTER creation, so they're
          // updatable even though they're not part of Insert
          confirmed_at?: string | null;
          reminder_sent_at?: string | null;
          review_sent_at?: string | null;
          followup_sent_at?: string | null;
          cancelled_at?: string | null;
          no_show_at?: string | null;
          reappointment_sent_at?: string | null;
          followup_type?: string | null;
          slot_date?: string | null;
          slot_time?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          clinic_id: string;
          patient_id: string | null;
          patient_name: string;
          phone: string | null;
          body: string;
          urgency: Database["public"]["Enums"]["message_urgency"];
          status: Database["public"]["Enums"]["message_status"];
          source: string;
          created_at: string;
          resolved_at: string | null;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          patient_name: string;
          phone?: string | null;
          body: string;
          urgency?: Database["public"]["Enums"]["message_urgency"];
          status?: Database["public"]["Enums"]["message_status"];
          source?: string;
        };
        Update: Partial<Database["public"]["Tables"]["messages"]["Insert"]> & {
          resolved_at?: string | null;
        };
        Relationships: [];
      };
      call_logs: {
        Row: {
          id: string;
          clinic_id: string;
          patient_id: string | null;
          call_id: string | null;
          direction: Database["public"]["Enums"]["call_direction"];
          patient_name: string | null;
          phone: string | null;
          duration_seconds: number;
          outcome: string | null;
          sentiment: string | null;
          summary: string | null;
          transcript: string | null;
          cost_usd: number;
          ended_reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          call_id?: string | null;
          direction?: Database["public"]["Enums"]["call_direction"];
          patient_name?: string | null;
          phone?: string | null;
          duration_seconds?: number;
          outcome?: string | null;
          sentiment?: string | null;
          summary?: string | null;
          transcript?: string | null;
          cost_usd?: number;
          ended_reason?: string | null;
          patient_id?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["call_logs"]["Insert"]>;
        Relationships: [];
      };
      active_calls: {
        Row: {
          id: string;
          clinic_id: string;
          call_id: string;
          phone: string | null;
          patient_name: string | null;
          state: Database["public"]["Enums"]["call_state"];
          started_at: string;
          ended_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          call_id: string;
          phone?: string | null;
          patient_name?: string | null;
          state?: Database["public"]["Enums"]["call_state"];
        };
        Update: Partial<Database["public"]["Tables"]["active_calls"]["Insert"]> & {
          ended_at?: string | null;
        };
        Relationships: [];
      };
      waitlist: {
        Row: {
          id: string;
          clinic_id: string;
          patient_id: string | null;
          patient_name: string;
          phone: string;
          service: string;
          preferred_days: number[];
          preferred_times: string | null;
          status: Database["public"]["Enums"]["waitlist_status"];
          priority: number;
          attempts: number;
          declines: number;
          last_attempt_at: string | null;
          last_declined_at: string | null;
          max_wait_days: number;
          expires_at: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          patient_id?: string | null;
          patient_name: string;
          phone: string;
          service?: string;
          preferred_days?: number[];
          preferred_times?: string | null;
          status?: Database["public"]["Enums"]["waitlist_status"];
          priority?: number;
          notes?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["waitlist"]["Insert"]> & {
          status?: Database["public"]["Enums"]["waitlist_status"];
          attempts?: number;
          declines?: number;
          last_attempt_at?: string | null;
          last_declined_at?: string | null;
          expires_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      waitlist_call_queue: {
        Row: {
          id: string;
          clinic_id: string;
          slot_id: string | null;
          waitlist_id: string | null;
          patient_name: string;
          phone: string;
          service: string | null;
          slot_starts_at: string;
          priority_score: number;
          queue_position: number;
          status: Database["public"]["Enums"]["queue_status"];
          method: Database["public"]["Enums"]["queue_method"];
          scheduled_at: string;
          attempted_at: string | null;
          outcome: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          slot_id?: string | null;
          waitlist_id?: string | null;
          patient_name: string;
          phone: string;
          service?: string | null;
          slot_starts_at: string;
          priority_score?: number;
          queue_position?: number;
          status?: Database["public"]["Enums"]["queue_status"];
          method?: Database["public"]["Enums"]["queue_method"];
        };
        Update: Partial<Database["public"]["Tables"]["waitlist_call_queue"]["Insert"]> & {
          status?: Database["public"]["Enums"]["queue_status"];
          outcome?: string | null;
          attempted_at?: string | null;
        };
        Relationships: [];
      };
      cancelled_slots: {
        Row: {
          id: string;
          clinic_id: string;
          booking_id: string | null;
          service: string | null;
          starts_at: string;
          status: Database["public"]["Enums"]["slot_status"];
          filled_by_waitlist_id: string | null;
          fill_attempts: number;
          filled_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          booking_id?: string | null;
          service?: string | null;
          starts_at: string;
          status?: Database["public"]["Enums"]["slot_status"];
        };
        Update: Partial<Database["public"]["Tables"]["cancelled_slots"]["Insert"]> & {
          status?: Database["public"]["Enums"]["slot_status"];
          filled_at?: string | null;
          filled_by_waitlist_id?: string | null;
          fill_attempts?: number;
        };
        Relationships: [];
      };
      service_durations: {
        Row: {
          id: string;
          clinic_id: string;
          service: string;
          duration_minutes: number;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          service: string;
          duration_minutes?: number;
        };
        Update: Partial<Database["public"]["Tables"]["service_durations"]["Insert"]>;
        Relationships: [];
      };
      cron_logs: {
        Row: {
          id: string;
          cron_name: string;
          status: string | null;
          result: Json | null;
          error: string | null;
          started_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          cron_name: string;
          status?: string | null;
          result?: Json | null;
          error?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["cron_logs"]["Insert"]> & {
          status?: string | null;
          completed_at?: string | null;
          result?: Json | null;
          error?: string | null;
        };
        Relationships: [];
      };
      daily_metrics: {
        Row: {
          id: string;
          clinic_id: string;
          date: string;
          bookings: number;
          confirmed: number;
          ai_bookings: number;
          cancellations: number;
          new_patients: number;
          calls_total: number;
          calls_booked: number;
          ai_cost_usd: number;
          created_at: string;
        };
        Insert: {
          clinic_id: string;
          date: string;
        };
        Update: Partial<Database["public"]["Tables"]["daily_metrics"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: {
      clinic_overview: {
        Row: {
          clinic_id: string | null;
          today_bookings: number | null;
          today_confirmed: number | null;
          today_ai: number | null;
          today_new_patients: number | null;
          total_patients: number | null;
          patients_recall_due: number | null;
          unread_messages: number | null;
          emergency_messages: number | null;
          waitlist_active: number | null;
          live_calls: number | null;
        };
        Relationships: [];
      };
      patient_health: {
        Row: {
          patient_id: string | null;
          clinic_id: string | null;
          patient_name: string | null;
          phone: string | null;
          total_completed: number | null;
          total_cancellations: number | null;
          total_no_shows: number | null;
          last_visit_at: string | null;
          next_visit_at: string | null;
          is_overdue_recall: boolean | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      get_available_slots: {
        Args: {
          p_clinic: string;
          p_date: string;
          p_service?: string;
          p_provider_id?: string;
        };
        Returns: {
          starts_at: string;
          ends_at: string;
          provider_id: string;
          provider_name: string;
        }[];
      };
      book_appointment: {
        Args: {
          p_clinic: string;
          p_starts_at: string;
          p_service: string;
          p_patient_name: string;
          p_phone: string;
          p_provider_id?: string;
          p_source?: Database["public"]["Enums"]["booking_source"];
          p_is_new_patient?: boolean;
          p_notes?: string;
        };
        Returns: Json;
      };
      get_clinic_id: {
        Args: Record<string, never>;
        Returns: string;
      };
      increment_declined: {
        Args: { p_waitlist_id: string };
        Returns: undefined;
      };
      score_waitlist_candidates: {
        Args: { p_slot_id: string };
        Returns: {
          waitlist_id: string;
          patient_name: string;
          phone: string;
          service: string | null;
          score: number;
          reliability: number;
          preference: number;
          wait_score: number;
          value_score: number;
          penalties: number;
          rank_position: number;
        }[];
      };
    };
    Enums: {
      user_role: "owner" | "admin" | "staff";
      booking_status: "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show";
      booking_source: "ai" | "staff" | "online" | "waitlist";
      message_urgency: "routine" | "urgent" | "emergency";
      message_status: "unread" | "read" | "resolved";
      recall_status: "pending" | "in_progress" | "booked" | "declined" | "exhausted" | "opted_out";
      call_direction: "inbound" | "outbound";
      call_state: "active" | "ended";
      waitlist_status: "waiting" | "offered" | "booked" | "declined" | "expired";
      queue_status: "pending" | "calling" | "called" | "declined" | "booked" | "expired" | "skipped";
      queue_method: "call" | "sms";
      slot_status: "open" | "processing" | "filled" | "expired" | "too_late";
    };
  };
}

// ---- Friendly aliases derived from the contract (use these in app code) ----
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type Views<T extends keyof Database["public"]["Views"]> =
  Database["public"]["Views"][T]["Row"];
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T];

export type Booking = Tables<"bookings">;
export type Patient = Tables<"patients">;
export type Provider = Tables<"providers">;
export type ClinicMessage = Tables<"messages">;
export type Clinic = Tables<"clinics">;
export type ClinicOverview = Views<"clinic_overview">;
export type PatientHealth = Views<"patient_health">;
