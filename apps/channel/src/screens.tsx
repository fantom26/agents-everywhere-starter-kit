/**
 * The button UI's screens.
 *
 * Everything a student can do is reachable from `/start` without typing a word
 * and without a model ever being called. These functions are pure: data in,
 * JSX out. They read no database and decide nothing — `router.tsx` fetches
 * through `services.ts` and hands the result here.
 *
 * Two rules hold across the file:
 *
 * 1. **Buttons carry a `value` only** (see `callbacks.ts`). No `onClick`, so a
 *    tap still works after the process restarts.
 * 2. **An action a student cannot take is not a button.** A taken mentoring
 *    role is a line of text; only free roles get a tappable "Join as…".
 */
import { Message, Header, Section, Markdown, Context, Divider } from "@copilotkit/channels";
import type { Availability, BookingView, PracticeType, Progress } from "./domain";
import { cb, tokenFor, type TypeToken } from "./callbacks";
import { t, practiceTitle, roleName } from "./strings";
import { keyboard } from "./keyboard";
import { formatKyiv, formatKyivDayShort, formatKyivShort, formatLeadTime } from "./time";

const ACCENT = {
  brand: "#2D6CDF",
  good: "#2E7D5B",
  warn: "#8A5C10",
} as const;

/**
 * The root. Everything is at most three taps from here.
 *
 * `calendar` is omitted entirely when Google is not configured — an entry that
 * leads to "this is switched off" is worse than no entry.
 */
export function mainMenu(
  studentName: string,
  progress: Progress[],
  options: { calendar?: boolean } = {},
) {
  const outstanding = progress.filter((entry) => !entry.complete);
  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.appName}</Header>
      <Section>
        <Markdown>{t.menu.greeting(studentName)}</Markdown>
      </Section>
      {outstanding.length > 0 && (
        <Section>
          <Markdown>
            {outstanding
              .map(
                (entry) =>
                  `• ${practiceTitle(entry.code, entry.title)} — ${t.progress.line(entry.booked, entry.required)}`,
              )
              .join("\n")}
          </Markdown>
        </Section>
      )}
      <Context>{t.menu.hint}</Context>
      {keyboard([
        { label: t.menu.find, value: cb.find() },
        { label: t.menu.progress, value: cb.progress() },
        { label: t.menu.bookings, value: cb.bookings() },
        { label: t.menu.info, value: cb.info() },
        ...(options.calendar ? [{ label: t.calendar.menu, value: cb.calendar() }] : []),
      ])}
    </Message>
  );
}

/** Step one of finding a practice: which kind. */
export function typePicker(types: PracticeType[]) {
  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.menu.find}</Header>
      <Section>
        <Markdown>{t.find.chooseType}</Markdown>
      </Section>
      {keyboard([
        ...types.map((type) => ({
          label: practiceTitle(type.code, type.title),
          value: cb.findPeriod(tokenFor(type.code)),
        })),
        { label: t.find.allTypes, value: cb.findPeriod("all") },
      ])}
      {keyboard([{ label: t.menu.back, value: cb.menu() }])}
    </Message>
  );
}

/** Step two: when. */
export function periodPicker(type: TypeToken, title: string) {
  return (
    <Message accent={ACCENT.brand}>
      <Header>{title}</Header>
      <Section>
        <Markdown>{t.find.choosePeriod}</Markdown>
      </Section>
      {keyboard(
        [
          { label: t.find.thisWeek, value: cb.findSlots(type, "w") },
          { label: t.find.nextWeek, value: cb.findSlots(type, "n") },
        ],
        2,
      )}
      {keyboard([
        { label: t.find.pickDate, value: cb.findSlots(type, "d") },
        { label: t.menu.back, value: cb.find() },
      ], 2)}
    </Message>
  );
}

/**
 * "Pick a date" — only days that actually have a session.
 *
 * Offering an empty day would be a button whose only outcome is "nothing
 * found", so the picker is built from the search results themselves.
 */
