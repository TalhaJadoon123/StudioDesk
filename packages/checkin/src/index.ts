/**
 * @studiodesk/checkin - QR tickets, geofenced mobile check-in, manual
 * front-desk check-in and kiosk/tablet mode.
 */

export * from './geo.js';
export * from './qr.js';
export * from './mobile.js';
export * from './manual.js';
export * from './checkin.js';
export * from './kiosk.js';

import type { CoreContext, StudioDesk } from '@studiodesk/core';
import * as geo from './geo.js';
import * as qr from './qr.js';
import * as mobile from './mobile.js';
import * as manual from './manual.js';
import * as checkin from './checkin.js';
import * as kiosk from './kiosk.js';

export interface CheckinModule {
  geo: typeof geo;
  qr: typeof qr;
  mobile: typeof mobile;
  manual: typeof manual;
  checkin: typeof checkin;
  kiosk: typeof kiosk;
}

export function createCheckinModule(_ctx?: CoreContext | StudioDesk): CheckinModule {
  return { geo, qr, mobile, manual, checkin, kiosk };
}

export const checkinModule = { geo, qr, mobile, manual, checkin, kiosk };