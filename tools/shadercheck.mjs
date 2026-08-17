#!/usr/bin/env node
/**
 * Compile every shader in the project against a real WebGL2 driver.
 *
 * `glslcheck` catches the reserved-word trap statically in forty milliseconds,
 * but it cannot catch the other ways a program has silently failed here:
 * writing `metalnessFactor` before three declares it, referencing a uniform
 * that exists in the JS object but never in the GLSL, or injecting the noise
 * library after the code that calls into it. Those need a compiler.
 *
 * So this builds a page that instantiates every material the game can make,
 * hands them to a renderer configured exactly like the engine's — logarithmic
 * depth on, which changes the chunks three injects — and calls
 * `WebGLRenderer.compile`. Roughly twenty seconds, no game boot, no terrain
 * streaming, no screenshots. It is the cheapest possible answer to the single
 * most expensive class of bug in this repository.
 *
 *   node tools/shadercheck.mjs [--keep]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = parseInt(arg('port', '5501'), 10);
const KEEP = args.includes('--keep');

/* ═══════════════════════════════════════════════════════════════════════════
   The page
   ═══════════════════════════════════════════════════════════════════════════ */

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8">
<title>shadercheck</title>
<body style="margin:0;background:#000">
<canvas id="c" width="64" height="64"></canvas>
<script type="module" src="/entry.ts"></script>
`;

const ENTRY = /* ts */ `
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PerspectiveCamera,
  Points,
  RGBAFormat,
  Scene,
  WebGLRenderer,
} from 'three';
import * as Civ from '../src/civ/Materials';
import * as Ent from '../src/entities/Materials';
import { buildShipMesh } from '../src/entities/ShipMesh';
import { buildRoverMesh } from '../src/entities/RoverMesh';
import { CharacterMesh } from '../src/entities/CharacterMesh';
import { makeGlyphTexture } from '../src/civ/Glyphs';
import { Rng } from '../src/core/Rand';

const canvas = document.getElementById('c') as HTMLCanvasElement;

// Exactly the engine's configuration. Log depth is not cosmetic here: it makes
// three inject different chunks, and a shader that compiles without it can
// still fail with it.
const renderer = new WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true });
renderer.debug.checkShaderErrors = true;

const scene = new Scene();
const camera = new PerspectiveCamera(60, 1, 0.1, 1e9);
camera.position.set(0, 0, 5);

/**
 * One geometry carrying every custom attribute any material in the project
 * asks for. A shader that does not use one simply ignores it, so a single
 * over-specified geometry serves them all and nothing has to stay in sync.
 */
function fullGeometry(instanced = false): BufferGeometry {
  const g: any = instanced ? new InstancedBufferGeometry() : new BufferGeometry();
  const n = 3;
  const f = (k: number) => new Float32Array(n * k);
  g.setAttribute('position', new BufferAttribute(f(3), 3));
  g.setAttribute('normal', new BufferAttribute(f(3), 3));
  g.setAttribute('uv', new BufferAttribute(f(2), 2));
  g.setAttribute('aFacade', new BufferAttribute(f(4), 4));
  g.setAttribute('aInfo', new BufferAttribute(f(4), 4));
  g.setAttribute('aPart', new BufferAttribute(f(1), 1));
  g.setAttribute('aSize', new BufferAttribute(f(1), 1));
  g.setAttribute('aSeed', new BufferAttribute(f(1), 1));
  g.setAttribute('aTint', new BufferAttribute(f(3), 3));
  g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  if (instanced) {
    g.setAttribute('aA', new InstancedBufferAttribute(new Float32Array(3), 3));
    g.setAttribute('aB', new InstancedBufferAttribute(new Float32Array(3), 3));
    g.setAttribute('aLane', new InstancedBufferAttribute(new Float32Array(4), 4));
    g.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(3), 3));
    g.instanceCount = 1;
  }
  return g;
}

const glyphs = makeGlyphTexture(1234);
const rng = new Rng(7);

type Entry = { name: string; make: () => any; points?: boolean; instanced?: boolean };

const ENTRIES: Entry[] = [
  { name: 'civ/city', make: () => Civ.makeCityMaterial() },
  { name: 'civ/ground', make: () => Civ.makeGroundMaterial() },
  { name: 'civ/road', make: () => Civ.makeRoadMaterial() },
  { name: 'civ/traffic', make: () => Civ.makeTrafficMaterial(), instanced: true },
  { name: 'civ/holo', make: () => Civ.makeHoloMaterial(glyphs) },
  { name: 'civ/lights', make: () => Civ.makeLightsMaterial(), points: true },
  { name: 'civ/ribbon', make: () => Civ.makeRibbonMaterial() },
  { name: 'civ/glow', make: () => Civ.makeGlowMaterial() },
  { name: 'ent/hull', make: () => Ent.makeHullMaterial(new Rng(1)) },
  { name: 'ent/visor', make: () => Ent.makeVisorMaterial() },
  { name: 'ent/suit', make: () => Ent.makeSuitMaterial(new Rng(2)) },
  { name: 'ent/emissive', make: () => Ent.makeEmissive(new Color(1, 1, 1), 1) },
  { name: 'ent/flame', make: () => Ent.makeFlameMaterial(new Color(1, 1, 1), new Color(0, 0, 1)) },
  { name: 'ent/glow', make: () => Ent.makeGlowMaterial(new Color(0.3, 1, 3)) },
];

