# Notes for coding agents

This repository is **Practice Agent** — a practice coordinator that lives inside
Telegram. Students at a coaching school have an annual quota of educational
practices; it knows their progress and the available sessions, applies the
booking rules, and books the seat for them.

The whole product works by tapping buttons, with no model involved. The AI is an
optional second door onto the same services.

Everything ships from [apps/channel](apps/channel/README.md). Read that README
first, then [SUBMISSION.md](SUBMISSION.md) for what was inherited from the
starter kit versus built during the hackathon.

`hackathon-overview.md`, `hackathon-rules.md`, and `using-sponsor-tools.md` are
the event's own documentation, kept for reference. They describe starter-kit
templates (`apps/web`, `apps/mobile`) and integrations (Exa, Ambiguous, Auth0)
that this project removed — do not follow their links expecting live code.

**Read `.agents/skills/build-channels-agent/SKILL.md` before touching anything in
`apps/channel/`.** It carries the verified Channels API surface; the most common
failure mode in this codebase is inventing a plausible-looking Channels API.

## Where things live

```
apps/channel/
├── src/
│   ├── bot/                  the button product — the door that needs no model
│   │   ├── channel.tsx       the Channel, the Telegram adapter, the wiring
│   │   ├── callbacks.ts      the button payload grammar
│   │   ├── handlers/         router.tsx (a tap in, a screen out), telegram.ts
│   │   ├── keyboards/        inline-keyboard construction
│   │   └── messages/         components.tsx, screens.tsx, strings.ts
│   ├── agent/                the second door
│   │   ├── agent.ts          the ChannelRunAgent and the factory
│   │   ├── prompt.ts         the brief — no numbers, ever
│   │   └── tools/            shared.ts, account, reads, booking, context
│   ├── services/             the layer both doors call
│   │   ├── index.ts          resolve the caller, hand off to domain
│   │   ├── domain.ts         every booking rule
│   │   ├── identity.ts       roster linking, phone normalisation
│   │   ├── calendar.ts       Google Calendar sync
│   │   ├── google-oauth.ts   the consent round trip
│   │   └── reminders.ts      the one-hour scheduler
│   ├── db/                   schema.ts, client.ts, seed.ts, index.ts
│   ├── time.ts               Kyiv time, DST-correct — used by every layer
│   ├── config.ts             required environment variables
│   ├── demo.tsx              the scripted walkthrough
│   └── index.ts              the process: runtime, OAuth routes, scheduler
└── tests/                    the suite, including the parity table
```

A dependency only ever points down this list: `bot/` and `agent/` both call
`services/`, `services/` calls `db/`, and nothing in `services/` or `db/` may
import from `bot/` or `agent/`. The one exception is user-facing text —
`services/calendar.ts` reads a practice title from `bot/messages/strings.ts`,
because that file is the single place any student-visible literal is allowed to
live.

## Two doors, one rulebook

Everything works by tapping buttons, with no model involved. The agent is a
second door onto the same services, for students who would rather say what they
want. Preserve that shape:

```
buttons ──→ bot/handlers/router.tsx ──┐
                                      ├──→ services/index.ts ──→ services/domain.ts ──→ SQLite
the agent ──→ agent/tools/ ───────────┘
```

- **`src/services/index.ts` is the only thing either door calls.** It resolves
  the caller and hands the request to `domain.ts` unchanged. It must never
  contain a rule; the router and the tools must never skip it.
- **`tests/parity.test.tsx` is the guard.** Every refusal scenario runs through both
  doors and asserts the same machine reason, the same sentence, the same rows.
  If you add a rule, add it to that table.
- **Buttons carry a `value` and never an `onClick`.** A closure-bound button is
  dispatched from an in-process registry that dies with the process — under
  `--watch` it breaks on every file save. The grammar is `src/bot/callbacks.ts`;
  payloads are parsed, not pre-registered, and all navigation state lives in the
  payload. A payload over 64 bytes is **dropped silently** by the renderer.
- **`channel.onInteraction` cannot route these** — it matches ids by exact
  string equality, so `book:17` has nowhere to land. Taps are read from the raw
  grammY bot in `src/bot/handlers/telegram.ts`, which is also where
  `request_contact`
  lives: the Channels vocabulary has no reply keyboard, and a shared contact
  never reaches the adapter at all.
