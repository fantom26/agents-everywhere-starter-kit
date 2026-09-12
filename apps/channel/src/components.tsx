/**
 * The cards students actually see.
 *
 * These are plain functions, not `defineChannelComponent`, and that is
 * deliberate. An agent-rendered component takes its contents from parameters
 * the model writes, which would let the model put a time, a trainer, or a free
 * seat on screen that SQLite never said existed. Every card here is built by
 * the tool that just read the data, so what a student sees is what the database
 * holds. The model's job is the sentence around the card, not the card.
 *
 * On Telegram this JSX renders as HTML plus an inline keyboard; `<Fields>`
 * become bold labels and `<Actions>` become tappable buttons.
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

const ACCENT = {
  brand: "#2D6CDF",
  good: "#2E7D5B",
  warn: "#8A5C10",
  bad: "#C4145F",
} as const;

export const ROLE_LABEL: Record<Role, string> = {
  coach: "коуч",
  client: "клієнт",
  listener: "слухач",
};

/** "3 з 6 · залишилось 3" — the line a student wants at a glance. */
function progressLine(entry: Progress): string {
  const bar = "█".repeat(Math.min(entry.booked, entry.required)).padEnd(
    entry.required,
    "░",
  );
  const extra = entry.extra > 0 ? ` (+${entry.extra} понад норму)` : "";
  const tail = entry.complete ? "норму виконано" : `залишилось ${entry.remaining}`;
  return `${bar}  ${entry.booked} з ${entry.required} · ${tail}${extra}`;
}

export function progressCard(studentName: string, progress: Progress[]) {
  return (
    <Message accent={ACCENT.brand}>
      <Header>Прогрес: {studentName}</Header>
      {progress.map((entry) => (
        <Section>
          <Markdown>{`**${entry.title}**\n\`${progressLine(entry)}\``}</Markdown>
        </Section>
      ))}
      <Context>Бронювання зараховується як виконана практика.</Context>
    </Message>
  );
}

/** Free roles, written the way a student would ask about them. */
function rolesLine(found: Availability): string | undefined {
  if (found.roles.length === 0) return undefined;
  const free = found.roles.filter((role) => role.free > 0);
  if (free.length === 0) return "усі ролі зайняті";
  return free
    .map((role) =>
      role.seats > 1
        ? `${ROLE_LABEL[role.role]} (${role.free} з ${role.seats})`
        : ROLE_LABEL[role.role],
    )
    .join(", ");
}

function sessionSummary(found: Availability, now: Date): string {
  const roles = rolesLine(found);
  return [
    `**${found.type.title}**`,
    `${formatKyiv(found.session.startsAt)} (Київ) · ${formatLeadTime(now, found.session.startsAt)}`,
    `Тренер: ${found.session.trainer}`,
    `Вільно: ${found.free} з ${found.capacity}`,
    roles ? `Ролі: ${roles}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export type BookHandler = (
  sessionId: number,
  ctx: import("@copilotkit/channels").InteractionContext<string>,
) => Promise<void>;

/**
 * Search results, each with a one-tap booking button.
 *
 * The button carries only a session id; the click handler re-resolves the
 * student from the Telegram actor and re-runs every rule, so a stale card
 * cannot book a seat that has since filled up.
 */
export function sessionOptions(
  found: Availability[],
  now: Date,
  onBook?: BookHandler,
) {
  if (found.length === 0) {
    return (
      <Message accent={ACCENT.warn}>
        <Header>Нічого не знайшов</Header>
        <Section>
          <Markdown>
            За цими умовами вільних сесій немає. Спробуй інший час або ширший діапазон дат.
          </Markdown>
        </Section>
      </Message>
    );
  }

  return (
    <Message accent={ACCENT.brand}>
      <Header>Вільні сесії</Header>
      {found.map((session, index) => (
        <Section>
          <Markdown>{`${index + 1}. ${sessionSummary(session, now)}`}</Markdown>
        </Section>
      ))}
      <Divider />
      <Context>Час указано за Києвом. Натисни кнопку або просто напиши, що обираєш.</Context>
      {onBook && (
        <Actions>
          {found.slice(0, 6).map((session, index) => (
            <Button
              value={String(session.session.id)}
              style={index === 0 ? "primary" : undefined}
              onClick={async (ctx) => {
                await onBook(session.session.id, ctx);
              }}
            >
              {`${index + 1}. ${formatKyiv(session.session.startsAt).split(",")[0]}`}
            </Button>
          ))}
        </Actions>
      )}
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
      <Header>{found.type.title}</Header>
      <Fields>
        <Field label="Коли">{`${formatKyiv(found.session.startsAt)} (Київ)`}</Field>
        <Field label="Тренер">{found.session.trainer}</Field>
        <Field label="Місця">{`${found.free} вільних з ${found.capacity}`}</Field>
        {found.roles.length > 0 && <Field label="Ролі">{rolesLine(found) ?? "—"}</Field>}
      </Fields>
      {!bookable.ok && bookable.explanation && (
        <Section>
          <Markdown>{`⚠️ ${bookable.explanation}`}</Markdown>
        </Section>
      )}
      <Context>{`Починається ${formatLeadTime(now, found.session.startsAt)}`}</Context>
    </Message>
  );
}

export function bookingConfirmation(
  found: Availability,
  opts: { bookingId: number; role: Role | null; isExtra: boolean; now: Date },
) {
  return (
    <Message accent={ACCENT.good}>
      <Header>✅ Заброньовано</Header>
      <Fields>
        <Field label="Практика">{found.type.title}</Field>
        <Field label="Коли">{`${formatKyiv(found.session.startsAt)} (Київ)`}</Field>
        <Field label="Тренер">{found.session.trainer}</Field>
        {opts.role && <Field label="Роль">{ROLE_LABEL[opts.role]}</Field>}
        <Field label="Zoom">{found.session.zoomUrl}</Field>
      </Fields>
      {opts.isExtra && (
        <Section>
          <Markdown>
            Це бронювання **понад річну норму** — воно дозволене, бо до початку менше 24 годин і місце залишалось вільним.
          </Markdown>
        </Section>
      )}
      <Context>{`Бронювання #${opts.bookingId} · нагадаю за годину до початку`}</Context>
    </Message>
  );
}

