/**
 * Number formatting for the HUD.
 *
 * A universe that spans 27 orders of magnitude needs a readout that never
 * shows "148000000000 m". Every value is reduced to two or three significant
 * figures in the largest unit that still reads as a *quantity* rather than a
 * label — the player should feel the difference between 400 m and 4 AU without
 * counting zeroes.
 *
 * Values are returned split into number and unit so the HUD can typeset them
 * differently (tabular numerals large, unit small and dim). That split is the
 * single biggest thing that makes a readout look designed instead of printed.
 */

const AU = 1.495978707e11;
const LY = 9.4607304725808e15;
const C = 299792458;

export interface Parts {
  v: string;
  u: string;
}

/** Two/one/zero decimals depending on magnitude — always ~3 sig figs. */
function sig(x: number): string {
  const a = Math.abs(x);
  if (a < 10) return x.toFixed(2);
  if (a < 100) return x.toFixed(1);
  return x.toFixed(0);
}

export function distanceParts(m: number): Parts {
  const a = Math.abs(m);
  if (!isFinite(a)) return { v: '—', u: '' };
  if (a < 10) return { v: a.toFixed(1), u: 'm' };
  if (a < 1000) return { v: a.toFixed(0), u: 'm' };
  if (a < 1e6) return { v: sig(a / 1000), u: 'km' };
  // Megametres bridge the awkward gap between "big on a planet" and "small in
  // a solar system" — 6.4 Mm is Earth's radius, which is a nice human anchor.
  if (a < 1e9) return { v: sig(a / 1e6), u: 'Mm' };
  if (a < LY * 0.25) return { v: sig(a / AU), u: 'AU' };
  return { v: sig(a / LY), u: 'ly' };
}

export function formatDistance(m: number): string {
  const p = distanceParts(m);
  return p.u ? `${p.v} ${p.u}` : p.v;
}

export function speedParts(mps: number): Parts {
  const a = Math.abs(mps);
  if (!isFinite(a)) return { v: '—', u: '' };
  if (a < 100) return { v: a.toFixed(1), u: 'm/s' };
  if (a < 1000) return { v: a.toFixed(0), u: 'm/s' };
  if (a < 1e6) return { v: sig(a / 1000), u: 'km/s' };
  if (a < C * 0.02) return { v: sig(a / 1e6), u: 'Mm/s' };
  return { v: (a / C).toFixed(2), u: 'c' };
}

/**
 * Vitals hand us a temperature without a unit. Anything above ~150 can only
 * sanely be Kelvin (a habitable surface in °C never is), so convert; below
 * that, assume it is already Celsius.
 */
export function temperatureParts(t: number): Parts {
  const c = t > 150 ? t - 273.15 : t;
  return { v: (Math.abs(c) < 10 ? c.toFixed(1) : c.toFixed(0)).replace('-0', '0'), u: '°C' };
}

export function percentParts(frac01: number): Parts {
  return { v: Math.round(Math.max(0, Math.min(1, frac01)) * 100).toFixed(0), u: '%' };
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function cardinal(headingDeg: number): string {
  const h = ((headingDeg % 360) + 360) % 360;
  return CARDINALS[Math.round(h / 45) % 8];
}
