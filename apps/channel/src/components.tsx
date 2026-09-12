/**
 * The cards students actually see.
 *
 * These are plain functions, not `defineChannelComponent`, and that is
 * deliberate. An agent-rendered component takes its contents from parameters
 * the model writes, which would let the model put a time, a trainer, or a free
 * seat on screen that SQLite never said existed. Every card here is built by
 * the tool or screen that just read the data, so what a student sees is what
 * the database holds. The model's job is the sentence around the card, not the
 * card.
 *
 * On Telegram this JSX renders as HTML plus an inline keyboard; `<Fields>`
 * become bold labels and `<Actions>` become tappable buttons.
 *
 * **Buttons carry a `value` and never an `onClick`.** A closure-bound button is
 * dispatched from an in-process registry that does not survive a restart — the
 * click then silently does nothing. A `value` becomes the Telegram
 * `callback_data` verbatim, which `router.tsx` parses, so a card posted before a
 * restart still works afterwards. See `callbacks.ts` for the grammar.
 *
 * Every visible string comes from `strings.ts`. Do not add a literal here.
 */
import {
  Message,
  Header,
  Section,
  Markdown,
  Fields,
  Field,
  Context,
  Divider,
  Actions,
  Button,
} from "@copilotkit/channels";
import type { Availability, BookingView, Progress, Role } from "./domain";
import { formatKyiv, formatLeadTime } from "./time";
import { t, practiceTitle, roleName } from "./strings";
import { cb } from "./callbacks";

const ACCENT = {
  brand: "#2D6CDF",
  good: "#2E7D5B",
  warn: "#8A5C10",
  bad: "#C4145F",
} as const;

/** "████░░  4 / 6 · 2 to go" — the line a student wants at a glance. */
function progressLine(entry: Progress): string {
  const bar = "█".repeat(Math.min(entry.booked, entry.required)).padEnd(entry.required, "░");
  const extra = entry.extra > 0 ? t.progress.extra(entry.extra) : "";
  const tail = entry.complete ? t.progress.complete : t.progress.remaining(entry.remaining);
  return `${bar}  ${t.progress.line(entry.booked, entry.required)} · ${tail}${extra}`;
}

export function progressCard(studentName: string, progress: Progress[]) {
  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.progress.header(studentName)}</Header>
      {progress.map((entry) => (
        <Section>
          <Markdown>{`**${practiceTitle(entry.code, entry.title)}**\n\`${progressLine(entry)}\``}</Markdown>
        </Section>
      ))}
      <Context>{t.progress.note}</Context>
      <Actions>
        <Button value={cb.menu()}>{t.menu.back}</Button>
      </Actions>
    </Message>
  );
}

/** Free roles, written the way a student would ask about them. */
function rolesLine(found: Availability): string | undefined {
  if (found.roles.length === 0) return undefined;
  const free = found.roles.filter((role) => role.free > 0);
  if (free.length === 0) return t.roles.noneFree;
  return free
    .map((role) =>
      role.seats > 1
        ? `${roleName(role.role)} (${role.free}/${role.seats})`
        : roleName(role.role),
    )
    .join(", ");
}

function sessionSummary(found: Availability, now: Date): string {
  const roles = rolesLine(found);
  return [
    `**${practiceTitle(found.type.code, found.type.title)}**`,
    `${formatKyiv(found.session.startsAt)} (Kyiv) · ${formatLeadTime(now, found.session.startsAt)}`,
    t.find.trainer(found.session.trainer),
    t.find.freeSeats(found.free, found.capacity),
    roles ? t.info.rolesLine(roles) : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The short label an option button carries: "1. Tue 15 Sep". */
function optionLabel(index: number, found: Availability): string {
  return `${index + 1}. ${formatKyiv(found.session.startsAt).split(",").slice(0, 2).join(",").trim()}`;
}

/**
 * Search results, each with a one-tap booking button.
 *
 * The button carries only a session id; the router re-resolves the student from
 * the Telegram actor and re-runs every rule, so a stale card cannot book a seat
 * that has since filled up.
 *
 * `back` is the callback the "Back" button returns to — the screen that asked
 * for this list. The AI path has no screen behind it, so it passes the menu.
 */
export function sessionOptions(
  found: Availability[],
  now: Date,
  opts: { back?: string } = {},
) {
  const back = opts.back ?? cb.menu();

  if (found.length === 0) {
    return (
      <Message accent={ACCENT.warn}>
        <Header>{t.find.slotsHeader}</Header>
        <Section>
          <Markdown>{t.find.empty}</Markdown>
        </Section>
        <Actions>
          <Button value={back}>{t.menu.back}</Button>
        </Actions>
      </Message>
    );
  }

  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.find.slotsHeader}</Header>
      {found.map((session, index) => (
        <Section>
          <Markdown>{`${index + 1}. ${sessionSummary(session, now)}`}</Markdown>
        </Section>
      ))}
      <Divider />
      <Context>{t.find.kyivNote}</Context>
      <Actions>
        {found.slice(0, 6).map((session, index) => (
          <Button
            value={
              // A role-based practice needs the role picked first, so its button
              // opens the session rather than booking it outright.
              session.type.roleBased
                ? cb.session(session.session.id)
                : cb.book(session.session.id)
            }
          >
            {optionLabel(index, session)}
          </Button>
        ))}
        <Button value={back}>{t.menu.back}</Button>
      </Actions>
    </Message>
  );
}

