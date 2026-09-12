/**
 * The Channel, wired to Telegram.
 *
 * The starter kit ships this app pointed at managed Slack. Telegram is a direct
 * adapter instead: `telegram()` holds the bot token and long-polls, so there is
 * no tunnel and no webhook to expose for a demo. The runtime still owns the
 * lifecycle either way — there is no `channel.start()`.
 *
 * There are two front doors here and they are equal citizens:
 *
 *   buttons ──→ router.tsx ──┐
 *                            ├──→ services.ts ──→ domain.ts ──→ SQLite
 *   the agent ──→ tools.tsx ─┘
 *
 * The button door needs no model. If `OPENAI_API_KEY` is missing the bot still
 * finds, books, cancels and reschedules — it just stops answering sentences.
 * That is the point: the AI is the convenient way in, not the only one.
 */
import {
  createChannel,
  defineChannelCommand,
  type StatefulThread,
} from "@copilotkit/channels";
import { telegram, defaultTelegramContext } from "@copilotkit/channels/telegram";
import { resolveModel } from "agent-core";
import { makeChannelAgent } from "../agent/agent";
import { required } from "../config";
import { db } from "../db";
import * as services from "../services";
import { linkOrMenu } from "./handlers/router";
import { attachTelegramHandlers, askForContact, type BotLike } from "./handlers/telegram";
import { linkedCard, progressCard, refusalCard, bookingsCard } from "./messages/components";
import { infoScreen, typePicker } from "./messages/screens";
import { cb } from "./callbacks";
import { t } from "./messages/strings";
import { practiceTools, todayContext, callerContext } from "../agent/tools";

export const telegramAdapter = telegram({
  token: required("TELEGRAM_BOT_TOKEN"),
  // Long-polling: no public URL, no tunnel. Switch to webhook only for a deploy.
  mode: "polling",
  // Booking takes a few database round-trips; showing the tool it is running
  // makes the wait legible instead of looking hung.
  showToolStatus: true,
});

/** The adapter's own grammY bot, narrowed to the slice this app uses. */
const bot = telegramAdapter.bot as unknown as BotLike;

// Attached before the runtime starts the adapter, so these see an update first:
// `/start` is answered here rather than swallowed by the adapter's middleware,
// a tap on one of our buttons is handled here and not passed on, and a shared
// contact — which the Channels adapter does not look at — is handled at all.
attachTelegramHandlers(bot, db());

/**
 * Is a language model actually configured?
 *
 * `resolveModel()` throws on a missing or placeholder key, which is exactly the
 * question being asked. Checked once: the answer cannot change while the
 * process runs.
 */
export const aiConfigured = (() => {
  try {
    resolveModel();
    return true;
  } catch {
    return false;
  }
})();

export const channel = createChannel({
  name: required("CHANNEL_CODE"),

  // Required. "platform" derives the canonical user from provider + workspace +
  // platform user id. Do NOT move this onto CopilotRuntime — that one is for
  // web requests and must be absent on a Channels-only runtime.
  identifyUser: "platform",

  adapters: [telegramAdapter],
  agent: makeChannelAgent,
  tools: practiceTools,

  context: [
    // Telegram's own tagging, HTML, and conversation-model guidance.
    ...defaultTelegramContext,
    {
      description: "Surface",
      value:
        "This is a private Telegram chat with one student. They are on a phone. Keep replies short enough to read without scrolling, and let the cards carry the detail.",
    },
  ],
});

/**
 * A message from a student.
 *
 * Unlinked: the only thing that can happen is linking, so the reply is either
 * "that number worked" or the contact button again — never a search they are
 * not entitled to run. Linked: the agent takes it, unless there is no model, in
 * which case the menu is the answer rather than silence.
 */
