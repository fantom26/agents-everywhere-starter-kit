<div align="center">

# Practice Agent

![Agents, Everywhere hackathon — OpenAI, CopilotKit, OpenRouter, Exa, Auth0, and Ambiguous AI](assets/banner.png)

**An AI practice coordinator that lives inside Telegram.**

[What it does](#what-it-does) · [Why Telegram](#why-telegram) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Submission](SUBMISSION.md)

</div>

## What it does

Students at a coaching school have to complete a set number of educational
practices each year — six intermodule meetings, four trios, three group
mentorings. Working out which ones they still need, which sessions have a free
seat, whether a mentoring role is taken, and whether they are even allowed to
book an extra session is more than a calendar can express. So it becomes
messages to a coordinator.

Practice Agent is that coordinator, in the Telegram chat students already use.

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

It also answers "how many intermodule meetings do I still need?", refuses a
mentoring role that is already taken, explains *why* a booking was refused, and
messages the student an hour before their session — in Kyiv time, unprompted.

## Why Telegram

Remove the surface and two things break:

1. **The reminder has nowhere to arrive.** Nobody opens a booking site an hour
   before a session. The reminder is what stops people missing practices, and it
   only works because the agent can start a conversation.
2. **"Book me for Wednesday" stops resolving.** It is only meaningful because
   the options from the previous turn are still on screen.

Telegram is not a transport here. It is what makes the interaction possible.

## Quickstart

Node.js 22+.

```bash
git clone <your-repo-url>
cd agents-everywhere-starter-kit
npm ci
cp .env.example .env
```

Fill in `.env`:

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-key          # https://platform.openai.com/api-keys
MODEL=gpt-5.6-sol

TELEGRAM_BOT_TOKEN=your-token    # @BotFather → /newbot
CHANNEL_CODE=your-channel-code   # https://intelligence.copilotkit.ai/
INTELLIGENCE_API_KEY=your-key
```

```bash
npm run dev:telegram             # seeds the database on first run
```

Open Telegram, find your bot, send `/start`, then send `0501112233` — one of the
seeded roster numbers. Full walkthrough in
[apps/channel/README.md](apps/channel/README.md#try-the-flow).

To see the entire flow with **no credentials at all**:

```bash
npm run demo
```

That drives the real tools against a real database and prints every card through
the real Telegram renderer. It stands in only for the model choosing the tool.

## How it works

The model handles intent, context, tool choice, and the reply. It decides
nothing about whether a booking is allowed:

- **Booking rules live in [`apps/channel/src/domain.ts`](apps/channel/src/domain.ts)** —
  capacity, duplicates, annual quota, the 24-hour window for extra bookings,
  mentoring roles, and a transactional reschedule that keeps the original seat
  when the new one turns out to be unbookable.
- **The prompt contains no numbers.** Capacities, quotas and thresholds reach
  the model only as tool results.
- **No tool takes a student id** — the caller comes from the Telegram actor id,
  so nothing the model writes can book a seat for someone else.
- **SQLite enforces what it can.** Partial unique indexes make a duplicate
  booking and a second coach impossible, not merely unlikely.

| Piece | File |
| --- | --- |
| Booking rules | [apps/channel/src/domain.ts](apps/channel/src/domain.ts) |
| Schema and constraints | [apps/channel/src/db.ts](apps/channel/src/db.ts) |
| Agent tools | [apps/channel/src/tools.tsx](apps/channel/src/tools.tsx) |
| Telegram wiring | [apps/channel/src/channel.tsx](apps/channel/src/channel.tsx) |
| Reminder scheduler | [apps/channel/src/reminders.ts](apps/channel/src/reminders.ts) |

## Verify

```bash
npm run verify   # typechecks + 86 offline tests across both workspaces
npm run demo     # the whole booking flow, rendered as Telegram
```

Live Telegram delivery and model responses need your own bot token and API key.
See [SUBMISSION.md](SUBMISSION.md#verification-status) for exactly what has and
has not been checked against live services.

## Built on

The [Agents, Everywhere starter kit](https://github.com/CopilotKit/agents-everywhere-starter-kit)
(AI Tinkerers global hackathon, September 2026). This project uses its
`apps/channel` template, retargeted from managed Slack to the CopilotKit
Channels **Telegram** adapter, and its shared model adapter. The kit's other two
templates and their integrations were removed; see
[SUBMISSION.md](SUBMISSION.md#what-we-inherited) for the inherited-versus-built
breakdown, and [AGENTS.md](AGENTS.md) if you are a coding agent working here.

**Sponsors used:** OpenAI (understanding, tool choice, natural-language replies)
and CopilotKit (Channels runs the agent inside Telegram).
