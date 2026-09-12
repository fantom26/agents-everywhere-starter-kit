/**
 * A scripted walkthrough of the whole flow, printed as Telegram would render it.
 *
 *   npm run demo --workspace channel
 *
 * This calls the real tool handlers against a real database and renders each
 * posted card through the real Telegram renderer, so what you see here is
 * byte-for-byte what a student's phone would show. The only thing it stands in
 * for is the model deciding which tool to call — that needs a live API key and
 * a bot token, and the README says how to check it.
 *
 * It is also the fastest way to re-check the rules by eye before a demo.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tools resolve the database lazily, so point it at a throwaway file before
// anything imports it.
process.env.PRACTICE_DB_PATH = join(mkdtempSync(join(tmpdir(), "practice-")), "demo.db");

const { renderToIR } = await import("@copilotkit/channels");
const { renderTelegram } = await import("@copilotkit/channels/telegram");
const { db } = await import("./db");
const { seedDatabase } = await import("./seed");
const { linkPrompt } = await import("./components");
const { sendDueReminders } = await import("./reminders");
const {
  linkStudentAccount,
  getMyProgress,
  getMyBookings,
  searchAvailablePractices,
  getPracticeDetails,
  bookPracticeTool,
  cancelBookingTool,
  rescheduleBookingTool,
} = await import("./tools");
const { availability, getBookings, searchSessions } = await import("./domain");
const { route } = await import("./router");
const { cb } = await import("./callbacks");
const { linkByContact } = await import("./services");
const { HOUR_MS } = await import("./time");

const TELEGRAM_USER_ID = "424242";
const database = db();
const seed = seedDatabase(database);

/** Renders a posted card the way the adapter would, then prints it. */
const posted: string[] = [];
const thread = {
  async post(node: unknown) {
    const payload = renderTelegram(renderToIR(node as never));
    posted.push(payload.text);
    const keyboard = (payload.inlineKeyboard ?? [])
      .flat()
      .map((button) => `[ ${button.text}${button.url ? ` → ${button.url}` : ""} ]`)
      .join(" ");
    console.log(indent(htmlToTerminal(payload.text)));
    if (keyboard) console.log(indent(keyboard));
    return { id: `ref_${posted.length}` };
  },
  async runAgent() {
    /* the model's turn; not exercised here */
  },
};

const ctx = {
  thread,
  actor: { id: TELEGRAM_USER_ID, kind: "human" as const },
  user: null,
  platform: "telegram",
} as never;

function htmlToTerminal(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gs, "[1m$1[0m")
    .replace(/<i>(.*?)<\/i>/gs, "[2m$1[0m")
    .replace(/<code>(.*?)<\/code>/gs, "$1")
    .replace(/<a href="(.*?)">(.*?)<\/a>/gs, "$2 ($1)")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");

let step = 0;
function says(who: "student" | "agent", text: string) {
  if (who === "student") {
    step += 1;
    console.log(`\n[36m${step}. Student:[0m ${text}`);
  } else {
    console.log(`   [33m→ tool:[0m ${text}`);
  }
}

