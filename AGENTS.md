# Notes for coding agents

This repository is **Practice Agent** — an AI practice coordinator that lives
inside Telegram. Students at a coaching school have an annual quota of
educational practices; the agent knows their progress and the available
sessions, applies the booking rules, and books the seat for them.

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

## Where the line sits

The model handles intent, context, tool choice, and the sentence it replies
with. It decides nothing about whether a booking is allowed. Preserve that:

- **All booking rules live in `src/domain.ts`** — capacity, duplicates, quota,
  the 24-hour window for extra bookings, mentoring roles. Never move a rule into
  the prompt, and never let the model decide an outcome a rule should decide.
- **`src/prompt.ts` contains no numbers.** No capacities, no quotas, no 24-hour
  threshold, no role counts. They reach the model only as tool results, so there
  is no second copy for it to reason from. Adding one is a regression.
- **No tool takes a student id.** Every tool resolves the caller from the
  Telegram actor id stamped at ingress (`ctx.actor.id`). A tool parameter naming
  a student would let "book Andriy in for Wednesday" work.
- **Cards are plain functions in `src/components.tsx`, built by the tool that
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
- Run `npm run verify` before claiming anything works, and
  `npm run demo --workspace channel` to check the booking rules by eye — it
  walks the whole flow against a real database with no credentials needed.
