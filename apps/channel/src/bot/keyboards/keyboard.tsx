/**
 * How buttons are laid out on a phone.
 *
 * The Telegram renderer packs every button of one `<Actions>` block into rows of
 * **eight**, and Telegram then shares the width of a row equally between them.
 * Seven buttons in a row means seven slivers, each showing "1....r" — the label
 * is elided in the middle and the screen becomes unreadable.
 *
 * Each `<Actions>` block is its own chunk, so a row is what one block contains.
 * That is the whole trick: to get rows of two, emit blocks of two.
 *
 * Every screen builds its keyboard through here rather than writing `<Actions>`
 * by hand, so no screen can accidentally go back to one long row.
 */
import { Actions, Button } from "@copilotkit/channels";

export type Key = {
  label: string;
  /** The callback payload — see `callbacks.ts`. Omitted for a link button. */
  value?: string;
  /** A link button instead: Telegram opens it, and it sends no callback. */
  url?: string;
};

/**
 * Lay out keys in rows of `perRow`.
 *
 * One per row is the default because most labels here carry a date and a time,
 * and a phone gives a row about 30 characters before it starts eliding.
 */
export function keyboard(keys: Key[], perRow = 1) {
  const rows: Key[][] = [];
  for (let i = 0; i < keys.length; i += perRow) rows.push(keys.slice(i, i + perRow));

  return rows.map((row) => (
    <Actions>
      {row.map((key) =>
        key.url ? (
          <Button url={key.url}>{key.label}</Button>
        ) : (
          <Button value={key.value}>{key.label}</Button>
        ),
      )}
    </Actions>
  ));
}