async function handleMessage(
  thread: StatefulThread<unknown>,
  text: string,
  telegramUserId: string,
) {
  const student = services.resolveCaller(db(), telegramUserId);

  if (!student) {
    // A typed number still works. Some clients do not offer the contact button,
    // and a student who has already typed one should not be told to start over.
    const typed = text.trim();
    if (/\d{6,}/.test(typed)) {
      const result = services.linkByPhone(db(), telegramUserId, typed);
      if (result.ok) {
        const progress = services.progressFor(db(), telegramUserId);
        await thread.post(
          linkedCard(result.student.fullName, progress.linked ? progress.progress : []),
        );
        await thread.post(linkOrMenu(db(), telegramUserId));
        return;
      }
      await thread.post(
        refusalCard(t.link.refusal[result.reason] ?? t.errors.generic, cb.menu()),
      );
    }
    await askForContact(bot, telegramUserId);
    return;
  }

  if (!aiConfigured) {
    await thread.post(refusalCard(t.errors.aiUnavailable, cb.menu()));
    await thread.post(linkOrMenu(db(), telegramUserId));
    return;
  }

  await thread.subscribe();
  // The caller is named for the model here so that a restart — which empties
  // the in-memory conversation history — cannot make it ask for a phone number
  // the database already has. The tools still resolve the student themselves.
  await thread.runAgent({ context: [todayContext(), callerContext(student)] });
}

// A student's chat with the bot is a one-to-one conversation, so every message
// is meant for the agent — there is no channel full of other people's talk to
// stay out of.
channel.onMention(async ({ thread, message }) => {
  await handleMessage(thread, message.text ?? "", message.actor?.id ?? "");
});

channel.onMessage(async ({ thread, message }) => {
  await handleMessage(thread, message.text ?? "", message.actor?.id ?? "");
});

// `/start` is NOT wired here. `channel.onThreadStarted` is the documented place
// for it, but on Telegram it never fires: the adapter's `message:text`
// middleware is registered before its own `bot.command("start")` and returns on
// `/start` without calling `next()`, so nothing emits the event and the student
// who pressed START saw silence. `handlers/telegram.ts` answers `/start` on the
// grammY bot instead, ahead of the adapter — which is also the only layer that
// can send the contact keyboard.

/**
 * Nothing but checking in is available to an unlinked student.
 *
 * Every command runs this first. Unlinked, the answer is always the same one:
 * the link prompt with Telegram's contact button under it, rather than a screen
 * of somebody else's schedule. Returns `true` when the command should stop.
 *
 * In a private chat the chat id is the user id, which is what the reply keyboard
 * has to be addressed to.
 */
async function gateUnlinked(telegramUserId: string): Promise<boolean> {
  if (services.isLinked(db(), telegramUserId)) return false;
  await askForContact(bot, telegramUserId);
  return true;
}

/**
 * Slash commands, so every screen is reachable without scrolling back up the
 * chat to find an old card.
 *
 * Declared rather than attached with `channel.onCommand(name, fn)`, because a
 * declared command carries a description and the adapter registers the set with
 * BotFather — which is what puts them in Telegram's own menu button. `/start` is
 * absent on purpose: Telegram offers it by itself on a fresh chat, and
 * `handlers/telegram.ts` owns it.
 *
 * Every one of them is closed until the student has checked in.
 */
const commands = [
  defineChannelCommand({
    name: "menu",
    description: "Everything, in one screen",
    async handler({ thread, actor }) {
      const telegramUserId = actor?.id ?? "";
      if (await gateUnlinked(telegramUserId)) return;
      await thread.post(linkOrMenu(db(), telegramUserId));
    },
  }),

  defineChannelCommand({
    name: "find",
    description: "Find a practice to book",
    async handler({ thread, actor }) {
      const telegramUserId = actor?.id ?? "";
      if (await gateUnlinked(telegramUserId)) return;
      await thread.post(typePicker(services.practiceTypes(db())));
    },
  }),

  defineChannelCommand({
    name: "progress",
    description: "How many practices you have booked this year",
    async handler({ thread, actor }) {
      const telegramUserId = actor?.id ?? "";
      if (await gateUnlinked(telegramUserId)) return;
      const result = services.progressFor(db(), telegramUserId);
      if (result.linked) await thread.post(progressCard(result.student.fullName, result.progress));
    },
  }),

  defineChannelCommand({
    name: "bookings",
    description: "Your upcoming practices",
    async handler({ thread, actor }) {
      const telegramUserId = actor?.id ?? "";
      if (await gateUnlinked(telegramUserId)) return;
      const result = services.bookingsFor(db(), telegramUserId);
      if (result.linked) await thread.post(bookingsCard(result.bookings, new Date()));
    },
  }),

  defineChannelCommand({
    name: "help",
    description: "The practices, the quota, and the booking rules",
    async handler({ thread, actor }) {
      if (await gateUnlinked(actor?.id ?? "")) return;
      await thread.post(infoScreen(services.practiceTypes(db())));
    },
  }),
];

for (const command of commands) channel.onCommand(command);
