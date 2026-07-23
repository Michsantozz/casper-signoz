import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// better-auth tables (user/session/account/verification). Generated via the
// CLI (auth-schema.ts) and re-exported here so they're picked up by
// migrations + the client.
export * from "./auth-schema";

/**
 * dedup_key → Recall.ai bot_id mapping.
 *
 * Recall does NOT dedupe bots created via Create Bot (only in the Calendar
 * Integration). This table is the app's source of truth: it guarantees 1 bot
 * per meeting (scope). Typical dedup_key:
 * `${meeting_start_time}-${meeting_url}` (one bot per meeting).
 */
export const recallBots = pgTable(
  "recall_bots",
  {
    /** Stable dedup key defined by the app. PK. */
    dedupKey: text("dedup_key").primaryKey(),
    /** Bot ID returned by Recall. */
    botId: text("bot_id").notNull(),
    /** Meeting URL (Recall may clear it days after the join). */
    meetingUrl: text("meeting_url").notNull(),
    /** join_at ISO 8601, null for ad-hoc bots. */
    joinAt: timestamp("join_at", { withTimezone: true }),
    /** Arbitrary app metadata (resourceId, threadId, etc.). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("recall_bots_bot_id_idx").on(table.botId),
    // Backs listUpcomingBotsForUser (metadata->>'user_id' filter). Partial on
    // join_at not-null: only the "upcoming" rows that query ever scans.
    index("recall_bots_metadata_user_id_idx")
      .on(sql`(${table.metadata}->>'user_id')`)
      .where(sql`${table.joinAt} is not null`),
  ],
);

export type RecallBotRow = typeof recallBots.$inferSelect;
export type NewRecallBotRow = typeof recallBots.$inferInsert;

/**
 * User → Recall.ai calendar mapping (Calendar V2, multi-user).
 *
 * Each app user connects their own calendar (Google/Outlook). Recall creates
 * a calendar per connection and returns an `id`. This table links that `id`
 * to the user.
 *
 * Dedup is by (platform, platformEmail): Recall does NOT dedupe calendars on
 * creation. Before creating one, we look it up by email+platform and
 * reconnect (PATCH) if it already exists disconnected, instead of creating a
 * duplicate.
 */
export const userCalendars = pgTable(
  "user_calendars",
  {
    /** Calendar ID returned by Recall (api/v2/calendars). PK. */
    recallCalendarId: text("recall_calendar_id").primaryKey(),
    /** User ID in our system (calendar owner). */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Platform: "google_calendar" | "microsoft_outlook". */
    platform: text("platform").notNull(),
    /** Authorized account email (dedup key together with platform). */
    platformEmail: text("platform_email"),
    /** Last known calendar status (connecting/connected/disconnected). */
    status: text("status"),
    /** Arbitrary app metadata. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("user_calendars_user_id_idx").on(table.userId),
    index("user_calendars_email_platform_idx").on(
      table.platformEmail,
      table.platform,
    ),
    uniqueIndex("user_calendars_owner_email_platform_uidx").on(
      table.userId,
      table.platformEmail,
      table.platform,
    ),
    // Backs listAutoRecordCalendars (system cron): metadata->>'auto_record' =
    // 'true'. Partial index = only the opted-in rows.
    index("user_calendars_auto_record_idx")
      .on(sql`(${table.metadata}->>'auto_record')`)
      .where(sql`(${table.metadata}->>'auto_record') = 'true'`),
  ],
);

export type UserCalendarRow = typeof userCalendars.$inferSelect;
export type NewUserCalendarRow = typeof userCalendars.$inferInsert;

/**
 * In-app notification. Created when a meeting's minutes are ready (bot
 * webhook). Marked read via readAt.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    /** Recipient (FK user). */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Type: "meeting_summary_ready" | ... */
    type: text("type").notNull(),
    message: text("message").notNull(),
    /** In-app deep link to open when clicked (e.g. /meetings/[botId]). */
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("notifications_user_idx").on(table.userId),
    // Partial index: only UNREAD ones (what the bell queries).
    index("notifications_user_unread_idx")
      .on(table.userId)
      .where(sql`${table.readAt} is null`),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

// ───────────────────────────────────────────────────────────────────────────
// Persisted meeting minutes (meeting_records)
//
// Recall clears the transcript/artifacts days after the meeting, and
// generating the minutes costs an LLM call. Persisting here makes the
// minutes the app's source of truth:
//  - the bot webhook enqueues the enrichment (durable, with retry via Inngest);
//  - the enrichment writes the structured summary + transcript text here;
//  - the UI/tools read from here (cache), without re-fetching from Recall or
//    re-paying for the LLM;
//  - the reconciliation cron sweeps rows stuck in "pending"/"processing".
// ───────────────────────────────────────────────────────────────────────────

/** Lifecycle of a minutes' enrichment (enforced by the database via enum). */
export const meetingRecordStatusEnum = pgEnum("meeting_record_status", [
  "pending", // queued, transcript not yet processed
  "processing", // enrichment running
  "done", // minutes generated and persisted
  "failed", // failed after retries
]);

export const meetingRecords = pgTable(
  "meeting_records",
  {
    /** Recall botId — 1 minutes record per bot. PK. */
    botId: text("bot_id").primaryKey(),
    /** Meeting owner (for scoping/notification). */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** Meeting URL (denormalized for display). */
    meetingUrl: text("meeting_url"),
    /**
     * Owner-editable display title. Null until the owner sets one — the UI then
     * derives a title from the summary's first sentence or the URL host. Lets
     * the user override the auto-derived label with a real name.
     */
    title: text("title"),
    /** Enrichment state. */
    status: meetingRecordStatusEnum("status").notNull().default("pending"),
    /** Number of enrichment attempts (for diagnostics/backoff). */
    attempts: integer("attempts").notNull().default(0),
    /** Last error message, if failed. */
    error: text("error"),
    /** "Speaker: line" transcript text (cache; Recall expires it). */
    transcript: text("transcript"),
    /** Executive summary generated by the LLM. */
    summary: text("summary"),
    /** Prose overview (paragraph). */
    overview: text("overview"),
    /** Decisions: string[]. */
    decisions: jsonb("decisions").$type<string[]>(),
    /** Action items: { task, owner|null }[]. */
    actionItems: jsonb("action_items").$type<
      Array<{ task: string; owner: string | null }>
    >(),
    /** Main topics: string[]. */
    topics: jsonb("topics").$type<string[]>(),
    /** Thematic sections: { title, bullets[], startSeconds|null }[]. */
    sections: jsonb("sections").$type<
      Array<{ title: string; bullets: string[]; startSeconds: number | null }>
    >(),
    /** Key moments: { label, kind, atSeconds|null }[]. */
    moments: jsonb("moments").$type<
      Array<{
        label: string;
        kind: "topic" | "action" | "question" | "objection";
        atSeconds: number | null;
      }>
    >(),
    /**
     * Curated highlight clips (soundbites): { label, startSeconds, endSeconds }[].
     * Ranges the LLM flagged as share-worthy — the notebook cuts them to mp4 via
     * mediabunny. Unlike moments (points), these carry an explicit end.
     */
    soundbites: jsonb("soundbites").$type<
      Array<{ label: string; startSeconds: number; endSeconds: number }>
    >(),
    /** % speaking time per participant: { name, share }[] (share 0..1). */
    talkShares: jsonb("talk_shares").$type<
      Array<{ name: string; share: number }>
    >(),
    /**
     * Team-dynamics / meeting-health metrics derived from the word-level
     * transcript (who dominated, interruptions, silences, monologues, balance,
     * + rankable human moments). No LLM/audio — pure timestamp math. Shape
     * mirrors MeetingDynamics in server/recall/dynamics.ts. Null for legacy rows
     * or transcripts without timestamps.
     */
    dynamics: jsonb("dynamics").$type<{
      participants: Array<{
        name: string;
        talkShare: number;
        talkSeconds: number;
        turns: number;
        interruptionsMade: number;
        interruptionsReceived: number;
        longestTurnSeconds: number;
      }>;
      totalTalkSeconds: number;
      turnCount: number;
      interruptions: number;
      silenceSeconds: number;
      balance: number;
      moments: Array<{
        kind: "interruption" | "monologue" | "silence";
        atSeconds: number;
        durationSeconds: number;
        label: string;
      }>;
    }>(),
    /**
     * LLM meeting-health INSIGHT over the dynamics metrics: a manager-facing
     * read of HOW the team interacted + semantic re-labels of each timing moment
     * with an emotional tone. One Fireworks call at enrichment. Shape mirrors
     * MeetingHealthInsight in server/recall/dynamics-insight.ts. Null when
     * dynamics is absent or the LLM call failed (best-effort).
     */
    dynamicsInsight: jsonb("dynamics_insight").$type<{
      summary: string;
      headline: string;
      moments: Array<{
        atSeconds: number;
        kind: "interruption" | "monologue" | "silence";
        label: string;
        tone: "tense" | "energized" | "flat" | "neutral";
      }>;
    }>(),
    /**
     * Word-level transcript with timestamps, persisted so the notebook's
     * karaoke/seek survive Recall's artifact expiry. Shape mirrors the UI's
     * TranscriptUtteranceView. Null for legacy rows (falls back to Recall).
     */
    transcriptStruct: jsonb("transcript_struct").$type<
      Array<{
        speaker: string;
        start: number | null;
        words: Array<{ text: string; start: number | null; end: number | null }>;
      }>
    >(),
    /**
     * Durable video URL — the mixed recording copied to our own object storage
     * (S3/MinIO). Unlike Recall's signed URL (expires in hours), this persists.
     * Null when media copy was skipped/failed (player falls back to Recall).
     */
    videoUrl: text("video_url"),
    /**
     * Screen-share timeline — [start, end] windows (seconds from recording start)
     * where the shared screen was on, parsed from Recall's participant_events.
     * Drives Screen Intelligence: frames are only captured inside these spans.
     * Null for legacy rows / meetings with no screen share.
     */
    screenshareSpans: jsonb("screenshare_spans").$type<
      Array<{ start: number; end: number | null }>
    >(),
    /**
     * Public share token (unguessable). When non-null, the meeting is reachable
     * read-only at /share/[token] WITHOUT auth (it bypasses RLS via the public
     * repository). Clearing it (set null) revokes the link. Unique so the public
     * lookup can index on it.
     */
    shareToken: text("share_token").unique(),
    /** When the current share link was created (for display). Null if not shared. */
    shareCreatedAt: timestamp("share_created_at", { withTimezone: true }),
    /** Durable outbox flag: true until the ready notification is delivered. */
    summaryNotificationPending: boolean("summary_notification_pending")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("meeting_records_user_idx").on(table.userId),
    index("meeting_records_status_idx").on(table.status),
    index("meeting_records_share_token_idx").on(table.shareToken),
    // Backs the keyset-paginated library query: ORDER BY created_at DESC with
    // bot_id as the stable tiebreaker (two rows can share created_at when
    // webhooks land in the same tick). See listMeetingRecordsPage.
    index("meeting_records_created_at_bot_id_idx").on(
      table.createdAt.desc(),
      table.botId.desc(),
    ),
  ],
);

export type MeetingRecordRow = typeof meetingRecords.$inferSelect;
export type NewMeetingRecordRow = typeof meetingRecords.$inferInsert;

/**
 * App-level rate limiting (fixed-window counter) for expensive routes NOT
 * covered by better-auth's own limiter — which only intercepts /api/auth/*.
 *
 * One row per bucket key (e.g. `chat:${userId}`). `count` is the hits in the
 * current window; `windowStart` marks when the window opened. The check helper
 * (shared/lib/rate-limit.ts) resets the window atomically when it has elapsed.
 * Persistent + shared across replicas (matches better-auth's storage=database),
 * so limits hold behind a multi-instance deploy — an in-memory Map would count
 * per-process and reset on every deploy.
 */
export const rateLimitApp = pgTable("rate_limit_app", {
  /** Bucket key: `${route}:${userId}` (or `${route}:ip:${ip}` for anon). PK. */
  key: text("key").primaryKey(),
  /** Hits recorded in the current window. */
  count: integer("count").notNull().default(0),
  /** When the current window opened (epoch millis). */
  windowStart: timestamp("window_start", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RateLimitAppRow = typeof rateLimitApp.$inferSelect;

/**
 * Consumed OAuth `state` nonces — makes a signed calendar-OAuth `state`
 * SINGLE-USE (blocks replay within its 10min validity window).
 *
 * The `state` is HMAC-signed and session-bound (see server/recall/oauth-state.ts
 * + calendar-google-callback.ts), which already stops forgery and cross-browser
 * replay. This closes the residual vector: the SAME user replaying their OWN
 * still-valid `state` to drive a second calendar link. On callback we INSERT the
 * nonce; a conflict means it was already consumed → reject. No user_id column and
 * no RLS: a nonce is a random 128-bit token, globally unique, not tenant data.
 * `expiresAt` mirrors the state TTL so a periodic sweep can reclaim old rows.
 */
export const oauthStateNonce = pgTable(
  "oauth_state_nonce",
  {
    /** The random nonce embedded in the signed state. PK → INSERT conflict = replay. */
    nonce: text("nonce").primaryKey(),
    /** When the owning state expires; rows past this are safe to sweep. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** When the nonce was consumed (audit/debug). */
    consumedAt: timestamp("consumed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Backs the periodic sweep (delete where expires_at < now()).
  (table) => [index("oauth_state_nonce_expires_at_idx").on(table.expiresAt)],
);

export type OAuthStateNonceRow = typeof oauthStateNonce.$inferSelect;
