/**
 * The Channel, wired to Telegram.
 *
 * The starter kit ships this app pointed at managed Slack. Telegram is a direct
 * adapter instead: `telegram()` holds the bot token and long-polls, so there is
 * no tunnel and no webhook to expose for a demo. The runtime still owns the
 * lifecycle either way — there is no `channel.start()`.
 */
import { createChannel } from "@copilotkit/channels";
import { telegram, defaultTelegramContext } from "@copilotkit/channels/telegram";
import { makeChannelAgent } from "./agent";
import { required } from "./env";
import { welcomeMessage } from "./components";
import { practiceTools, todayContext } from "./tools";

export const telegramAdapter = telegram({
  token: required("TELEGRAM_BOT_TOKEN"),
  // Long-polling: no public URL, no tunnel. Switch to webhook only for a deploy.
  mode: "polling",
  // Booking takes a few database round-trips; showing the tool it is running
  // makes the wait legible instead of looking hung.
  showToolStatus: true,
});

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

// A student's chat with the bot is a one-to-one conversation, so every message
// is meant for the agent — there is no channel full of other people's talk to
// stay out of. Subscribing on the first mention keeps the group case sane too.
channel.onMention(async ({ thread }) => {
  await thread.subscribe();
  await thread.runAgent({ context: [todayContext()] });
});

channel.onMessage(async ({ thread }) => {
  await thread.subscribe();
  await thread.runAgent({ context: [todayContext()] });
});

// Telegram's /start in a private chat arrives here.
channel.onThreadStarted(async ({ thread }) => {
  await thread.post(welcomeMessage());
});

channel.onWelcome(async ({ thread }) => {
  await thread.post(welcomeMessage());
});
