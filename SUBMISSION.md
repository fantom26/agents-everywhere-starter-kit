# Submission — Practice Agent

Choose your city on the [global event page](https://aitinkerers.org/hackathons/global/agents-everywhere). Use that city's participant portal for the submission deadline and published judging criteria, and its handbook for eligibility and required deliverables. See [hackathon-rules.md](hackathon-rules.md) for the agent-readable summary.

> **Status:** the code is complete and verified offline. The live Telegram and
> model checks in [Before recording](#before-recording) still need a bot token
> and an API key, and are **not yet done** — do not claim them until they are.

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
| `apps/channel/src/db.ts` | SQLite schema and the constraints the database enforces itself |
| `apps/channel/src/tools.tsx` | The nine agent tools |
| `apps/channel/src/components.tsx` | The cards students see |
| `apps/channel/src/identity.ts` | Roster linking and phone normalisation |
| `apps/channel/src/time.ts` | Kyiv-time conversion, DST-correct |
| `apps/channel/src/reminders.ts` | The one-hour reminder scheduler |
| `apps/channel/src/prompt.ts` | The agent's brief |
| `apps/channel/src/seed.ts` | Roster, practice types, demo sessions |
| `apps/channel/src/domain.test.ts` | 37 tests for the rules |
| `apps/channel/src/telegram.test.tsx` | 12 tests for rendering and reminders |
| `apps/channel/src/demo.tsx` | Scripted walkthrough, rendered as Telegram would |
| `apps/channel/src/channel.tsx` | **Rewritten.** Managed Slack → direct Telegram adapter |

## Title and description

**Practice Agent — an AI practice coordinator that lives inside Telegram.**

### What you built

A student writes «Потрібна практика наступного тижня після 18:00». The agent
searches real sessions, filters to the ones with a free seat after 18:00 Kyiv
time, and shows them as a Telegram card with booking buttons. The student says
«Забронюй мене на першу»; the agent calls `book_practice`, which validates
capacity, duplicate bookings, the annual quota, the 24-hour rule, and mentoring
role availability before writing, and a confirmation card comes back with the
session's own Zoom link. An hour before the session, the agent messages them
first.

### Who it is for

A student at a coaching school who has to complete a set number of educational
practices a year — six intermodule meetings, four trios, three group mentorings
— and currently has to work out from a spreadsheet and a coordinator's messages
which ones they still need and which sessions have room.

### Why the context matters

Remove Telegram and two things break:

1. **The reminder has nowhere to arrive.** Nobody opens a booking site an hour
   before a session. The reminder is the feature that stops people missing
   practices, and it only works because the agent can start a conversation.
2. **"Book me for Wednesday" stops resolving.** It is only meaningful because
   the options from the previous turn are still on screen. In a stateless form
   the student would have to name a session id.

A standalone chatbox would lose both, and would still need the student to go
somewhere they do not otherwise go.

### Sponsor technologies used

| Sponsor | Visible contribution |
|---|---|
| **OpenAI** | The agent's understanding: parsing «наступного тижня після 18:00» into tool arguments, choosing the tool, and explaining a refusal in the student's language |
| **CopilotKit** | Channels runs the agent in Telegram: its `@copilotkit/channels/telegram` adapter (grammY) handles ingress, renders our JSX cards as Telegram HTML and inline keyboards, and routes button clicks |

Not used, deliberately: **Exa** (the agent must never state a fact it did not
read from its own database, so it has no web search at all), **Ambiguous AI**, **Auth0** (students authenticate by being a known
`telegram_user_id`).

## Evidence for the judging criteria

| Official criterion | Where to show it |
|---|---|
| Core Requirements & Functionality | The search → book → confirm flow in Telegram, ending in a booking card with a real Zoom link and a progress count that went up. `npm run demo --workspace channel` prints the whole sequence. |
| Innovation & Theme Alignment | The reminder arriving unprompted, and the student replying "cancel it" in the same thread. Then the contrast above: what a standalone chatbox loses. |
| Technical Execution & Integration | The refusal paths. Try to book beyond quota more than 24 hours out → refused with the time it becomes bookable. Try to move a booking onto a full session → refused, **and the original seat is kept** (`domain.test.ts`, "keeps the original booking when the new session is full"). |
| Usefulness & Agentic Experience | Progress card, options with buttons, and the agent asking which mentoring role before booking rather than guessing. |

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
- [x] `npm run verify` passes — 86 tests across both workspaces, 0 failures
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

- `npm run verify` — 86 tests, 0 failures (37 agent-core, 49 channel)
- `npm run demo --workspace channel` — the full sequence: link → search → book →
  progress → role refusal → quota refusal beyond 24h → extra booking inside 24h
  → reschedule → failed reschedule with the seat kept → cancel → reminder sent
  with its Zoom button. Cards render through the real Telegram renderer.
- Telegram rendering is checked against the adapter's real `renderTelegram`,
  including the 4096-character message cap and the 64-byte `callback_data` cap.

**Not yet verified — needs credentials we do not have in this checkout:**

- A real Telegram round-trip. The `.env` in this checkout has placeholder values
  (`OPENAI_API_KEY=stub-replace-me`), so no live model call or bot connection has
  been made.
- The model's tool selection. The walkthrough calls the tools in the order the
  agent is expected to choose; it does not prove the model chooses them.

### Before recording

1. Put a real `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `CHANNEL_CODE`, and
   `INTELLIGENCE_API_KEY` in `.env`.
2. `npm run dev:telegram`. Confirm the console prints `Practice Agent online`.
   A warning that the Channel is not `online` is survivable — Telegram ingress is
   this process's own long-poll — but the Channel Code is worth fixing first.
3. Run every step in [Try the flow](apps/channel/README.md#try-the-flow) in the
   real Telegram client.
4. For the reminder, seed fresh (`npm run seed`) and book the session that starts
   in three hours; the reminder fires an hour before it. To see it sooner without
   waiting, temporarily lower `leadMs` in `server.ts`.
5. Then tick the two unchecked boxes above.

## Two-minute demo video

- [ ] Open on the Telegram chat with earlier messages visible, before any prompt
- [ ] «Потрібна практика наступного тижня після 18:00» → options card
- [ ] «Забронюй мене на першу» → confirmation card with the real Zoom link
- [ ] Show a refusal: book beyond quota more than 24 hours out, and let the agent
      explain when it becomes bookable. **This is the moment that shows the rules
      are real rather than suggested.**
- [ ] Show the reminder arriving unprompted
- [ ] Say that OpenAI does the understanding and CopilotKit Channels puts it in
      Telegram
- [ ] Keep within the event's limit and check audio

## Known limits

State these rather than letting a judge find them:

- **Conversation history is in-memory.** The Telegram adapter's conversation
  store does not survive a restart. Bookings, progress, and the roster are in
  SQLite and do.
- **Linking is a typed phone number, not Telegram contact sharing.** A
  contact-share button is a Telegram reply-keyboard feature that the Channels JSX
  vocabulary does not express, and inventing a component is the documented way to
  break this SDK. A phone number typed in any common format is normalised and
  matched against the roster; a number already claimed by another Telegram
  account is refused rather than reassigned.
- **Booking is progress.** There is no attendance system, so an active booking
  counts as a completed practice, and cancelling gives the seat back to the
  quota. Called out in the progress card.
- **Admin is seed-only.** A coordinator adds slots by editing `seed.ts` and
  re-seeding. The brief ranked admin tenth; the student experience got the time.
- **Inline buttons are in-process.** A button on a card posted before a restart
  no longer resolves. Typing the request still works.
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
