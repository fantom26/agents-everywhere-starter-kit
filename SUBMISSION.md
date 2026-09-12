# Submission — Practice Agent

Choose your city on the [global event page](https://aitinkerers.org/hackathons/global/agents-everywhere). Use that city's participant portal for the submission deadline and published judging criteria, and its handbook for eligibility and required deliverables. See [hackathon-rules.md](hackathon-rules.md) for the agent-readable summary.

> **Status:** the code is complete and verified offline — 143 tests, 0 failures.
> The live Telegram, model and Google Calendar checks in
> [Before recording](#before-recording) still need credentials and are **not yet
> done** — do not claim them until they are.

## Build eligibility

- [x] Our submitted project is a net-new build created during the official hackathon period
- [x] Its core functionality was built during the event; we are not resubmitting or extending a pre-existing project and entering it as new
- [x] We identify inherited templates, libraries, prompts, components, and starter code separately from our event work

### What we inherited

The [Agents, Everywhere starter kit](README.md), used as the handbook permits.
From it, unchanged or nearly so:

| Inherited | What it does | Our change |
|---|---|---|
| `packages/agent-core/` | Shared model adapter and `makeAgent` factory | trimmed to `makeAgent` + `resolveModel`; the incident prompt, Exa and Ambiguous capabilities, and the mobile prompt were removed once `apps/web` went |
| `apps/channel/src/agent.ts` — the `ChannelRunAgent` class | Gives each turn a fresh inner agent so Channels' re-entry guard is not tripped | none; we changed only the 6-line `makeChannelAgent` factory below it, to pass our prompt and switch the workplace MCP tools off |
| `apps/channel/src/agent-factory.test.tsx` | Tests that inherited class | none |
| `apps/channel/src/env.ts` | Required-variable helper | error text only |
| `apps/channel/src/server.ts` | Runtime lifecycle: teardown-before-listener ordering, `ready()`, the status gate | kept the structure; added seeding and the scheduler, and softened the status gate for the direct-adapter path |
| Root tooling | Workspaces, TypeScript config, the `@ag-ui/client` override | none |
| `@copilotkit/channels`, `@copilotkit/channels/telegram`, `@copilotkit/runtime` | The Channels engine, its Telegram adapter (grammY), and the runtime | used as published |
| `apps/web/`, `apps/mobile/` | The kit's other two templates | **removed** as unused, with their demo media and walkthrough docs — see the `chore: remove unused starter-kit templates` commit. Never part of this project. |

Launching or renaming the kit's incident demo would not be a project. We removed
it: the incident tools, cards, prompt, Exa search, and their tests are gone
(`git log` shows the deletions).

### What we built during the hackathon

Everything that makes this a practice coordinator. New files, ~2,300 lines:

| Built | What it is |
|---|---|
| `apps/channel/src/domain.ts` | **The core.** Every booking rule: capacity, duplicates, quota, the 24-hour rule, mentoring roles, progress, and transactional reschedule |
| `apps/channel/src/services.ts` | The application layer both doors call — identity in, domain out, no rules of its own |
| `apps/channel/src/db.ts` | SQLite schema and the constraints the database enforces itself |
| `apps/channel/src/callbacks.ts` | The button payload grammar: stateless, parsed rather than registered |
| `apps/channel/src/screens.tsx` | Every screen of the button product |
| `apps/channel/src/router.tsx` | A tap in, a screen out |
| `apps/channel/src/telegram-bot.ts` | Contact sharing and callback routing, on the adapter's own grammY bot |
| `apps/channel/src/tools.tsx` | The nine agent tools, thin over the services |
| `apps/channel/src/components.tsx` | The cards students see |
| `apps/channel/src/strings.ts` | Every user-facing string, in one collection |
| `apps/channel/src/identity.ts` | Roster linking and phone normalisation |
| `apps/channel/src/calendar.ts`, `google-oauth.ts` | Google Calendar sync and its consent round trip |
| `apps/channel/src/time.ts` | Kyiv-time conversion, DST-correct |
| `apps/channel/src/reminders.ts` | The one-hour reminder scheduler |
| `apps/channel/src/prompt.ts` | The agent's brief |
| `apps/channel/src/seed.ts` | Roster, practice types, demo sessions |
| `apps/channel/src/*.test.ts(x)` | 106 tests: the rules, both doors and their parity, the grammar, linking, the calendar, rendering |
| `apps/channel/src/demo.tsx` | Scripted walkthrough — the button product, then the same system through the agent |
| `apps/channel/src/channel.tsx` | **Rewritten.** Managed Slack → direct Telegram adapter |

## Title and description

**Practice Agent — an AI practice coordinator that lives inside Telegram.**

### What you built

A student sends `/start` and taps **Share my phone number** once. From then on
Telegram *is* the login: they are recognised on every later interaction and are
never asked again.

Then the whole product is buttons. Find practice → a type → this week → a
session → booked, with the session's own Zoom link on the confirmation. Progress,
bookings, cancel, reschedule, and a group-mentoring screen where a taken coach
seat is shown as text and only the free roles are tappable. **None of that calls
a model.** Unset `OPENAI_API_KEY` and every one of those flows still works.

The AI is the second door, for the same system. A student writes "I need a
practice next week after 18:00"; the agent searches real sessions, filters to
free seats after 18:00 Kyiv time, and posts the same card — whose buttons are
routed by the same router. "Book me for the first one" calls `book_practice`,
which goes through the same service as the button.

Every booking validates capacity, duplicates, the annual quota, the 24-hour rule
and mentoring roles before writing — in `domain.ts`, once. If the student has
connected Google Calendar, the booking appears there and a cancellation removes
it. An hour before the session, the bot messages them first.

### Who it is for

A student at a coaching school who has to complete a set number of educational
practices a year — six intermodule meetings, four trios, three group mentorings
— and currently has to work out from a spreadsheet and a coordinator's messages
which ones they still need and which sessions have room.

### Why the context matters

Remove Telegram and three things break:

1. **The reminder has nowhere to arrive.** Nobody opens a booking site an hour
   before a session. The reminder is the feature that stops people missing
   practices, and it only works because the bot can start a conversation.
2. **"Book me for Wednesday" stops resolving.** It is only meaningful because
   the options from the previous turn are still on screen. In a stateless form
   the student would have to name a session id.
3. **There is no login to replace.** Telegram already knows who this is, and its
   contact button hands over a *verified* phone number in one tap. A web app
   would need an account, a password reset and a session; here the student is
   identified once and never again.

A standalone chatbox would lose all three, and would still need the student to go
somewhere they do not otherwise go.

### Sponsor technologies used

| Sponsor | Visible contribution |
|---|---|
| **OpenAI** | The second door: parsing "next week after 18:00" into tool arguments, choosing the tool, and explaining a refusal in the student's own words. Optional by design — the product works without it |
| **CopilotKit** | Channels runs this in Telegram: its `@copilotkit/channels/telegram` adapter (grammY) handles ingress, and the JSX vocabulary renders every card and inline keyboard — for the button product as much as for the agent |
| **Google Calendar** | A booked practice appears in the student's own calendar and a cancelled one disappears, through a per-student OAuth grant |

Not used, deliberately: **Exa** (the agent must never state a fact it did not
read from its own database, so it has no web search at all), **Ambiguous AI**,
**Auth0** (Telegram is the identity: a student links once with a verified
contact, and `telegram_user_id` is the credential from then on).

## Evidence for the judging criteria

| Official criterion | Where to show it |
|---|---|
| Core Requirements & Functionality | The find → book → confirm flow **driven by buttons with the model switched off**, ending in a booking card with a real Zoom link and a progress count that went up. Then the same flow by typing a sentence. `npm run demo --workspace channel` prints both. |
| Innovation & Theme Alignment | Telegram as the login: one tap on Share my phone number, recognised forever after. Plus the reminder arriving unprompted and "cancel it" answered in the same thread. Then the contrast above. |
| Technical Execution & Integration | The refusal paths, and that they are identical on both doors — `parity.test.tsx` asserts it. Book beyond quota more than 24 hours out → refused with the time it becomes bookable. Move a booking onto a full session → refused, **and the original seat is kept**. |
| Usefulness & Agentic Experience | The group-mentoring screen: a taken coach seat is shown but not offered. Cancelling asks first. A booking lands in the student's real calendar. |

- [x] We distinguish live services, sample data, session-only state, and standalone recipes
- [ ] We can point to visible evidence for every criterion *(needs the live run below)*

### Where the line between agent and rules sits

Worth saying out loud in the demo, because it is the technical argument:

- **No tool takes a student id.** Every tool resolves the caller from the
  Telegram actor id stamped at ingress, so nothing the model writes can book a
  seat for somebody else.
- **The prompt contains no numbers.** Capacities, quotas, the 24-hour threshold
  and role counts exist only in `domain.ts` and reach the model as tool results.
- **Cards are built by tools, not rendered by the model**, so a card cannot show
  a session, time, or free seat that SQLite did not return.
- **SQLite enforces what SQLite can.** Partial unique indexes make a duplicate
  booking and a second coach impossible, not merely unlikely; bookings run inside
  `BEGIN IMMEDIATE` so a capacity check cannot race an insert.

## Public repository

- [x] A new participant can run the quickstart from a clean clone — see [apps/channel/README.md](apps/channel/README.md)
- [x] The README lists the credentials and separate processes required
- [x] `npm run verify` passes — 143 tests across both workspaces, 0 failures
- [x] `.env` is gitignored; no tokens in the repo
- [x] Sample data is labeled: the roster, practice types, and sessions in `seed.ts` are fictional, generated relative to seed time

### Quickstart

```bash
cp .env.example .env     # then fill in OPENAI_API_KEY, TELEGRAM_BOT_TOKEN,
                         # CHANNEL_CODE, INTELLIGENCE_API_KEY
npm ci
npm run dev:telegram     # seeds the database on first run
```

Then open Telegram, find your bot, send `/start`, and send `0501112233`.

## Verification status

**Verified, offline, on this machine:**

- `npm run verify` — 143 tests, 0 failures (37 agent-core, 106 channel)
- **Both doors are asserted to agree.** `parity.test.tsx` runs full capacity,
  duplicates, taken roles, a missing role, the quota and 24-hour rule, cancelling
  and a failed reschedule through the button router *and* the agent's tools, and
  asserts the same machine reason, the same sentence to the student, and the same
  rows left behind. It also asserts one account cannot touch another's booking.
- `npm run demo --workspace channel` — the button product first (menu → find →
  book → progress → bookings → cancel → the mentoring roles screen), then the
  same system through the tools: search → book → progress → role refusal → quota
  refusal beyond 24h → extra booking inside 24h → reschedule → failed reschedule
  with the seat kept → cancel → reminder with its Zoom button.
- Telegram rendering is checked against the adapter's real `renderTelegram`,
  including the 4096-character message cap and the 64-byte `callback_data` cap —
  an over-long payload is dropped *silently* by the adapter, so that one is a
  test rather than a hope.
- Calendar sync is driven against a fake Google: insert on booking, delete on
  cancellation, both on a move, and — the one that matters — a booking survives
  intact when Google is unreachable.

**Not yet verified — needs credentials we do not have in this checkout:**

- A real Telegram round-trip, including the contact-share button. The `.env` in
  this checkout has placeholder values (`OPENAI_API_KEY=stub-replace-me`), so no
  live model call or bot connection has been made.
- The model's tool selection. The walkthrough calls the tools in the order the
  agent is expected to choose; it does not prove the model chooses them.
- The live Google consent screen and a real calendar write.

### Before recording

1. Put a real `TELEGRAM_BOT_TOKEN`, `CHANNEL_CODE` and `INTELLIGENCE_API_KEY` in
   `.env`. **Leave `OPENAI_API_KEY` unset for the first pass** — that is how you
   prove the button product stands on its own.
2. `npm run dev:telegram`. Confirm the console prints `Practice Agent online`.
   A warning that the Channel is not `online` is survivable — Telegram ingress is
   this process's own long-poll — but the Channel Code is worth fixing first.
3. Run steps 1–6 of [Try the flow](apps/channel/README.md#try-the-flow) in the
   real Telegram client, with no model key. Check the contact button appears on
   the actual demo phone; if a client does not offer it, the typed number still
   works.
4. Add `OPENAI_API_KEY`, restart, and run step 7.
5. Optional, and only with a tunnel running: set `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET` and `PUBLIC_BASE_URL`, add your Google account as an
   OAuth test user, then connect from the menu and watch a booking appear in
   Google Calendar and vanish on cancellation.
6. For the reminder, seed fresh (`npm run seed` — it keeps your Telegram link
   now) and book the session that starts in three hours; the reminder fires an
   hour before it. To see it sooner without waiting, temporarily lower `leadMs`
   in `server.ts`.
7. Then tick the unchecked boxes above.

## Two-minute demo video

- [ ] `/start` → tap **Share my phone number** → recognised. Then `/start` again
      to show it never asks twice
- [ ] Book a practice **entirely with buttons**, saying out loud that the model
      is switched off
- [ ] Open a group-mentoring session: the taken coach seat is shown but not
      offered, and only free roles are tappable
- [ ] Show a refusal: book beyond quota more than 24 hours out, and let it
      explain when the seat becomes bookable. **This is the moment that shows the
      rules are real rather than suggested.**
- [ ] Now type «I need a practice next week after 18:00» and book by talking —
      same card, same rules, one service underneath
- [ ] Show the reminder arriving unprompted
- [ ] Say that OpenAI does the understanding, CopilotKit Channels puts it in
      Telegram, and neither of them decides whether a booking is allowed
- [ ] Keep within the event's limit and check audio

## Known limits

State these rather than letting a judge find them:

- **Conversation history is in-memory.** The Telegram adapter's conversation
  store does not survive a restart. Bookings, progress, the roster and the
  Telegram links are in SQLite and do.
- **Linking is Telegram's own contact button**, driven through the adapter's
  grammY bot — the Channels JSX vocabulary has no reply keyboard, and a shared
  contact never reaches the adapter at all. A forwarded contact card belonging to
  someone else is refused; so is a roster number already claimed by another
  Telegram account. A typed number remains as a fallback.
- **Calendar sync is one-way and forward-only.** Bookings made before a student
  connected Google are not backfilled, and we never read their calendar.
- **The Google consent screen is unverified**, so only accounts added as OAuth
  test users can connect. Fine for a demo, worth saying out loud.
- **Booking is progress.** There is no attendance system, so an active booking
  counts as a completed practice, and cancelling gives the seat back to the
  quota. Called out in the progress card.
- **Admin is seed-only.** A coordinator adds slots by editing `seed.ts` and
  re-seeding (which now keeps everyone's Telegram link). The brief ranked admin
  tenth; the student experience got the time.
- **Button navigation is stateless, deliberately.** A button on a card posted
  before a restart still resolves, because the screen is named in the payload
  rather than looked up in a map that died with the process.
- **One process, not serverless.** A Channel owns a long-lived connection, and
  the reminder scheduler needs to be running anyway.

## Social post and final submission

- [ ] Follow the organizer's posting and sponsor-tagging instructions
- [ ] Link the public repository and video
- [ ] Credit OpenAI and CopilotKit, plus applicable local partners
- [ ] Check the live integration once more before recording or submitting
- [ ] Inspect the repository, video and screenshots for secrets

Prepare the post and submission for a human to publish; nothing here publishes
either automatically.
