# Practice Agent — a practice coordinator inside Telegram

**Telegram buttons + OpenAI + CopilotKit Channels + SQLite + Google Calendar**

Students at a coaching school have to complete a set number of educational
practices each year. Working out which ones they still need, which sessions have
a seat, whether a mentoring role is free, and whether they are even allowed to
take an extra session is more than a calendar can express — so it usually turns
into messages to a coordinator.

Practice Agent is that coordinator, living in the Telegram chat students already
use. **The whole product works by tapping buttons.** The AI is a second door onto
the same system, for students who would rather say what they want than tap
through to it.

```
/start                              «I need a practice next week after 18:00»

  Practice Agent                      → search_available_practices(…)
  Hi, Olena.                          ┌ Available sessions ─────────────────
  • Intermodule meeting — 1 / 6       │ 1. Intermodule meeting
                                      │    Sunday, 13 September, 18:30 (Kyiv)
  [📅 Find practice]                  │    Trainer: Serhii · 10 of 10 free
  [📊 My progress]                    └ [ 1. Sunday, 13 ] [ 2. Tuesday, 15 ]
  [📚 My bookings]
  [ℹ️ Information]                   Both buttons book through the same
                                      service, with the same rules.
```

Both doors meet in one place:

```
buttons ──→ router.tsx ──┐
                         ├──→ services.ts ──→ domain.ts ──→ SQLite
the agent ──→ tools.tsx ─┘
```

`domain.ts` owns every booking rule. `services.ts` adds identity and nothing
else. Neither door has a copy of a rule, and `parity.test.tsx` fails if one ever
grows one.

## Why Telegram

Remove Telegram and three things break. Nobody opens a booking website an hour
before a session, so the reminder — the feature that actually stops people
missing practices — has nowhere to arrive. "Book me for Wednesday" only resolves
because the options from the previous turn are still in the conversation. And the
student is already identified: they linked once, with Telegram's own contact
button, and never log in again.

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

**The model key is optional.** Leave `OPENAI_API_KEY` unset and every button
flow still works — finding, booking, progress, bookings, cancelling,
rescheduling, roles. Only free-text messages stop being answered.

Google Calendar is optional too; see the block in
[`.env.example`](../../.env.example). Without it the calendar entry does not
appear and nothing is written anywhere.

```bash
npm run dev:telegram
```

The database is created and seeded on first run. Then open Telegram, find your
bot, and send `/start`.

## Try the flow

Do the first six **with no `OPENAI_API_KEY` at all** — that is the point.

1. Send `/start`. Tap **📱 Share my phone number**. Telegram sends a verified
   number, the account links, and your progress appears.
2. Send `/start` again. You get the menu — **no phone number, ever again**.
   Restart the process and send it once more; still the menu.
3. **📅 Find practice → Group mentoring → This week**, then open a session whose
   coach seat is taken. `Coach ❌ occupied` is text; only the free roles are
   buttons. Tap **Join as Client**.
4. **📊 My progress** — the count went up. **📚 My bookings → Cancel → Yes** —
   it went back down.
5. Book intermodule meetings until the annual requirement is met, then try one
   more **more than 24 hours away**. Refused, with the time it becomes bookable.
   Try one **inside 24 hours** — allowed, and the card says it is beyond the
   requirement.
6. **📚 My bookings → Reschedule** onto the full session. It fails and you keep
   the seat you had.
7. Now add `OPENAI_API_KEY` and type **“Find me a practice next week after
   18:00”**. The options come back as the same card, and tapping one books
   through the same router as step 3.

To see the whole thing without a bot token or an API key:

```bash
npm run demo --workspace channel
```

That walks the button product first — menu, find, book, progress, cancel, the
mentoring roles screen — then the same system through the agent's tools, against
a real database, printed through the real Telegram renderer.

## How it is put together

