# Practice Agent — a practice coordinator inside Telegram

**OpenAI + CopilotKit Channels (Telegram adapter) + SQLite**

Students at a coaching school have to complete a set number of educational
practices each year. Working out which ones they still need, which sessions have
a seat, whether a mentoring role is free, and whether they are even allowed to
take an extra session is more than a calendar can express — so it usually turns
into messages to a coordinator.

Practice Agent is that coordinator, living in the Telegram chat students already
use. It understands what they need, knows their progress, applies the booking
rules, and takes the action.

```
Студент:  Потрібна практика наступного тижня після 18:00
Agent:    → search_available_practices({ afterTime: "18:00", … })
          ┌ Вільні сесії ──────────────────────────────
          │ 1. Міжмодульні зустрічі
          │    неділя, 13 вересня, 18:30 (Київ) · за 1 дн 6 год
          │    Тренер: Сергій Литвин · Вільно: 10 з 10
          └ [ 1. неділя ] [ 2. вівторок ] [ 3. четвер ]

Студент:  Забронюй мене на першу
Agent:    → book_practice({ sessionId: 2 })
          ┌ ✅ Заброньовано ───────────────────────────
          │ Коли   неділя, 13 вересня, 18:30 (Київ)
          │ Zoom   https://zoom.us/j/98700002
          └ Бронювання #8 · нагадаю за годину до початку
```

## Why Telegram

Remove Telegram and two things break. Nobody opens a booking website an hour
before a session, so the reminder — the feature that actually stops people
missing practices — has nowhere to arrive. And "book me for Wednesday" only
resolves because the options from the previous turn are still in the
conversation. The surface is not a transport here; it is what makes the
interaction possible.

## Get started

Complete the [root clone/install steps](../../README.md#get-started), then
configure `.env`:

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-key
MODEL=gpt-5.6-sol

TELEGRAM_BOT_TOKEN=123456:ABC-your-token-from-BotFather
CHANNEL_CODE=your-channel-code
INTELLIGENCE_API_KEY=your-project-key
```

1. **Bot token** — open [@BotFather](https://t.me/BotFather) in Telegram, send
   `/newbot`, and copy the token it gives you.
2. **Channel** — the runtime owns the Channel lifecycle even on the direct
   adapter path, so a Channel still has to exist in
   [CopilotKit Intelligence](https://intelligence.copilotkit.ai/). Create one and
   copy its Code into `CHANNEL_CODE`.

No Exa, Ambiguous, or Auth0 key is needed. This agent must never state a fact it
did not read out of its own database, so it has no web search at all.

```bash
npm run dev:telegram
```

The database is created and seeded on first run. Then open Telegram, find your
bot, and send `/start`.

## Try the flow

1. Send `/start`, then send `0501112233` — one of the seeded roster numbers.
   The account links and your progress appears.
2. Ask: **«Потрібна практика наступного тижня після 18:00»**. Check that the
   options are all in the evening and all have free seats.
3. Ask: **«Забронюй мене на першу»**. A confirmation card with a real Zoom link
   appears, and the booking count goes up.
4. Ask: **«Хочу на груповий менторинг як коуч»** for a session whose coach seat
   is taken. The agent should refuse and offer the roles that are actually free.
5. Book until you have met the requirement for one practice type, then try to
   book one more that is **more than 24 hours away**. It must be refused, with
   the time it becomes bookable. Try one **inside 24 hours** — it is allowed, and
   the card says it is beyond the requirement.
6. Ask to move a booking onto a full session. It fails and you keep the seat you
   had.

To see the whole sequence without a bot token or an API key:

```bash
npm run demo --workspace channel
```

That calls the real tools against a real database and prints each card through
the real Telegram renderer. It stands in only for the model choosing the tool.

## How it is put together

| Piece | File |
| --- | --- |
| Booking rules — capacity, duplicates, quota, 24-hour rule, roles | [src/domain.ts](src/domain.ts) |
| Schema and the constraints SQLite enforces itself | [src/db.ts](src/db.ts) |
| The agent's tools | [src/tools.tsx](src/tools.tsx) |
| Cards, built from data the tool just read | [src/components.tsx](src/components.tsx) |
| Telegram wiring and message handlers | [src/channel.tsx](src/channel.tsx) |
| One-hour reminder scheduler | [src/reminders.ts](src/reminders.ts) |
| Prompt | [src/prompt.ts](src/prompt.ts) |
| Kyiv time | [src/time.ts](src/time.ts) |
| Roster, practice types, demo sessions | [src/seed.ts](src/seed.ts) |
| Runtime lifecycle, seeding, scheduler startup | [src/server.ts](src/server.ts) |

### Where the line sits

The model handles intent, context, tool choice, and the sentence it replies
with. It decides nothing about whether a booking is allowed:

- **No tool takes a student id.** Every tool resolves the caller from the
  Telegram actor id stamped at ingress, so nothing the model writes can book a
  seat for somebody else.
- **The prompt contains no numbers.** Capacities, quotas, the 24-hour threshold
  and the role counts appear only in `domain.ts` and reach the model as tool
  results, so there is no second copy for it to reason from.
- **Cards are built by tools, not rendered by the model.** An agent-rendered
  component would take its contents from parameters the model writes; these take
  theirs from the rows that were just read.
- **SQLite enforces what SQLite can.** Partial unique indexes make a duplicate
  booking and a second coach impossible rather than merely unlikely, and every
  booking runs inside `BEGIN IMMEDIATE` so a capacity check cannot race an insert.

## Verify and limits

```bash
npm run verify                  # typecheck + tests, from the root
npm run demo --workspace channel  # the whole flow, rendered
```

49 tests cover the rules, the Kyiv conversions, the Telegram rendering, and the
reminder scheduler, all offline. Live Telegram delivery and model responses need
your own bot token and API key.

Known limits, all inherited from the Telegram adapter and recorded in
[SUBMISSION.md](../../SUBMISSION.md#known-limits):

- Conversation history is in-memory and is lost when the process restarts.
  Bookings are in SQLite and are not.
- Telegram has no modal surface, so linking is a typed phone number rather than
  a contact-share button.
- A single process holds the bot connection, so this cannot be deployed
  serverless.

[Channels skill](../../.agents/skills/build-channels-agent/SKILL.md) ·
[Channels guide](https://copilotkit.ai/channels-guide.md)