- **A shared contact is only accepted when `contact.user_id` is the sender.**
  Telegram lets anyone forward a classmate's card.
- **An action a student cannot take is never a button.** A taken mentoring role
  is text.
- **No user-facing literal outside `src/bot/messages/strings.ts`.** Ukrainian is coming after
  the competition and that has to stay a one-file change.

## Where the line sits

The model handles intent, context, tool choice, and the sentence it replies
with. It decides nothing about whether a booking is allowed, and it is not
required for anything. Preserve that:

- **All booking rules live in `src/services/domain.ts`** — capacity, duplicates, quota,
  the 24-hour window for extra bookings, mentoring roles. Never move a rule into
  the prompt, into a screen, or into a tool, and never let the model decide an
  outcome a rule should decide.
- **Identity is resolved once, at ingress.** A student links their Telegram
  account once and `students.telegram_user_id` remembers it. Never add a flow
  that asks a linked student for a phone number — that was the bug this design
  exists to kill. `seedDatabase` carries links across a re-seed on purpose.
- **Google Calendar must never be able to fail a booking.** The sync runs after
  the SQLite commit and is not awaited. Unconfigured is a supported state.
- **`src/agent/prompt.ts` contains no numbers.** No capacities, no quotas, no 24-hour
  threshold, no role counts. They reach the model only as tool results, so there
  is no second copy for it to reason from. Adding one is a regression.
- **No tool takes a student id**, and no button payload names one. Every tool
  resolves the caller from the Telegram actor id stamped at ingress
  (`ctx.actor.id`); the router resolves it from the callback's sender. A
  parameter naming a student would let "book Andriy in for Wednesday" work.
- **Cards are plain functions in `src/bot/messages/components.tsx`, built by the tool that
  just read the data** — deliberately not `defineChannelComponent`. An
  agent-rendered component takes its contents from parameters the model writes,
  which would let it show a session, time, or free seat SQLite never returned.
- **SQLite enforces what SQLite can.** Partial unique indexes make a duplicate
  booking and a second coach impossible; bookings run inside `BEGIN IMMEDIATE`.

## Hard-won rules that are easy to get wrong here

- **`@ag-ui/client` must stay deduped.** The root `package.json` pins it via
  `overrides` to the exact version `@copilotkit/runtime` declares. Two copies
  produce two `AbstractAgent` types and every `createChannel({ agent })` fails
  on a private `_debug` property. If you bump `@copilotkit/runtime`, re-check
  `npm ls @ag-ui/client` and update the override.
- **`@copilotkit/channels` and `@copilotkit/runtime` are a tested pair.** Bump
  together, keep them exact.
- **Files containing JSX must be `.tsx`**, and the tsconfig must set
  `jsxImportSource: "@copilotkit/channels"`. This is not React. Running tests
  from the repo root instead of the workspace picks up the wrong tsconfig and
  fails with `React is not defined`.
- **JSX must be lowered before it is rendered.** `renderTelegram` takes the IR,
  not a JSX element: `renderTelegram(renderToIR(card))`. Passing `[card]`
  silently yields empty text.
- **`maxSteps` defaults to 1** on `BuiltInAgent`. Any agent with tools needs more,
  or it calls one tool and stops before seeing the result.
- **Do not add `identifyUser` to `CopilotRuntime`.** It belongs on
  `createChannel`, and must be absent on a Channels-only runtime.
- **Handlers return `void`.** `thread.post()` returns a `MessageRef`, so a
  concise arrow body fails under `strict`. Use a block body and `await`.
- **Never invent a component or prop.** The vocabulary is fixed — see
  `references/ui-components.md` in the skill. Telegram has no modal surface and
  no ephemeral messages.
- **Telegram markdown:** `*x*` renders italic, `**x**` bold. Raw HTML is escaped.
- **Telegram ignores `Button style` and `Message accent`, and skips `<Chart>`.**
  `<Select>`'s `onSelect` never fires there, `<Input>` renders as a hint line
  with no widget, modals do not exist, and `channel.onWelcome` never fires.
  `channel.onCommand("start")` is suppressed by the adapter — `/start` arrives at
  `onThreadStarted`, which is awaited inside grammY's poll loop, so keep it fast.
- Run `npm run verify` before claiming anything works, and
  `npm run demo --workspace channel` to check the booking rules by eye — it
  walks the button product and then the agent path against a real database with
  no credentials needed.
