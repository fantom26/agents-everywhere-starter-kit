/**
 * The agent's tools.
 *
 * One tool per capability, grouped by what they do to the database: `account`
 * links a Telegram account to the roster, `reads` answers questions, `booking`
 * is the only path that writes a booking. The rules they all obey are
 * documented in `shared.ts`.
 */
import { linkStudentAccount } from "./account";
import {
  getMyProgress,
  getMyBookings,
  searchAvailablePractices,
  getPracticeDetails,
  listPracticeTypesTool,
} from "./reads";
import { bookPracticeTool, cancelBookingTool, rescheduleBookingTool } from "./booking";

export { linkStudentAccount };
export { getMyProgress, getMyBookings, searchAvailablePractices, getPracticeDetails, listPracticeTypesTool };
export { bookPracticeTool, cancelBookingTool, rescheduleBookingTool };
export { callerContext, todayContext } from "./context";

export const practiceTools = [
  linkStudentAccount,
  getMyProgress,
  getMyBookings,
  searchAvailablePractices,
  getPracticeDetails,
  bookPracticeTool,
  cancelBookingTool,
  rescheduleBookingTool,
  listPracticeTypesTool,
];
