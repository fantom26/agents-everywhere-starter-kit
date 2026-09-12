/** Facts injected into every run, so the model does not have to guess them. */
import type { Student } from "../../services/identity";
import { kyivDateKey } from "../../time";

/**
 * Injected every run so the model knows the caller is already identified.
 *
 * Without this, the only trace of a completed link is the conversation history,
 * which is in-memory and dies with the process — so after a restart the agent
 * would ask a student who linked last week for their phone number again. It is
 * narrative only: the tools still resolve the student from the Telegram actor
 * id, so nothing the model reads here can point a booking at someone else.
 */
export function callerContext(student: Student) {
  return {
    description: "Who you are talking to",
    value: `This Telegram account is already linked to ${student.fullName}. Never ask them for a phone number, and never call link_student_account for them.`,
  };
}

/** Injected every run so the agent can resolve "next week" without guessing. */
export function todayContext(now = new Date()) {
  return {
    description: "Today",
    value: `Today in Kyiv is ${kyivDateKey(now)}. All dates and times you pass to tools, and everything you tell the student, are Kyiv local time (Europe/Kyiv).`,
  };
}