const results: { name: string; ok: boolean; note?: string }[] = [];

for (const e of ENTRIES) {
  const before = renderer.info.programs?.length ?? 0;
  let obj: any;
  try {
    const mat = e.make();
    const geo = fullGeometry(!!e.instanced);
    obj = e.points ? new Points(geo, mat) : new Mesh(geo, mat);
    obj.frustumCulled = false;
    scene.add(obj);
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
  } catch (err: any) {
    results.push({ name: e.name, ok: false, note: String(err?.message ?? err) });
    if (obj) scene.remove(obj);
    continue;
  }
  // three attaches a diagnostics object to any program that failed to link.
  const progs = renderer.info.programs ?? [];
  const bad = progs.slice(before).filter((p: any) => p.diagnostics && p.diagnostics.runnable === false);
  results.push({
    name: e.name,
    ok: bad.length === 0,
    note: bad.length ? 'program not runnable' : undefined,
  });
  scene.remove(obj);
}

/**
 * The whole-object builders, which construct materials of their own. A ship is
 * eight materials assembled by hand; if one of them is broken the hull is
 * simply missing a wing and nothing says so.
 */
const RIGS: { name: string; build: () => any }[] = [
  { name: 'rig/ship', build: () => buildShipMesh(new Rng(3)) },
  { name: 'rig/rover', build: () => buildRoverMesh(new Rng(4)) },
  { name: 'rig/character', build: () => new CharacterMesh(new Rng(5), 1.8, { shadows: true, lamp: true }) },
];

for (const r of RIGS) {
  try {
    const parts: any = r.build();
    scene.add(parts.root);
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    scene.remove(parts.root);
    parts.dispose?.();
    results.push({ name: r.name, ok: true });
  } catch (err: any) {
    results.push({ name: r.name, ok: false, note: String(err?.message ?? err) });
  }
}

void rng;
(window as any).__shadercheck = {
  done: true,
  results,
  programs: renderer.info.programs?.length ?? 0,
};
`;

/* ═══════════════════════════════════════════════════════════════════════════
   Driver
   ═══════════════════════════════════════════════════════════════════════════ */

async function waitForServer(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`server never came up at ${url}`);
}

const dir = mkdtempSync(path.join(process.cwd(), '.shadercheck-'));
writeFileSync(path.join(dir, 'index.html'), PAGE);
writeFileSync(path.join(dir, 'entry.ts'), ENTRY);

let server;
let browser;
const cleanup = () => {
  try {
    // Negative pid = the whole group, which is what actually stops vite.
    if (server?.pid) process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
};

try {
  // Vite serves the temp directory as its root; `../src/...` resolves because
  // the project root is an allowed fs parent by default in dev.
  // Vite takes the root as a positional argument, not a flag. `detached` puts
  // it in its own process group: `npx` forks the real server, so killing the
  // npx pid alone leaves vite holding the port and the next run cannot bind.
  server = spawn(
    'npx',
    ['vite', dir, '--port', String(PORT), '--strictPort', '--logLevel', 'error'],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true }
  );
  server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await waitForServer(`http://localhost:${PORT}/`, 60000);

  const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  browser = await chromium.launch({
    executablePath: existsSync(PINNED) ? PINNED : undefined,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });

  const shaderErrors = [];
  const other = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Shader Error|ERROR: 0:|WARNING: 0:/.test(text)) shaderErrors.push(text);
    // The browser asks for a favicon the temp page does not have. That 404 is
    // the page being a page, not the renderer being broken.
    else if (!/Failed to load resource/.test(text)) other.push(text);
  });
  page.on('pageerror', (e) => other.push(`pageerror: ${e.message}`));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__shadercheck?.done === true, null, { timeout: 180000 });
  const out = await page.evaluate(() => window.__shadercheck);

  let failed = 0;
  for (const r of out.results) {
    if (r.ok) {
      console.log(`  ok   ${r.name}`);
    } else {
      failed++;
      console.log(`  FAIL ${r.name}${r.note ? ` — ${r.note}` : ''}`);
    }
  }
  console.log(`\n${out.results.length - failed}/${out.results.length} material sets compiled, ${out.programs} programs linked.`);

  if (shaderErrors.length) {
    console.error(`\n!! ${shaderErrors.length} shader diagnostic(s):\n`);
    for (const e of shaderErrors.slice(0, 8)) {
      console.error(e.split('\n').slice(0, 24).join('\n'));
      console.error('---');
    }
  }
  if (other.length) {
    console.error(`\n${other.length} other console error(s):`);
    for (const e of other.slice(0, 10)) console.error(`  ${e.slice(0, 300)}`);
  }

  await browser.close();
  cleanup();
  process.exit(failed || shaderErrors.length || other.length ? 1 : 0);
} catch (err) {
  console.error(err);
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  cleanup();
  process.exit(1);
}
