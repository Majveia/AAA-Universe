/**
 * Boot.
 *
 * Creates the engine, wires the realms together, and hands control to the
 * player. Everything expensive happens behind the veil so the first frame the
 * player actually sees is a finished one.
 */

import { Engine } from './core/Engine';
import { Universe } from './universe/Universe';
import type { RealmId } from './core/Realm';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const veil = document.getElementById('veil') as HTMLElement;
const barFill = document.getElementById('bar-fill') as HTMLElement;
const bootStatus = document.getElementById('boot-status') as HTMLElement;
const enterPane = document.getElementById('enter') as HTMLElement;
const fatalPane = document.getElementById('fatal') as HTMLElement;
const fatalMsg = document.getElementById('fatal-msg') as HTMLElement;

function setProgress(p: number, label: string): void {
  barFill.style.right = `${Math.max(0, 100 - p * 100)}%`;
  bootStatus.textContent = label;
}

function fatal(err: unknown): void {
  const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  fatalMsg.textContent = msg;
  fatalPane.classList.add('show');
  veil.classList.add('gone');
  console.error(err);
}

async function boot(): Promise<void> {
  setProgress(0.04, 'waking the renderer');

  const engine = new Engine(canvas);
  const universe = new Universe('AEON');
  engine.services.universe = universe;

  // Give the browser a chance to paint the progress bar between heavy steps.
  const breathe = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  setProgress(0.12, 'sounding the dark');
  await breathe();

  const { AudioEngine } = await import('./audio/AudioEngine');
  const audio = new AudioEngine();
  engine.services.audio = audio;

  setProgress(0.22, 'assembling the interface');
  await breathe();

  const { Hud } = await import('./ui/Hud');
  const hud = new Hud(engine);
  engine.services.hud = hud;
  document.getElementById('app')!.appendChild(hud.element);

  setProgress(0.34, 'seeding the cosmic web');
  await breathe();

  const { CosmosRealm } = await import('./realms/CosmosRealm');
  const { GalaxyRealm } = await import('./realms/GalaxyRealm');
  const { SystemRealm } = await import('./realms/SystemRealm');
  const { SurfaceRealm } = await import('./realms/SurfaceRealm');

  const cosmos = new CosmosRealm();
  const galaxy = new GalaxyRealm();
  const system = new SystemRealm();
  const surface = new SurfaceRealm();
  engine.registerRealm(cosmos);
  engine.registerRealm(galaxy);
  engine.registerRealm(system);
  engine.registerRealm(surface);

  setProgress(0.52, 'collapsing the first haloes');
  await breathe();

  await engine.setRealm('cosmos');

  setProgress(0.78, 'lighting the first stars');
  await breathe();

  engine.onTransitionProgress = (v) => hud.setVeil(v);
  engine.onRealmChanged = (id) => {
    hud.setContext(id === 'cosmos' ? 'cosmos' : id === 'galaxy' ? 'map' : id === 'system' ? 'space' : 'foot');
  };

  engine.start();

  setProgress(1, 'ready');
  await breathe();
  await new Promise((r) => setTimeout(r, 320));

  veil.classList.add('gone');
  setTimeout(() => veil.remove(), 1600);

  // Audio needs a gesture. Show the prompt only if the context is suspended.
  enterPane.classList.add('show');
  const begin = async () => {
    enterPane.removeEventListener('pointerdown', begin);
    window.removeEventListener('keydown', begin);
    enterPane.classList.add('fade');
    setTimeout(() => enterPane.classList.remove('show'), 950);
    try {
      await audio.resume();
    } catch {
      /* audio is a nicety, not a requirement */
    }
    hud.setVisible(true);
    engine.services.started = true;
  };
  enterPane.addEventListener('pointerdown', begin);
  window.addEventListener('keydown', begin);

  /* ---- debug bridge, used by the screenshot/critique harness ---- */
  (window as any).__aeon = {
    engine,
    universe,
    hud,
    audio,
    ready: true,
    goto: (id: RealmId, payload?: any) => engine.goto(id, payload, 0.6),
    setRealm: (id: RealmId, payload?: any) => engine.setRealm(id, payload),
    setTier: (t: any) => engine.adaptive.setManual(t),
    capture: () => engine.capture(),
    stats: () => ({ ...engine.stats, tier: engine.adaptive.tier, realm: engine.current?.id }),
    pause: (v: boolean) => (engine.paused = v),
    timeScale: (v: number) => (engine.timeScale = v),
    hideHud: (v: boolean) => hud.setVisible(!v),
  };
}

boot().catch(fatal);

window.addEventListener('error', (e) => {
  if (!(window as any).__aeon?.ready) fatal(e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (!(window as any).__aeon?.ready) fatal(e.reason);
});