function toolResult(label: string, result: unknown) {
  const summary =
    typeof result === "string"
      ? result
      : JSON.stringify(result, (key, value) => (key === "progress" || key === "sessions" || key === "bookings" ? undefined : value));
  console.log(`   [33m→ ${label} returned:[0m ${truncate(summary, 240)}`);
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

console.log("\n[1m═══ Practice Agent — scripted walkthrough ═══[0m");
console.log(`   database: ${process.env.PRACTICE_DB_PATH}`);

// ---------------------------------------------------------------- 1. /start
says("student", "/start");
await thread.post(linkPrompt());

// ---------------------------------------------------------------- 2. linking
says("student", "[taps 📱 Share my phone number]");
console.log("   \x1b[33m→ Telegram sends a verified contact; no tool, no model\x1b[0m");
const shared = linkByContact(database, TELEGRAM_USER_ID, {
  phoneNumber: "+380501112233",
  userId: Number(TELEGRAM_USER_ID),
});
console.log(
  `   \x1b[32m✓ linked to ${shared.ok ? shared.student.fullName : "nobody"} — and it stays linked\x1b[0m`,
);
says("student", "0501112233");
says("agent", "link_student_account({ phone: '0501112233' }) — the typed fallback, still idempotent");
toolResult("link_student_account", await linkStudentAccount.handler({ phone: "0501112233" }, ctx));


// ------------------------------------------- the button product, with no model
//
// Everything below this banner happens with no API key, no model call, and no
// sentence to interpret: a payload goes in, a screen comes out. It is the same
// `services.ts` the tools above call, so the rules are not re-implemented — the
// parity tests assert exactly that.
console.log("\n\x1b[1m── The whole product, by tapping buttons: no model involved ──\x1b[0m");

function taps(label: string, payload: string) {
  console.log(`\n\x1b[36m   [tap]\x1b[0m ${label}  \x1b[2m(${payload})\x1b[0m`);
  const rendered = route(database, TELEGRAM_USER_ID, payload);
  const out = renderTelegram(renderToIR(rendered.card as never));
  const keyboard = (out.inlineKeyboard ?? [])
    .flat()
    .map((button) => `[ ${button.text}${button.url ? ` \u2192 ${button.url}` : ""} ]`)
    .join(" ");
  console.log(indent(htmlToTerminal(out.text)));
  if (keyboard) console.log(indent(keyboard));
  return rendered;
}

taps("/start, already linked", cb.menu());
taps("📅 Find practice", cb.find());
taps("Trio practice", cb.findPeriod("trios"));
taps("Next week", cb.findSlots("trios", "n"));

const triosNextWeek = searchSessions(database, { practiceTypeCode: "trios", limit: 1 });
taps("the first session offered", cb.book(triosNextWeek[0].session.id));
taps("📊 My progress", cb.progress());
taps("📚 My bookings", cb.bookings());

const buttonBooking = getBookings(database, 1).find(
  (booking) => booking.sessionId === triosNextWeek[0].session.id,
)!;
taps("Cancel", cb.cancelAsk(buttonBooking.id));
taps("Yes, cancel it", cb.cancelDo(buttonBooking.id));

// The screen the brief singled out: a role that is taken is shown, but it is
// text. Only the free roles are buttons.
taps("a group mentoring session whose coach seat is taken", cb.session(seed.mentoringSessionId));

console.log("\n\x1b[1m── The same system, reached by talking to it ──\x1b[0m");

// ---------------------------------------------------------------- 3. search
says("student", "I need a practice next week after 18:00");
says("agent", "search_available_practices({ practiceType: 'intermodule', afterTime: '18:00', limit: 3 })");
const search = await searchAvailablePractices.handler(
  { practiceType: "intermodule", afterTime: "18:00", limit: 3 },
  ctx,
);
toolResult("search_available_practices", search);
const options = (search as { sessions: { sessionId: number }[] }).sessions;

// ---------------------------------------------------------------- 4. booking
says("student", "Book me on the first one");
says("agent", `book_practice({ sessionId: ${options[0].sessionId} })`);
toolResult("book_practice", await bookPracticeTool.handler({ sessionId: options[0].sessionId }, ctx));

// ---------------------------------------------------------------- 5. progress
says("student", "How many intermodule meetings do I still need?");
says("agent", "get_my_progress()");
toolResult("get_my_progress", await getMyProgress.handler({}, ctx));

// ------------------------------------------------- 6. mentoring role refusal
says("student", "I want group mentoring as the coach");
says("agent", `get_practice_details({ sessionId: ${seed.mentoringSessionId}, role: 'coach' })`);
toolResult(
  "get_practice_details",
  await getPracticeDetails.handler({ sessionId: seed.mentoringSessionId, role: "coach" }, ctx),
);
says("agent", `book_practice({ sessionId: ${seed.mentoringSessionId}, role: 'coach' }) — refused`);
toolResult(
  "book_practice",
  await bookPracticeTool.handler({ sessionId: seed.mentoringSessionId, role: "coach" }, ctx),
);

// ----------------------------------------------------- 7. the 24-hour rule
console.log("\n[1m── Filling the annual requirement to reach the 24-hour rule ──[0m");
const remaining = (
  (await getMyProgress.handler({}, ctx)) as { progress: { code: string; remaining: number }[] }
).progress.find((entry) => entry.code === "intermodule")!.remaining;

const more = await searchAvailablePractices.handler(
  { practiceType: "intermodule", limit: 10 },
  ctx,
);
const booked = new Set<number>([options[0].sessionId]);
let filled = 0;
for (const option of (more as { sessions: { sessionId: number; startsAtUtc: string }[] }).sessions) {
  if (filled >= remaining) break;
  if (booked.has(option.sessionId) || option.sessionId === seed.soonSessionId) continue;
  const result = await bookPracticeTool.handler({ sessionId: option.sessionId }, ctx);
  if ((result as { booked?: boolean }).booked) {
    booked.add(option.sessionId);
    filled += 1;
  }
}
console.log(`   quota filled with ${filled} more booking(s)`);

const farAway = (more as { sessions: { sessionId: number; startsAtUtc: string }[] }).sessions.find(
  (option) =>
    !booked.has(option.sessionId) &&
    new Date(option.startsAtUtc).getTime() - Date.now() > 24 * HOUR_MS,
);

says("student", "I want one more intermodule meeting next week");
says("agent", `book_practice({ sessionId: ${farAway!.sessionId} }) — beyond quota, more than 24h out`);
toolResult("book_practice", await bookPracticeTool.handler({ sessionId: farAway!.sessionId }, ctx));

says("student", "What about the one this evening?");
says("agent", `book_practice({ sessionId: ${seed.soonSessionId} }) — beyond quota, inside 24h`);
toolResult("book_practice", await bookPracticeTool.handler({ sessionId: seed.soonSessionId }, ctx));

// ---------------------------------------------------------- 8. reschedule
says("student", "Show my bookings");
says("agent", "get_my_bookings()");
const mine = (await getMyBookings.handler({}, ctx)) as {
  bookings: { bookingId: number; sessionId: number }[];
};

const moveTarget = (more as { sessions: { sessionId: number }[] }).sessions.find(
  (option) => !booked.has(option.sessionId) && option.sessionId !== seed.soonSessionId,
);
const movable = mine.bookings.find((booking) => booking.sessionId !== seed.soonSessionId)!;
if (moveTarget) {
  says("student", "Move one of my bookings to another date");
  says("agent", `reschedule_booking({ bookingId: ${movable.bookingId}, newSessionId: ${moveTarget.sessionId} })`);
  toolResult(
    "reschedule_booking",
    await rescheduleBookingTool.handler(
      { bookingId: movable.bookingId, newSessionId: moveTarget.sessionId },
      ctx,
    ),
  );
}

// ------------------------------------------- 9. a failed reschedule is safe
// Book a trios session, then try to move it onto the trios session that is
// already full. The move must fail and the original seat must survive.
const trios = await searchAvailablePractices.handler({ practiceType: "trios", limit: 3 }, ctx);
const triosSession = (trios as { sessions: { sessionId: number }[] }).sessions[0];
const triosBooking = (await bookPracticeTool.handler(
  { sessionId: triosSession.sessionId },
  ctx,
)) as { bookingId: number };

says("student", "Move my trio practice onto the session that is already full");
says("agent", `reschedule_booking({ bookingId: ${triosBooking.bookingId}, newSessionId: ${seed.fullSessionId} }) — the full one`);
toolResult(
  "reschedule_booking",
  await rescheduleBookingTool.handler(
    { bookingId: triosBooking.bookingId, newSessionId: seed.fullSessionId },
    ctx,
  ),
);
const stillThere = (await getMyBookings.handler({}, ctx)) as {
  bookings: { bookingId: number; sessionId: number }[];
};
console.log(
  `   [32m✓ original booking #${triosBooking.bookingId} kept on session ${
    stillThere.bookings.find((booking) => booking.bookingId === triosBooking.bookingId)?.sessionId
  }[0m`,
);

// ---------------------------------------------------------- 10. cancellation
says("student", "Cancel the last one");
const last = stillThere.bookings.at(-1)!;
says("agent", `cancel_booking({ bookingId: ${last.bookingId} })`);
toolResult("cancel_booking", await cancelBookingTool.handler({ bookingId: last.bookingId }, ctx));

// ------------------------------------------------------------- 11. reminder
console.log("\n[1m── One hour before the session, with nobody asking ──[0m");
const soon = availability(database, seed.soonSessionId)!;
const sentTexts: string[] = [];
const sent = await sendDueReminders(
  {
    db: database,
    bot: {
      api: {
        async sendMessage(chatId, text, other) {
          const markup = other?.reply_markup as
            | { inline_keyboard: { text: string; url?: string }[][] }
            | undefined;
          const keyboard = (markup?.inline_keyboard ?? [])
            .flat()
            .map((button) => `[ ${button.text}${button.url ? ` \u2192 ${button.url}` : ""} ]`)
            .join(" ");
          sentTexts.push(
            `to ${String(chatId)}:\n${htmlToTerminal(text)}${keyboard ? `\n${keyboard}` : ""}`,
          );
          return {};
        },
      },
    },
  },
  new Date(soon.session.startsAt.getTime() - HOUR_MS),
);
console.log(`   [33m→ scheduler sent ${sent} reminder(s)[0m`);
for (const text of sentTexts) console.log(indent(text));

console.log("\n[1m═══ end ═══[0m\n");
database.close();
