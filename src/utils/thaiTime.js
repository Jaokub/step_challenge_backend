/**
 * @module thaiTime
 * @description Centralised Thai-time (UTC+7) date helpers.
 *
 * The whole app operates in a single timezone: Thailand (Asia/Bangkok), which is
 * a fixed UTC+7 offset with no daylight-saving. Rather than relying on the host
 * machine's timezone (`process.env.TZ`), every "what day is it" computation goes
 * through these helpers so that "today", "this week", "this month", the health
 * `recordDate` bucket, and the check-in streak all agree on when a Thai calendar
 * day begins (00:00 Bangkok time).
 *
 * Two flavours of helper exist, because the schema has two kinds of date column:
 *
 *   • "tag" helpers  → for `@db.Date` columns (HealthRecord.recordDate), which
 *     Prisma stores as UTC-midnight of the calendar day. These return that
 *     UTC-midnight Date.
 *   • "instant" helpers → for real `DateTime` columns (checkedInAt, createdAt,
 *     activity.startDate). These return the actual UTC instant at which a Thai
 *     wall-clock boundary occurred.
 */

export const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Thai wall-clock calendar parts for a given instant.
 * @param {Date} instant
 * @returns {{ year: number, month: number, day: number, weekday: number }}
 */
export const thaiParts = (instant) => {
  const shifted = new Date(instant.getTime() + THAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(), // 0-indexed
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0 = Sunday
  };
};

// ─── @db.Date "tag" helpers ──────────────────────────────────────────────────

/** UTC-midnight tag of the Thai calendar day containing `instant`. */
export const thaiDayTag = (instant = new Date()) => {
  const { year, month, day } = thaiParts(instant);
  return new Date(Date.UTC(year, month, day));
};

/** End of the Thai calendar day (23:59:59.999 on that UTC date). */
export const thaiDayTagEnd = (instant = new Date()) => {
  const { year, month, day } = thaiParts(instant);
  return new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
};

/** UTC-midnight tag of the Monday that starts the Thai week containing `instant`. */
export const thaiWeekStartTag = (instant = new Date()) => {
  const { year, month, day, weekday } = thaiParts(instant);
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  return new Date(Date.UTC(year, month, day - mondayOffset));
};

/** UTC-midnight tag of the first day of the Thai month containing `instant`. */
export const thaiMonthStartTag = (instant = new Date()) => {
  const { year, month } = thaiParts(instant);
  return new Date(Date.UTC(year, month, 1));
};

/** Shift a UTC-midnight day tag by whole days (no DST in Thailand, so exact). */
export const addDays = (tag, days) => new Date(tag.getTime() + days * 24 * 60 * 60 * 1000);

/** YYYY-MM-DD string for a UTC-midnight day tag (or any Thai day tag). */
export const tagToDateString = (tag) => tag.toISOString().split('T')[0];

/** Weekday index (0 = Sunday) for a UTC-midnight day tag. */
export const tagWeekday = (tag) => tag.getUTCDay();

/** YYYY-MM-DD string of the Thai calendar day containing a real `instant`. */
export const thaiDateString = (instant) => tagToDateString(thaiDayTag(instant));

// ─── Real-instant helpers (for real DateTime columns) ────────────────────────

/**
 * The UTC instant at which the first day of a Thai month began.
 * @param {Date} instant - Any instant within the reference month.
 * @param {number} [monthsAgo=0] - How many Thai months before `instant` to use.
 */
export const thaiMonthStartInstant = (instant = new Date(), monthsAgo = 0) => {
  const { year, month } = thaiParts(instant);
  return new Date(Date.UTC(year, month - monthsAgo, 1) - THAI_OFFSET_MS);
};