export function datePicker(type: TypeToken, title: string, days: { key: string; at: Date }[]) {
  if (days.length === 0) {
    return (
      <Message accent={ACCENT.warn}>
        <Header>{title}</Header>
        <Section>
          <Markdown>{t.find.empty}</Markdown>
        </Section>
        {keyboard([{ label: t.menu.back, value: cb.findPeriod(type) }])}
      </Message>
    );
  }

  return (
    <Message accent={ACCENT.brand}>
      <Header>{title}</Header>
      <Section>
        <Markdown>{t.find.choosePeriod}</Markdown>
      </Section>
      {/* Dates are short, so three fit a row without eliding. */}
      {keyboard(
        days.slice(0, 9).map((day) => ({
          label: formatKyivDayShort(day.at),
          value: cb.findOnDate(type, day.key),
        })),
        3,
      )}
      {keyboard([{ label: t.menu.back, value: cb.findPeriod(type) }])}
    </Message>
  );
}

/**
 * One session without roles: everything known about it, and a way to take it.
 *
 * `refusal` is the answer to "why can't I book this?", already run through the
 * same rules a booking would hit. When it is set the Book button is gone —
 * offering a button whose only outcome is a refusal is worse than not offering
 * it at all.
 */
export function slotScreen(
  found: Availability,
  refusal: string | undefined,
  back: string,
  now: Date,
) {
  return (
    <Message accent={refusal ? ACCENT.warn : ACCENT.good}>
      <Header>{practiceTitle(found.type.code, found.type.title)}</Header>
      <Section>
        <Markdown>
          {[
            `${formatKyiv(found.session.startsAt)} (Kyiv) · ${formatLeadTime(now, found.session.startsAt)}`,
            t.find.trainer(found.session.trainer),
            t.find.freeSeats(found.free, found.capacity),
          ].join("\n")}
        </Markdown>
      </Section>
      {refusal && (
        <Section>
          <Markdown>{`⚠️ ${refusal}`}</Markdown>
        </Section>
      )}
      {keyboard([
        ...(refusal ? [] : [{ label: t.find.bookThis, value: cb.book(found.session.id) }]),
        { label: t.menu.back, value: back },
      ])}
    </Message>
  );
}

/**
 * One group-mentoring session, with its roles.
 *
 * This is the screen the brief singled out: a taken role is shown so the
 * student understands the session, but it is *text*. Only free roles are
 * tappable, so there is no way to ask for a seat that does not exist.
 */
export function roleScreen(found: Availability, back: string) {
  const free = found.roles.filter((role) => role.free > 0);

  return (
    <Message accent={free.length > 0 ? ACCENT.brand : ACCENT.warn}>
      <Header>{practiceTitle(found.type.code, found.type.title)}</Header>
      <Section>
        <Markdown>
          {[
            `${formatKyiv(found.session.startsAt)} (Kyiv) · ${formatLeadTime(new Date(), found.session.startsAt)}`,
            t.find.trainer(found.session.trainer),
          ].join("\n")}
        </Markdown>
      </Section>
      <Divider />
      <Section>
        <Markdown>
          {found.roles
            .map((role) => {
              const status =
                role.free <= 0
                  ? t.roles.occupied
                  : role.seats > 1
                    ? t.roles.placesLeft(role.free)
                    : t.roles.available;
              return `**${roleName(role.role)}** — ${status}`;
            })
            .join("\n")}
        </Markdown>
      </Section>
      {free.length === 0 && (
        <Section>
          <Markdown>{t.roles.noneFree}</Markdown>
        </Section>
      )}
      {keyboard(
        free.map((role) => ({
          label: t.roles.join(roleName(role.role)),
          value: cb.book(found.session.id, role.role),
        })),
      )}
      {keyboard([{ label: t.menu.back, value: back }])}
    </Message>
  );
}

/** Cancelling is one tap away from losing a seat, so it asks first. */
export function cancelConfirm(booking: BookingView) {
  return (
    <Message accent={ACCENT.warn}>
      <Header>{t.cancelled.confirmHeader}</Header>
      <Section>
        <Markdown>
          {[
            `**${practiceTitle(booking.session.practiceTypeCode, booking.practiceTitle)}**`,
            `${formatKyiv(booking.session.startsAt)} (Kyiv)`,
            booking.role ? `${t.booked.roleLabel}: ${roleName(booking.role)}` : undefined,
          ]
            .filter(Boolean)
            .join("\n")}
        </Markdown>
      </Section>
      {keyboard(
        [
          { label: t.cancelled.confirmYes, value: cb.cancelDo(booking.id) },
          { label: t.cancelled.confirmNo, value: cb.bookings() },
        ],
        2,
      )}
    </Message>
  );
}