export function bookingsCard(bookings: BookingView[], now: Date) {
  if (bookings.length === 0) {
    return (
      <Message accent={ACCENT.warn}>
        <Header>Немає активних бронювань</Header>
        <Section>
          <Markdown>Напиши, яка практика потрібна — підберу вільні сесії.</Markdown>
        </Section>
      </Message>
    );
  }
  return (
    <Message accent={ACCENT.brand}>
      <Header>Мої бронювання</Header>
      {bookings.map((booking) => (
        <Section>
          <Markdown>
            {[
              `**${booking.practiceTitle}**${booking.role ? ` · ${ROLE_LABEL[booking.role]}` : ""}`,
              `${formatKyiv(booking.session.startsAt)} (Київ) · ${formatLeadTime(now, booking.session.startsAt)}`,
              `Тренер: ${booking.session.trainer}`,
              `Бронювання #${booking.id}${booking.isExtra ? " · понад норму" : ""}`,
            ].join("\n")}
          </Markdown>
        </Section>
      ))}
      <Context>Щоб скасувати або перенести — просто напиши, яке саме.</Context>
    </Message>
  );
}

export function cancellationCard(booking: BookingView) {
  return (
    <Message accent={ACCENT.warn}>
      <Header>Бронювання скасовано</Header>
      <Fields>
        <Field label="Практика">{booking.practiceTitle}</Field>
        <Field label="Коли">{`${formatKyiv(booking.session.startsAt)} (Київ)`}</Field>
      </Fields>
      <Context>Місце звільнено, прогрес оновлено.</Context>
    </Message>
  );
}

export function rescheduleCard(from: BookingView, to: Availability, role: Role | null) {
  return (
    <Message accent={ACCENT.good}>
      <Header>🔄 Перенесено</Header>
      <Section>
        <Markdown>
          {`Було: ${formatKyiv(from.session.startsAt)}\n➡️ Стало: **${formatKyiv(to.session.startsAt)}** (Київ)`}
        </Markdown>
      </Section>
      <Fields>
        <Field label="Практика">{to.type.title}</Field>
        <Field label="Тренер">{to.session.trainer}</Field>
        {role && <Field label="Роль">{ROLE_LABEL[role]}</Field>}
        <Field label="Zoom">{to.session.zoomUrl}</Field>
      </Fields>
    </Message>
  );
}

/** Sent by the scheduler, one hour before the session starts. */
export function reminderCard(booking: BookingView) {
  return (
    <Message accent={ACCENT.brand}>
      <Header>⏰ Практика за годину</Header>
      <Fields>
        <Field label="Практика">{booking.practiceTitle}</Field>
        <Field label="Початок">{`${formatKyiv(booking.session.startsAt)} (Київ)`}</Field>
        <Field label="Тренер">{booking.session.trainer}</Field>
        {booking.role && <Field label="Твоя роль">{ROLE_LABEL[booking.role]}</Field>}
      </Fields>
      <Actions>
        <Button url={booking.session.zoomUrl}>Приєднатися в Zoom</Button>
      </Actions>
    </Message>
  );
}

export function welcomeMessage() {
  return (
    <Message accent={ACCENT.brand}>
      <Header>Practice Agent</Header>
      <Section>
        <Markdown>
          {"Я координатор практик. Знаю твій прогрес, розклад і правила бронювання — " +
            "просто напиши, що тобі потрібно.\n\n" +
            "_«Потрібна практика наступного тижня після 18:00»_\n" +
            "_«Скільки міжмодульних мені ще треба?»_\n" +
            "_«Перенеси мене на середу»_"}
        </Markdown>
      </Section>
      <Context>
        Щоб почати, надішли свій номер телефону — той, що є у списку студентів.
      </Context>
    </Message>
  );
}

export function linkedCard(studentName: string, progress: Progress[]) {
  return (
    <Message accent={ACCENT.good}>
      <Header>Вітаю, {studentName}!</Header>
      <Section>
        <Markdown>Акаунт підключено. Ось твій поточний прогрес:</Markdown>
      </Section>
      {progress.map((entry) => (
        <Section>
          <Markdown>{`**${entry.title}**\n\`${progressLine(entry)}\``}</Markdown>
        </Section>
      ))}
    </Message>
  );
}
