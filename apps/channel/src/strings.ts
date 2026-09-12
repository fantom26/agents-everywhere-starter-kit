/**
 * Every sentence a student can read, in one place.
 *
 * The product ships in English. The school's students speak Ukrainian, so a
 * translation is coming — and the only thing that makes that a one-file change
 * instead of a grep through every card is this rule:
 *
 *   **No user-facing literal exists outside this file.**
 *
 * Three consequences worth knowing before you add a string:
 *
 * 1. Practice titles are presentation, not data. `practice[code]` renders them;
 *    the database keeps the code, the capacity and the annual requirement, and
 *    its `title` column stays as the fallback for a code nobody translated.
 * 2. Refusals are keyed by the domain's `reason`, never by its `explanation`.
 *    `domain.ts` writes its explanations for the *model*; these are for the
 *    student. Both read the same `facts`, so neither invents a number.
 * 3. Nothing here hard-codes a capacity, a quota, or the 24-hour threshold.
 *    Every number below arrives as an argument.
 */
import type { Refusal, Role } from "./domain";

type Facts = Record<string, unknown>;

const num = (facts: Facts, key: string): string => String(facts[key] ?? "?");

export const en = {
  /** The bot's own name, used in headers. */
  appName: "Practice Agent",

  practice: {
    trios: "Trio practice",
    intermodule: "Intermodule meeting",
    mentoring: "Group mentoring",
  } as Record<string, string>,

  role: {
    coach: "Coach",
    client: "Client",
    listener: "Listener",
  } as Record<Role, string>,

  /** How long until a session starts. The numbers are computed in `time.ts`. */
  time: {
    started: "already started",
    inMinutes: (m: number) => `in ${m} min`,
    inHours: (h: number, m: number) => (m ? `in ${h} h ${m} min` : `in ${h} h`),
    inDays: (d: number, h: number) => (h ? `in ${d} d ${h} h` : `in ${d} d`),
  },

  menu: {
    find: "📅 Find practice",
    progress: "📊 My progress",
    bookings: "📚 My bookings",
    info: "ℹ️ Information",
    back: "‹ Back",
    greeting: (name: string) => `Hi, ${name}.`,
    hint: "Pick something below — or just tell me what you need.",
  },

  link: {
    header: "Welcome to Practice Agent",
    intro:
      "I am the practice coordinator. I know your progress, the schedule, and the booking rules.",
    ask: "To get started, share the phone number you are on the school roster with.",
    shareButton: "📱 Share my phone number",
    typedFallback: "You can also just type the number.",
    welcomeHeader: (name: string) => `Welcome, ${name}!`,
    linked: "Your account is linked. Here is where you stand:",
    notLinked: "I do not know who you are yet — share your phone number and we can start.",
    refusal: {
      no_such_phone:
        "That number is not on the student roster. Check it, or contact the coordinator if you think it should be there.",
      phone_taken:
        "That number is already linked to a different Telegram account. The coordinator has to unlink it first.",
      telegram_already_linked:
        "This Telegram account is already linked to another student. The coordinator has to unlink it first.",
      contact_not_own:
        "That contact card belongs to someone else. Use the button to send your own number.",
    } as Record<string, string>,
  },

  find: {
    chooseType: "Choose a practice type:",
    allTypes: "All practices",
    choosePeriod: "Choose a date or period:",
    thisWeek: "This week",
    nextWeek: "Next week",
    pickDate: "Pick a date",
    slotsHeader: "Available sessions",
    empty: "No free sessions match that. Try another period, or a different practice type.",
    freeSeats: (free: number, capacity: number) => `${free} of ${capacity} seats free`,
    trainer: (name: string) => `Trainer: ${name}`,
    kyivNote: "Times are Kyiv local.",
    bookThis: "Book this session",
  },

  roles: {
    header: "Choose your role",
    occupied: "❌ occupied",
    available: "✅ available",
    placesLeft: (free: number) => `${free} places left`,
    join: (role: string) => `Join as ${role}`,
    noneFree: "Every role on this session is taken.",
  },

  progress: {
    header: (name: string) => `Progress: ${name}`,
    line: (booked: number, required: number) => `${booked} / ${required}`,
    remaining: (n: number) => `${n} to go`,
    complete: "requirement met",
    extra: (n: number) => ` (+${n} beyond the requirement)`,
    note: "A booking counts as a completed practice.",
  },

  bookings: {
    header: "My bookings",
    empty: "You have no upcoming bookings. Tell me which practice you need and I will find a seat.",
    cancel: "Cancel",
    reschedule: "Reschedule",
    bookingId: (id: number) => `Booking #${id}`,
    extra: "beyond the requirement",
  },

  booked: {
    header: "✅ Booked",
    practice: "Practice",
    when: "When",
    trainerLabel: "Trainer",
    roleLabel: "Role",
    zoom: "Zoom",
    seats: "Seats",
    rolesLabel: "Roles",
    extraNote:
      "This booking is **beyond your annual requirement** — allowed because the session starts within 24 hours and a seat was still free.",
    reminderNote: (id: number) => `Booking #${id} · I will remind you an hour before`,
  },

  cancelled: {
    header: "Booking cancelled",
    note: "The seat is free again and your progress is updated.",
    confirmHeader: "Cancel this booking?",
    confirmYes: "Yes, cancel it",
    confirmNo: "Keep it",
  },

  rescheduled: {
    header: "🔄 Moved",
    from: (when: string) => `Was: ${when}`,
    to: (when: string) => `Now: **${when}** (Kyiv)`,
    chooseNew: "Choose the session to move it to:",
  },

  reminder: {
    header: "⏰ Practice in an hour",
    practice: "Practice",
    starts: "Starts",
    trainerLabel: "Trainer",
    yourRole: "Your role",
    join: "Join in Zoom",
  },

  info: {
    header: "How this works",
    quota: (title: string, required: number, capacity: number) =>
      `**${title}** — ${required} a year · ${capacity} seats per session`,
    rolesLine: (roles: string) => `Roles: ${roles}`,
    extraRule:
      "Once you have met the annual requirement for a practice type, you can still take a spare seat — but only within 24 hours of the start, so required seats stay available for students who still need them.",
    progressRule: "A booking counts as a completed practice; cancelling gives the seat back.",
    reminderRule: "I message you an hour before every session you have booked.",
  },

  calendar: {
    menu: "📅 Google Calendar",
    header: "Google Calendar",
    what:
      "Connect your calendar and every practice you book appears in it — and disappears again when you cancel.",
    connect: "Connect Google Calendar",
    connected: "✅ Connected. New bookings will appear in your calendar.",
    forwardOnly: "Bookings you made before connecting stay where they are.",
    unavailable: "Calendar sync is switched off on this deployment.",
  },

  errors: {
    expired: "That button is out of date. Here is the menu again.",
    notLinked: "I do not know who you are yet — share your phone number and we can start.",
    sessionGone: "That session is no longer available.",
    bookingGone: "I cannot find that booking any more.",
    generic: "Something went wrong on my side. Try again in a moment.",
    aiUnavailable:
      "I did not catch that — I am running without my language model right now. Use the menu below.",
  },

  /**
   * The student-facing sentence for a refusal `domain.ts` returned.
   *
   * `bookableFrom` is pre-formatted by the caller, which owns Kyiv formatting.
   */
  refusal: (reason: Refusal, facts: Facts, formatted: { bookableFrom?: string } = {}): string => {
    switch (reason) {
      case "session_full":
        return `This session is full (${num(facts, "taken")} of ${num(facts, "capacity")} seats taken).`;
      case "already_booked":
        return "You already have a seat on this session.";
      case "session_in_past":
        return "That session has already started.";
      case "session_not_found":
        return en.errors.sessionGone;
      case "booking_not_found":
        return en.errors.bookingGone;
      case "role_required":
        return "This practice is booked by role. Choose the one you want.";
      case "role_not_applicable":
        return "This practice has no roles — book it without one.";
      case "unknown_role":
        return "That is not a role on this practice.";
      case "role_taken":
        return "That role has just been taken. Pick one of the free ones.";
      case "quota_reached_too_early":
        return [
          `You have already met the annual requirement for this practice (${num(facts, "booked")} of ${num(facts, "required")}).`,
          "An extra seat is only allowed within 24 hours of the start, so required seats stay available for students who still need them.",
          formatted.bookableFrom ? `You can book this one from ${formatted.bookableFrom}.` : undefined,
        ]
          .filter(Boolean)
          .join(" ");
      case "different_practice_type":
        return "Rescheduling moves a booking within one practice type. Booking a different practice changes your progress in both, so cancel this one and book the other.";
      default:
        return en.errors.generic;
    }
  },
} as const;

export type Strings = typeof en;

/** The active language. Swap this line — and only this line — to translate. */
export const t: Strings = en;

/** A practice type's display title: translated if we know it, the DB's if not. */
export function practiceTitle(code: string, dbTitle: string): string {
  return t.practice[code] ?? dbTitle;
}

/** A role's display name. */
export function roleName(role: Role): string {
  return t.role[role] ?? role;
}