/** Rescheduling: pick the period first, exactly like finding a practice. */
export function reschedulePeriodPicker(booking: BookingView) {
  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.bookings.reschedule}</Header>
      <Section>
        <Markdown>
          {[
            `**${practiceTitle(booking.session.practiceTypeCode, booking.practiceTitle)}**`,
            t.rescheduled.from(`${formatKyiv(booking.session.startsAt)} (Kyiv)`),
          ].join("\n")}
        </Markdown>
      </Section>
      {keyboard(
        [
          { label: t.find.thisWeek, value: cb.reschedulePeriod(booking.id, "w") },
          { label: t.find.nextWeek, value: cb.reschedulePeriod(booking.id, "n") },
        ],
        2,
      )}
      {keyboard([{ label: t.menu.back, value: cb.bookings() }])}
    </Message>
  );
}

/** The sessions a booking can move to — same practice type, by construction. */
export function rescheduleSlots(booking: BookingView, slots: Availability[]) {
  if (slots.length === 0) {
    return (
      <Message accent={ACCENT.warn}>
        <Header>{t.bookings.reschedule}</Header>
        <Section>
          <Markdown>{t.find.empty}</Markdown>
        </Section>
        {keyboard([{ label: t.menu.back, value: cb.reschedule(booking.id) }])}
      </Message>
    );
  }

  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.rescheduled.chooseNew}</Header>
      {slots.map((slot, index) => (
        <Section>
          <Markdown>
            {[
              `${index + 1}. ${formatKyiv(slot.session.startsAt)} (Kyiv)`,
              `${t.find.trainer(slot.session.trainer)} · ${t.find.freeSeats(slot.free, slot.capacity)}`,
            ].join("\n")}
          </Markdown>
        </Section>
      ))}
      <Context>{t.find.kyivNote}</Context>
      {keyboard(
        slots.slice(0, 6).map((slot, index) => ({
          label: `${index + 1} · ${formatKyivShort(slot.session.startsAt)}`,
          value: cb.rescheduleDo(booking.id, slot.session.id),
        })),
      )}
      {keyboard([{ label: t.menu.back, value: cb.reschedule(booking.id) }])}
    </Message>
  );
}

/**
 * The rules, read out of the database.
 *
 * Capacities, annual requirements and role counts are queried, never written
 * here — the same reason the prompt contains no numbers. If a coordinator
 * changes a requirement, this screen changes with it.
 */
export function infoScreen(types: PracticeType[]) {
  return (
    <Message accent={ACCENT.brand}>
      <Header>{t.info.header}</Header>
      {types.map((type) => (
        <Section>
          <Markdown>
            {[
              t.info.quota(
                practiceTitle(type.code, type.title),
                type.requiredPerYear,
                type.capacity,
              ),
              type.roles.length > 0
                ? t.info.rolesLine(
                    type.roles
                      .map((role) =>
                        role.seats > 1
                          ? `${roleName(role.role)} ×${role.seats}`
                          : roleName(role.role),
                      )
                      .join(", "),
                  )
                : undefined,
            ]
              .filter(Boolean)
              .join("\n")}
          </Markdown>
        </Section>
      ))}
      <Divider />
      <Section>
        <Markdown>{t.info.extraRule}</Markdown>
      </Section>
      <Section>
        <Markdown>{`${t.info.progressRule}\n${t.info.reminderRule}`}</Markdown>
      </Section>
      {keyboard([{ label: t.menu.back, value: cb.menu() }])}
    </Message>
  );
}

/**
 * Google Calendar: what it does, and the one-time consent link.
 *
 * The link is a URL button — Telegram opens it in a browser, the student
 * approves, and comes back. It is minted per tap and short-lived, so this screen
 * is rendered fresh rather than kept around.
 */
export function calendarScreen(state: {
  configured: boolean;
  connected: boolean;
  connectUrl?: string;
}) {
  return (
    <Message accent={state.connected ? ACCENT.good : ACCENT.brand}>
      <Header>{t.calendar.header}</Header>
      <Section>
        <Markdown>{state.configured ? t.calendar.what : t.calendar.unavailable}</Markdown>
      </Section>
      {state.connected && (
        <Section>
          <Markdown>{t.calendar.connected}</Markdown>
        </Section>
      )}
      {state.configured && !state.connected && <Context>{t.calendar.forwardOnly}</Context>}
      {keyboard([
        ...(!state.connected && state.connectUrl
          ? [{ label: t.calendar.connect, url: state.connectUrl }]
          : []),
        { label: t.menu.back, value: cb.menu() },
      ])}
    </Message>
  );
}