export function sessionDetailCard(
  found: Availability,
  now: Date,
  bookable: { ok: boolean; explanation?: string },
) {
  return (
    <Message accent={bookable.ok ? ACCENT.good : ACCENT.warn}>
      <Header>{practiceTitle(found.type.code, found.type.title)}</Header>
      <Fields>
        <Field label={t.booked.when}>{`${formatKyiv(found.session.startsAt)} (Kyiv)`}</Field>
        <Field label={t.booked.trainerLabel}>{found.session.trainer}</Field>
        <Field label={t.booked.seats}>{t.find.freeSeats(found.free, found.capacity)}</Field>
        {found.roles.length > 0 && (
          <Field label={t.booked.rolesLabel}>{rolesLine(found) ?? "—"}</Field>
        )}
      </Fields>
      {!bookable.ok && bookable.explanation && (
        <Section>
          <Markdown>{`⚠️ ${bookable.explanation}`}</Markdown>
        </Section>
      )}
      <Context>{formatLeadTime(now, found.session.startsAt)}</Context>
    </Message>
  );
}

export function bookingConfirmation(
  found: Availability,
  opts: { bookingId: number; role: Role | null; isExtra: boolean; now: Date },
) {
  return (
    <Message accent={ACCENT.good}>
      <Header>{t.booked.header}</Header>
      <Fields>
        <Field label={t.booked.practice}>
          {practiceTitle(found.type.code, found.type.title)}
        </Field>
        <Field label={t.booked.when}>{`${formatKyiv(found.session.startsAt)} (Kyiv)`}</Field>
        <Field label={t.booked.trainerLabel}>{found.session.trainer}</Field>
        {opts.role && <Field label={t.booked.roleLabel}>{roleName(opts.role)}</Field>}
        <Field label={t.booked.zoom}>{found.session.zoomUrl}</Field>
      </Fields>
      {opts.isExtra && (
        <Section>
          <Markdown>{t.booked.extraNote}</Markdown>
        </Section>
      )}
      <Context>{t.booked.reminderNote(opts.bookingId)}</Context>
      <Actions>
        <Button value={cb.bookings()}>{t.menu.bookings}</Button>
        <Button value={cb.menu()}>{t.menu.back}</Button>
      </Actions>
    </Message>
  );
}

/**
 * The student's upcoming bookings.
 *
 * `withActions` adds a Cancel/Reschedule pair per booking. The AI path posts the
 * same card, so a student who asked by typing gets the same buttons as one who
 * arrived through the menu.
 */
export function bookingsCard(bookings: BookingView[], now: Date, opts: { withActions?: boolean } = {}) {
  if (bookings.length === 0) {
    return (
      <Message accent={ACCENT.warn}>
        <Header>{t.bookings.header}</Header>
        <Section>
          <Markdown>{t.bookings.empty}</Markdown>
        </Section>
        <Actions>
          <Button value={cb.find()}>{t.menu.find}</Button>
          <Button value={cb.menu()}>{t.menu.back}</Button>
        </Actions>
      </Message>
    );
  }

  const withActions = opts.withActions ?? true;

  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.bookings.header}</Header>
      {bookings.map((booking, index) => (
        <Section>
          <Markdown>
            {[
              `${index + 1}. **${practiceTitle(booking.session.practiceTypeCode, booking.practiceTitle)}**${
                booking.role ? ` · ${roleName(booking.role)}` : ""
              }`,
              `${formatKyiv(booking.session.startsAt)} (Kyiv) · ${formatLeadTime(now, booking.session.startsAt)}`,
              t.find.trainer(booking.session.trainer),
              `${t.bookings.bookingId(booking.id)}${booking.isExtra ? ` · ${t.bookings.extra}` : ""}`,
            ].join("\n")}
          </Markdown>
        </Section>
      ))}
      <Context>{t.find.kyivNote}</Context>
      {withActions && (
        <Actions>
          {bookings.slice(0, 3).flatMap((booking, index) => [
            <Button value={cb.cancelAsk(booking.id)}>
              {`${index + 1}. ${t.bookings.cancel}`}
            </Button>,
            <Button value={cb.reschedule(booking.id)}>
              {`${index + 1}. ${t.bookings.reschedule}`}
            </Button>,
          ])}
          <Button value={cb.menu()}>{t.menu.back}</Button>
        </Actions>
      )}
    </Message>
  );
}

