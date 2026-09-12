export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      [
        `Missing required environment variable: ${name}.`,
        "",
        "  Add the missing value to the root `.env` file:",
        "    TELEGRAM_BOT_TOKEN  from @BotFather in Telegram",
        "    CHANNEL_CODE        the Channel Code from CopilotKit Intelligence",
        "    INTELLIGENCE_API_KEY  a project-scoped key from that same project",
        "    OPENAI_API_KEY + MODEL  the model the agent runs on",
        "",
        "  See apps/channel/README.md for the full setup.",
      ].join("\n"),
    );
  }
  return value;
}
