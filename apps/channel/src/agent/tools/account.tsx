/** Putting a Telegram account against a name on the school roster. */
import { defineChannelTool } from "@copilotkit/channels";
import type { ChannelToolContext } from "@copilotkit/channels";
import { z } from "zod";
import { db } from "../../db";
import { getProgress } from "../../services/domain";
import * as services from "../../services";
import { linkedCard } from "../../bot/messages/components";

export const linkStudentAccount = defineChannelTool({
  name: "link_student_account",
  description:
    "Link this Telegram account to a student on the school roster, using a phone number the student typed. ONLY call this when another tool reports that the account is not linked, or when the student explicitly sends a phone number. A linked account stays linked — never ask a student who is already linked for their number again.",
  parameters: z.object({
    phone: z.string().describe("The phone number exactly as the student wrote it."),
  }),
  async handler({ phone }, ctx: ChannelToolContext) {
    const telegramUserId = ctx.actor?.id;
    if (!telegramUserId) return "Could not read the Telegram account id for this turn.";

    const result = services.linkByPhone(db(), telegramUserId, phone);
    if (!result.ok) return { linked: false, reason: result.reason, explanation: result.explanation };

    const progress = getProgress(db(), result.student.id);
    if (!result.alreadyLinked) {
      await ctx.thread.post(linkedCard(result.student.fullName, progress));
      return "Linked and posted a welcome card with the student's progress. Greet them by name in one short sentence and ask what they need — do not repeat the numbers on the card.";
    }
    return {
      linked: true,
      alreadyLinked: true,
      student: result.student.fullName,
      note: "This account was already linked. Just continue with what they asked.",
    };
  },
});
