/**
 * Every icon in ÆON is drawn, not imported — one 24×24 grid, one stroke weight,
 * no fills. Restraint is the whole point: a marker has to read at 14 px against
 * a nebula without becoming a sticker on the screen.
 *
 * Paths are returned as raw SVG markup because they are written into a pooled
 * element exactly once, when its kind changes, and never touched again.
 */

export type TargetKind = 'planet' | 'moon' | 'star' | 'settlement' | 'ship' | 'waypoint' | 'creature' | 'anomaly';

const TARGET_GLYPHS: Record<TargetKind, string> = {
  // A disc with an oblique ring — reads as "world" instantly, even tiny.
  planet: '<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="9.2" ry="3" transform="rotate(-20 12 12)" opacity=".5"/>',
  // Crescent terminator, so a moon never gets confused with a planet.
  moon: '<circle cx="12" cy="12" r="4.4"/><path d="M14.9 8.6a4.4 4.4 0 0 0 0 6.8" opacity=".55"/>',
  // Four-point star: the diagonal spikes read as light, not as geometry.
  star: '<path d="M12 3.2 13.5 10.5 20.8 12 13.5 13.5 12 20.8 10.5 13.5 3.2 12 10.5 10.5Z"/>',
  // Hexagon + hearth dot: settled ground.
  settlement: '<path d="M12 4.4 18.6 8.2v7.6L12 19.6 5.4 15.8V8.2Z"/><circle cx="12" cy="12" r="1.15" opacity=".7"/>',
  // Delta wing.
  ship: '<path d="M12 4.2 18.8 18.6 12 15.1 5.2 18.6Z"/>',
  // Plain rhombus — the neutral "you chose this" glyph.
  waypoint: '<path d="M12 4.4 19.6 12 12 19.6 4.4 12Z"/>',
  // A bird's silhouette: organic, obviously alive, obviously not a machine.
  creature: '<path d="M4.4 14.2c2.9.3 5-1.1 7.6-4 2.6 2.9 4.7 4.3 7.6 4"/><path d="M12 10.2v4.4" opacity=".45"/>',
  // Broken ring: something here does not obey the rules.
  anomaly: '<circle cx="12" cy="12" r="6.6" stroke-dasharray="1.7 3.3"/><circle cx="12" cy="12" r="1.4"/>',
};

/** Corner ticks framing an important target — a reticle, not a badge. */
export const TARGET_TICKS =
  '<g opacity=".85"><path d="M3.4 7.6V3.4h4.2"/><path d="M20.6 7.6V3.4h-4.2"/>' +
  '<path d="M3.4 16.4v4.2h4.2"/><path d="M20.6 16.4v4.2h-4.2"/></g>';

export function targetGlyph(kind: string): string {
  return TARGET_GLYPHS[(kind as TargetKind)] ?? TARGET_GLYPHS.waypoint;
}

/** Off-screen indicator: a soft chevron that points along the bearing. */
export const CHEVRON = '<path d="M8.6 5.4 15.6 12l-7 6.6"/>';

/* ─────────────────────────── control glyphs ─────────────────────────── */

export const CONTROL_GLYPHS: Record<string, string> = {
  jump: '<path d="M12 17.5V6.8"/><path d="M7.6 11.2 12 6.6l4.4 4.6"/><path d="M6.4 20.2h11.2" opacity=".5"/>',
  sprint: '<path d="M4.6 15.4h5"/><path d="M6.6 11.6h6.2"/><path d="M8.6 7.8h5.4"/><path d="M15.4 6.6 20 12l-4.6 5.4"/>',
  interact: '<circle cx="12" cy="12" r="6.4"/><circle cx="12" cy="12" r="1.6"/>',
  scan: '<path d="M12 12h.01"/><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6"/><path d="M15.8 8.2a5.4 5.4 0 0 1 0 7.6"/><path d="M5.4 18.6a9.4 9.4 0 0 1 0-13.2" opacity=".5"/><path d="M18.6 5.4a9.4 9.4 0 0 1 0 13.2" opacity=".5"/>',
  boost: '<path d="M12 19V7.4"/><path d="M8 11.4 12 7l4 4.4"/><path d="M9 21.4h6" opacity=".45"/>',
  brake: '<path d="M8.4 4.6h7.2L20 9v6l-4.4 4.4H8.4L4 15V9Z"/>',
  handbrake: '<path d="M7 18.6 15.4 6.2"/><circle cx="6.2" cy="19.4" r="1.6"/><path d="M13.6 5.2h4.6v4.6" opacity=".55"/>',
  land: '<path d="M12 5v10.6"/><path d="M7.6 11.4 12 16l4.4-4.6"/><path d="M5.6 20h12.8" opacity=".55"/>',
  warp: '<path d="M12 3.6 13.2 10.8 20.4 12 13.2 13.2 12 20.4 10.8 13.2 3.6 12 10.8 10.8Z"/><path d="M18.4 5.6 16.8 7.2M5.6 18.4l1.6-1.6" opacity=".5"/>',
  exit: '<path d="M14.4 4.8H6.2v14.4h8.2"/><path d="M11.6 12h8.2"/><path d="M17 9.2 19.8 12 17 14.8"/>',
  enter: '<path d="M9.6 19.2h8.2V4.8H9.6"/><path d="M12.4 12H4.2"/><path d="M7 9.2 4.2 12 7 14.8"/>',
  map: '<path d="M12 4.4 19.6 12 12 19.6 4.4 12Z"/><path d="M12 8.6 15.4 12 12 15.4 8.6 12Z" opacity=".5"/>',
  menu: '<circle cx="12" cy="6.2" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="12" cy="17.8" r="1.25"/>',
  photo: '<path d="M4.6 8.8V6.2h2.6M19.4 8.8V6.2h-2.6M4.6 15.2v2.6h2.6M19.4 15.2v2.6h-2.6"/><circle cx="12" cy="12" r="3.2"/>',
  toggleView: '<circle cx="12" cy="12" r="2.6"/><path d="M2.8 12s3.6-6 9.2-6 9.2 6 9.2 6-3.6 6-9.2 6-9.2-6-9.2-6Z"/>',
  crouch: '<path d="M12 6.5v10.7"/><path d="M7.6 12.8 12 17.4l4.4-4.6"/><path d="M6.4 3.8h11.2" opacity=".5"/>',
  ascend: '<path d="M12 18V7"/><path d="M7.8 11 12 6.8 16.2 11"/>',
  descend: '<path d="M12 6v11"/><path d="M7.8 13 12 17.2 16.2 13"/>',
};

export function controlGlyph(id: string): string {
  return CONTROL_GLYPHS[id] ?? CONTROL_GLYPHS.interact;
}
