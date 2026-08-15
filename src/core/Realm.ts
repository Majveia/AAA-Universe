/**
 * A Realm is one coherent scale of the universe with its own scene graph,
 * units, and camera behaviour.
 *
 * The universe spans about 27 orders of magnitude — from a pebble underfoot at
 * 10⁻² m to the cosmic web at 10²⁶ m. No single float-based scene graph
 * survives that. So ÆON splits the range into realms, each with its own unit
 * and its own numerical comfort zone, and hands off between them:
 *
 *   COSMOS   1 unit = 1 Mpc        the cosmic web, filaments and voids
 *   GALAXY   1 unit = 1 ly         stars, nebulae, the disc
 *   SYSTEM   1 unit = 1 m          planets and orbits, floating origin
 *   SURFACE  1 unit = 1 m          standing on a world, origin at the player
 *
 * SYSTEM and SURFACE share units and blend seamlessly (you can fly a ship from
 * orbit down to a beach without a loading screen). COSMOS and GALAXY hand over
 * through a warp, which is both an honest admission that the scales don't share
 * a coordinate system and, done well, the best-looking moment in the game.
 */

import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { Input } from './Input';
import type { QualityProfile, UserPrefs } from './Settings';
import type { Engine } from './Engine';

export type RealmId = 'cosmos' | 'galaxy' | 'system' | 'surface';

export interface RealmContext {
  engine: Engine;
  renderer: WebGLRenderer;
  input: Input;
  quality: QualityProfile;
  prefs: UserPrefs;
  /** Seconds since boot, unpaused. */
  time: number;
  /** Any shared service registered on the engine (audio, hud, universe…). */
  services: Record<string, any>;
}

export interface Realm {
  readonly id: RealmId;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;

  /** Called once when the realm becomes active. May load asynchronously. */
  enter(ctx: RealmContext, payload?: any): void | Promise<void>;
  /** Called when the realm is being left; keep state, release nothing heavy. */
  exit?(ctx: RealmContext): void;
  update(dt: number, ctx: RealmContext): void;
  /** Optional custom render; return true if the realm rendered itself. */
  render?(ctx: RealmContext, dt: number): boolean;
  resize?(w: number, h: number): void;
  setQuality?(q: QualityProfile): void;
  dispose?(): void;

  /** Human-readable location string for the HUD. */
  locationLabel?(): string;
}
