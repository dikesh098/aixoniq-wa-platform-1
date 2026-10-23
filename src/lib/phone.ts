import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/** Returns a valid E.164 number (e.g. +919876543210) or null. */
export function normalizePhone(raw: unknown, defaultCountry = 'IN'): string | null {
  let s = String(raw ?? '').trim();
  if (!s || /e\+?\d/i.test(s)) return null; // empty, or spreadsheet scientific notation (9.19E+11)
  s = s.replace(/[\s\-().]/g, '');
  if (/^00\d/.test(s)) s = `+${s.slice(2)}`;
  const p = parsePhoneNumberFromString(s, defaultCountry as CountryCode);
  return p && p.isValid() ? p.number : null;
}
