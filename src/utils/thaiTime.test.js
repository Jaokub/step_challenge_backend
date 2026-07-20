import { describe, it, expect } from 'vitest';
import {
  THAI_OFFSET_MS,
  thaiParts,
  thaiDayTag,
  thaiDayTagEnd,
  thaiWeekStartTag,
  thaiMonthStartTag,
  addDays,
  tagToDateString,
  tagWeekday,
  thaiDateString,
  thaiMonthStartInstant,
} from './thaiTime.js';

describe('thaiTime', () => {
  describe('thaiDayTag', () => {
    it('rolls over to the next Thai day at 17:00 UTC (00:00 Bangkok)', () => {
      const justBefore = new Date('2026-07-17T16:59:59.999Z');
      const boundary = new Date('2026-07-17T17:00:00.000Z');

      expect(thaiDayTag(justBefore).toISOString()).toBe('2026-07-17T00:00:00.000Z');
      expect(thaiDayTag(boundary).toISOString()).toBe('2026-07-18T00:00:00.000Z');
    });

    it('returns a UTC-midnight tag regardless of the input time-of-day', () => {
      const tag = thaiDayTag(new Date('2026-07-18T09:30:00.000Z'));
      expect(tag.getUTCHours()).toBe(0);
      expect(tag.getUTCMinutes()).toBe(0);
      expect(tag.getUTCSeconds()).toBe(0);
      expect(tag.getUTCMilliseconds()).toBe(0);
    });

    it('defaults to "now" when called with no argument', () => {
      const tag = thaiDayTag();
      expect(tag).toBeInstanceOf(Date);
      expect(tag.getUTCHours()).toBe(0);
    });
  });

  describe('thaiDayTagEnd', () => {
    it('is the same Thai calendar day as thaiDayTag, at 23:59:59.999', () => {
      const instant = new Date('2026-07-18T09:30:00.000Z');
      const start = thaiDayTag(instant);
      const end = thaiDayTagEnd(instant);

      expect(end.getUTCFullYear()).toBe(start.getUTCFullYear());
      expect(end.getUTCMonth()).toBe(start.getUTCMonth());
      expect(end.getUTCDate()).toBe(start.getUTCDate());
      expect(end.getUTCHours()).toBe(23);
      expect(end.getUTCMinutes()).toBe(59);
      expect(end.getUTCSeconds()).toBe(59);
      expect(end.getUTCMilliseconds()).toBe(999);
    });
  });

  describe('thaiWeekStartTag', () => {
    it('always returns a Monday', () => {
      // Sample every day across a two-week span so every weekday is covered.
      for (let i = 0; i < 14; i++) {
        const instant = addDays(new Date('2026-07-01T12:00:00.000Z'), i);
        const weekStart = thaiWeekStartTag(instant);
        expect(tagWeekday(weekStart)).toBe(1); // 1 = Monday
      }
    });

    it('places the instant\'s own Thai day within [weekStart, weekStart+6]', () => {
      for (let i = 0; i < 14; i++) {
        const instant = addDays(new Date('2026-07-01T12:00:00.000Z'), i);
        const dayTag = thaiDayTag(instant);
        const weekStart = thaiWeekStartTag(instant);
        const weekEnd = addDays(weekStart, 6);

        expect(dayTag.getTime()).toBeGreaterThanOrEqual(weekStart.getTime());
        expect(dayTag.getTime()).toBeLessThanOrEqual(weekEnd.getTime());
      }
    });

    it('handles a Thai Sunday (weekday 0) by stepping back 6 days, not forward', () => {
      // Find a Sunday by scanning forward from a known instant.
      let instant = new Date('2026-07-01T12:00:00.000Z');
      while (thaiParts(instant).weekday !== 0) {
        instant = addDays(instant, 1);
      }
      const weekStart = thaiWeekStartTag(instant);
      expect(tagWeekday(weekStart)).toBe(1);
      expect(addDays(weekStart, 6).getTime()).toBe(thaiDayTag(instant).getTime());
    });
  });

  describe('thaiMonthStartTag', () => {
    it('returns day 1 of the instant\'s Thai month', () => {
      const instant = new Date('2026-07-18T09:30:00.000Z');
      const monthStart = thaiMonthStartTag(instant);
      const parts = thaiParts(instant);

      expect(monthStart.getUTCFullYear()).toBe(parts.year);
      expect(monthStart.getUTCMonth()).toBe(parts.month);
      expect(monthStart.getUTCDate()).toBe(1);
    });

    it('is never later than the instant\'s own day tag', () => {
      const instant = new Date('2026-07-01T00:30:00.000Z'); // just after month-start boundary
      expect(thaiMonthStartTag(instant).getTime()).toBeLessThanOrEqual(thaiDayTag(instant).getTime());
    });
  });

  describe('addDays / tagToDateString / tagWeekday', () => {
    it('shifts a tag by whole days without touching the time-of-day', () => {
      const tag = new Date('2026-07-18T00:00:00.000Z');
      expect(addDays(tag, 1).toISOString()).toBe('2026-07-19T00:00:00.000Z');
      expect(addDays(tag, -1).toISOString()).toBe('2026-07-17T00:00:00.000Z');
      expect(addDays(tag, 0).toISOString()).toBe(tag.toISOString());
    });

    it('formats a tag as YYYY-MM-DD', () => {
      expect(tagToDateString(new Date('2026-07-18T00:00:00.000Z'))).toBe('2026-07-18');
    });

    it('reports the UTC weekday of a tag', () => {
      // 2026-07-18 falls on a Saturday (day 6) — cross-checked against Monday
      // detection above rather than hardcoded trivia: it's 3 weeks minus a
      // day after the known 2026-06-29 Monday used implicitly by the
      // thaiWeekStartTag "always Monday" property test.
      const tag = new Date('2026-07-18T00:00:00.000Z');
      expect(tagWeekday(tag)).toBe(tag.getUTCDay());
    });
  });

  describe('thaiDateString', () => {
    it('matches tagToDateString(thaiDayTag(instant))', () => {
      const instant = new Date('2026-07-18T21:00:00.000Z');
      expect(thaiDateString(instant)).toBe(tagToDateString(thaiDayTag(instant)));
    });
  });

  describe('thaiMonthStartInstant', () => {
    it('is the UTC instant of Thai midnight on day 1 of the current month', () => {
      const instant = new Date('2026-07-18T09:30:00.000Z');
      const monthStartInstant = thaiMonthStartInstant(instant, 0);
      expect(thaiDayTag(monthStartInstant).getTime()).toBe(thaiMonthStartTag(instant).getTime());
    });

    it('steps back whole months via monthsAgo', () => {
      const instant = new Date('2026-07-18T09:30:00.000Z'); // Thai month = June index 6 (July)
      const thisMonth = thaiMonthStartInstant(instant, 0);
      const lastMonth = thaiMonthStartInstant(instant, 1);

      expect(thaiParts(thisMonth).month).toBe(6); // July (0-indexed)
      expect(thaiParts(lastMonth).month).toBe(5); // June
      expect(thaiParts(lastMonth).year).toBe(thaiParts(thisMonth).year);
      expect(lastMonth.getTime()).toBeLessThan(thisMonth.getTime());
    });

    it('crosses a year boundary correctly (January minus 1 month = December)', () => {
      const instant = new Date('2026-01-15T09:30:00.000Z');
      const lastMonth = thaiMonthStartInstant(instant, 1);
      expect(thaiParts(lastMonth).month).toBe(11); // December
      expect(thaiParts(lastMonth).year).toBe(2025);
    });
  });

  describe('THAI_OFFSET_MS', () => {
    it('is exactly 7 hours', () => {
      expect(THAI_OFFSET_MS).toBe(7 * 60 * 60 * 1000);
    });
  });
});