export function cancellationCard(booking: BookingView) {
  return (
    <Message accent={ACCENT.warn}>
      <Header>{t.cancelled.header}</Header>
      <Fields>
        <Field label={t.booked.practice}>
          {practiceTitle(booking.session.practiceTypeCode, booking.practiceTitle)}
        </Field>
        <Field label={t.booked.when}>{`${formatKyiv(booking.session.startsAt)} (Kyiv)`}</Field>
      </Fields>
      <Context>{t.cancelled.note}</Context>
      <Actions>
        <Button value={cb.find()}>{t.menu.find}</Button>
        <Button value={cb.menu()}>{t.menu.back}</Button>
      </Actions>
    </Message>
  );
}

export function rescheduleCard(from: BookingView, to: Availability, role: Role | null) {
  return (
    <Message accent={ACCENT.good}>
      <Header>{t.rescheduled.header}</Header>
      <Section>
        <Markdown>
          {`${t.rescheduled.from(formatKyiv(from.session.startsAt))}\n➡️ ${t.rescheduled.to(formatKyiv(to.session.startsAt))}`}
        </Markdown>
      </Section>
      <Fields>
        <Field label={t.booked.practice}>{practiceTitle(to.type.code, to.type.title)}</Field>
        <Field label={t.booked.trainerLabel}>{to.session.trainer}</Field>
        {role && <Field label={t.booked.roleLabel}>{roleName(role)}</Field>}
        <Field label={t.booked.zoom}>{to.session.zoomUrl}</Field>
      </Fields>
      <Actions>
        <Button value={cb.bookings()}>{t.menu.bookings}</Button>
        <Button value={cb.menu()}>{t.menu.back}</Button>
      </Actions>
    </Message>
  );
}

/** Sent by the scheduler, one hour before the session starts. */
export function reminderCard(booking: BookingView) {
  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.reminder.header}</Header>
      <Fields>
        <Field label={t.reminder.practice}>
          {practiceTitle(booking.session.practiceTypeCode, booking.practiceTitle)}
        </Field>
        <Field label={t.reminder.starts}>{`${formatKyiv(booking.session.startsAt)} (Kyiv)`}</Field>
        <Field label={t.reminder.trainerLabel}>{booking.session.trainer}</Field>
        {booking.role && <Field label={t.reminder.yourRole}>{roleName(booking.role)}</Field>}
      </Fields>
      <Actions>
        <Button url={booking.session.zoomUrl}>{t.reminder.join}</Button>
      </Actions>
    </Message>
  );
}

/** Shown to a Telegram account that is not on the roster yet. */
export function linkPrompt() {
  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.link.header}</Header>
      <Section>
        <Markdown>{t.link.intro}</Markdown>
      </Section>
      <Section>
        <Markdown>{t.link.ask}</Markdown>
      </Section>
      <Context>{t.link.typedFallback}</Context>
    </Message>
  );
}

export function linkedCard(studentName: string, progress: Progress[]) {
  return (
    <Message accent={ACCENT.good}>
      <Header>{t.link.welcomeHeader(studentName)}</Header>
      <Section>
        <Markdown>{t.link.linked}</Markdown>
      </Section>
      {progress.map((entry) => (
        <Section>
          <Markdown>{`**${practiceTitle(entry.code, entry.title)}**\n\`${progressLine(entry)}\``}</Markdown>
        </Section>
      ))}
    </Message>
  );
}

/** A refusal the student can act on, with a way back. */
export function refusalCard(message: string, back: string) {
  return (
    <Message accent={ACCENT.bad}>
      <Section>
        <Markdown>{`⚠️ ${message}`}</Markdown>
      </Section>
      <Actions>
        <Button value={back}>{t.menu.back}</Button>
      </Actions>
    </Message>
  );
}