| Piece | File |
| --- | --- |
| Booking rules — capacity, duplicates, quota, 24-hour rule, roles | [src/services/domain.ts](src/services/domain.ts) |
| Application services — the layer both doors call | [src/services/index.ts](src/services/index.ts) |
| Schema and the constraints SQLite enforces itself | [src/db/schema.ts](src/db/schema.ts) |
| Connections and transactions | [src/db/client.ts](src/db/client.ts) |
| Button payload grammar | [src/bot/callbacks.ts](src/bot/callbacks.ts) |
| Button screens | [src/bot/messages/screens.tsx](src/bot/messages/screens.tsx) |
| Button router: a tap in, a screen out | [src/bot/handlers/router.tsx](src/bot/handlers/router.tsx) |
| Contact sharing and callback routing, on the raw bot | [src/bot/handlers/telegram.ts](src/bot/handlers/telegram.ts) |
| The agent's tools | [src/agent/tools/](src/agent/tools/) |
| The agent and its brief | [src/agent/agent.ts](src/agent/agent.ts), [src/agent/prompt.ts](src/agent/prompt.ts) |
| Cards, built from data that was just read | [src/bot/messages/components.tsx](src/bot/messages/components.tsx) |
| Every user-facing string | [src/bot/messages/strings.ts](src/bot/messages/strings.ts) |
| Telegram wiring and message handlers | [src/bot/channel.tsx](src/bot/channel.tsx) |
| Google Calendar sync and the consent round trip | [src/services/calendar.ts](src/services/calendar.ts), [src/services/google-oauth.ts](src/services/google-oauth.ts) |
| One-hour reminder scheduler | [src/services/reminders.ts](src/services/reminders.ts) |
| Identity and phone normalisation | [src/services/identity.ts](src/services/identity.ts) |
| Kyiv time | [src/time.ts](src/time.ts) |
| Roster, practice types, demo sessions | [src/db/seed.ts](src/db/seed.ts) |
| Runtime lifecycle, seeding, OAuth routes, scheduler | [src/index.ts](src/index.ts) |
| Tests | [tests/](tests/) |

### Where the line sits

The model handles intent, context, tool choice, and the sentence it replies
with. It decides nothing about whether a booking is allowed — and it is not
required for anything:

- **Two doors, one rulebook.** Buttons and the agent both call `services.ts`.
  `parity.test.tsx` runs every refusal scenario through both and asserts the same
  machine reason, the same sentence to the student, and the same rows left
  behind.
- **No tool takes a student id.** Every tool resolves the caller from the
  Telegram actor id stamped at ingress, so nothing the model writes can book a
  seat for somebody else. No button payload names a student either.
- **The prompt contains no numbers.** Capacities, quotas, the 24-hour threshold
  and the role counts appear only in `domain.ts` and reach the model as tool
  results. The Information screen reads them from SQLite for the same reason.
- **Cards are built by whatever just read the data**, so a card cannot show a
  session, time, or free seat SQLite never returned.
- **An action a student cannot take is never a button.** A taken mentoring role
  is a line of text.
- **SQLite enforces what SQLite can.** Partial unique indexes make a duplicate
  booking and a second coach impossible rather than merely unlikely, and every
  booking runs inside `BEGIN IMMEDIATE` so a capacity check cannot race an
  insert.

### Why the buttons are routed by hand

`channel.onInteraction(id, fn)` matches callback ids by exact string equality,
which cannot express `book:17`, and a `<Button onClick>` is dispatched from an
in-process registry that does not survive a restart — under `npm run dev`'s
`--watch`, those buttons break on every file save. So buttons carry a `value`
only, and a grammY `callback_query` handler parses it. All navigation state
lives in the payload, so a card posted before a restart still works afterwards.

Cards are still authored as Channels JSX and rendered with `renderTelegram` —
the same path `reminders.ts` uses. Nothing here hand-builds Telegram JSON.

## Verify and limits

```bash
npm run verify                    # typecheck + tests, from the root
npm run demo --workspace channel  # the whole flow, rendered
```

106 tests cover the rules, both doors and their parity, the callback grammar,
the Kyiv conversions, linking, the calendar sync, and the Telegram rendering —
all offline. Live Telegram delivery, model responses and Google Calendar need
your own credentials.

Known limits:

- Conversation history is in-memory and is lost when the process restarts.
  Bookings, progress, the roster and the Telegram links are in SQLite and are
  not. Button navigation is stateless and survives a restart.
- Calendar sync is one-way and forward-only: bookings made before a student
  connected stay where they are.
- The Google consent page opens on the student's phone, so `PUBLIC_BASE_URL`
  must be reachable from it — a tunnel during a demo.
- A single process holds the bot connection, so this cannot be deployed
  serverless.

[Channels skill](../../.agents/skills/build-channels-agent/SKILL.md) ·
[Channels guide](https://copilotkit.ai/channels-guide.md)
