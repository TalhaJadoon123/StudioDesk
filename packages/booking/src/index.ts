/**
 * @studiodesk/booking - calendar, recurring series, waitlist and instructor
 * tooling. Pure logic on top of `@studiodesk/core`; no I/O beyond the repo.
 */

export * from './recurring.js';
export * from './calendar.js';
export * from './waitlist.js';
export * from './instructor.js';

import type { CoreContext, StudioDesk } from '@studiodesk/core';
import * as calendar from './calendar.js';
import * as recurring from './recurring.js';
import * as waitlist from './waitlist.js';
import * as instructor from './instructor.js';

export interface BookingModule {
  calendar: typeof calendar;
  recurring: typeof recurring;
  waitlist: typeof waitlist;
  instructor: typeof instructor;
}

export function createBookingModule(_ctx?: CoreContext | StudioDesk): BookingModule {
  return { calendar, recurring, waitlist, instructor };
}

export const booking = { calendar, recurring, waitlist, instructor };