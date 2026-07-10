import { describe, expect, it } from 'vitest';
import { normalizeRfc822Date } from '../../src/adapters/dates';

describe('normalizeRfc822Date', () => {
  it('parses a well-formed RFC822 date', () => {
    expect(normalizeRfc822Date('Wed, 02 Oct 2002 08:00:00 GMT')).toBe('2002-10-02T08:00:00.000Z');
  });

  it('falls back to the generic Date parser instead of letting an out-of-range day roll over', () => {
    // day=32 would otherwise silently roll over into the next month via Date.UTC.
    // There is no other unambiguous way for `new Date(...)` to parse this string, so the
    // fallback also fails to produce a date and the function returns null.
    expect(normalizeRfc822Date('Wed, 32 Oct 2002 08:00:00 GMT')).toBeNull();
  });

  it('falls back instead of letting an out-of-range hour roll over to the next day', () => {
    expect(normalizeRfc822Date('Wed, 02 Oct 2002 25:00:00 GMT')).toBeNull();
  });

  it('falls back instead of letting an out-of-range minute roll over to the next hour', () => {
    expect(normalizeRfc822Date('Wed, 02 Oct 2002 08:60:00 GMT')).toBeNull();
  });

  it('does not silently roll an out-of-range second over into the next minute via Date.UTC', () => {
    // Date.UTC(2002, 9, 2, 8, 0, 60) would roll over to 08:01:00 -- the whole point of the
    // range check is to route this through fallbackParse (the generic `new Date(...)` parser)
    // instead, whatever that parser makes of the malformed string. Assert only that the
    // Date.UTC-style incorrect rollover does not happen.
    expect(normalizeRfc822Date('Wed, 02 Oct 2002 08:00:60 GMT')).not.toBe('2002-10-02T08:01:00.000Z');
  });

  it('still parses boundary-valid values (day 31, hour 23, minute/second 59)', () => {
    expect(normalizeRfc822Date('Thu, 31 Oct 2002 23:59:59 GMT')).toBe('2002-10-31T23:59:59.000Z');
  });
});
