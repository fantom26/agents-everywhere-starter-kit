process.env.PRACTICE_DB_PATH = "/tmp/probe-practice.db";
const { renderToIR } = await import("@copilotkit/channels");
const { renderTelegram } = await import("@copilotkit/channels/telegram");
const { linkPrompt } = await import("./components.js");
const { askForContact } = await import("./telegram-bot.js");

const payload = renderTelegram(renderToIR(linkPrompt()));
console.log("--- linkPrompt rendered ---");
console.log(JSON.stringify({ text: payload.text, parseMode: payload.parseMode }, null, 2));

console.log("--- what askForContact would send ---");
const fake = {
  api: {
    async sendMessage(chatId: unknown, text: string, other?: Record<string, unknown>) {
      console.log(JSON.stringify({ chatId, text, other }, null, 2));
      return {};
    },
    async editMessageText() { return {}; },
  },
  on() { return undefined; },
};
await askForContact(fake as never, "424242");
