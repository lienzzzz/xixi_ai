import { randomUUID } from 'node:crypto';

/**
 * Identifier factories. Prefixes are part of the contract: JSON Schemas pin
 * them with a pattern, so an id minted anywhere else fails validation loudly
 * instead of entering the event log with a foreign shape.
 */
export const newEventId = (): string => `evt_${randomUUID()}`;
export const newCorrelationId = (): string => `corr_${randomUUID()}`;
export const newSessionId = (): string => `sess_${randomUUID()}`;

/** Format an instant as ISO-8601 with an explicit numeric offset (never `Z`). */
export function toOffsetIso(date: Date = new Date(), offsetMinutes: number = -date.getTimezoneOffset()): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${shifted.toISOString().slice(0, 23)}${sign}${hours}:${minutes}`;
}
