#!/usr/bin/env node
/**
 * Screenshot harness.
 *
 * Boots the app in headless Chromium, drives it through `window.__aeon`, and
 * writes PNGs to captures/. This is what the visual-critique loop looks at —
 * the code is only as good as what it actually puts on screen, so we look.
 *
 * Usage:
 *   node tools/shoot.mjs                     # default shot list
 *   node tools/shoot.mjs --shots cosmos,surface
 *   node tools/shoot.mjs --out captures/run3 --width 1920 --height 1080
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const OUT = arg('out', 'captures');
// Default to 720p: this harness runs against a software rasteriser, and at
// 1080p a single frame takes longer than Playwright's screenshot timeout.
const WIDTH = parseInt(arg('width', '1280'), 10);
const HEIGHT = parseInt(arg('height', '720'), 10);
const PORT = parseInt(arg('port', '5199'), 10);
const ONLY = arg('shots', '').split(',').filter(Boolean);
const KEEP = args.includes('--keep');
const SETTLE = parseInt(arg('settle', '2500'), 10);
// Headless here means SwiftShader — a software rasteriser. 'ultra' is the right
// tier to judge on real hardware but never finishes a frame in software, so the
// tier is a flag with a tractable default.
const TIER = arg('tier', 'medium');

/**
 * The shot list. Each entry drives the running game into a specific state and
 * takes a picture. `setup` runs inside the page with `a` = window.__aeon.
 */
const SHOTS = [
  {
    id: 'cosmos-wide',
    title: 'Cosmic web — present epoch, wide',
    setup: async (a) => {
      await a.setRealm('cosmos');
      await a.cosmosView?.({ epoch: 1.0, distance: 340, pitch: 0.35, yaw: 0.6 });
    },
    settle: 4000,
  },
  {
    id: 'cosmos-early',
    title: 'Cosmic web — structure formation, z≈8',
    setup: async (a) => {
      await a.setRealm('cosmos');
      await a.cosmosView?.({ epoch: 0.11, distance: 240, pitch: 0.2, yaw: 2.1 });
    },
    settle: 4000,
  },
  {
    id: 'cosmos-filament',
    title: 'Cosmic web — inside a filament',
    setup: async (a) => {
      await a.setRealm('cosmos');
      await a.cosmosView?.({ epoch: 1.0, distance: 55, pitch: 0.05, yaw: 1.2 });
    },
    settle: 4000,
  },
  {
    id: 'galaxy-face',
    title: 'Galaxy — face on',
    setup: async (a) => {
      await a.setRealm('galaxy');
      await a.galaxyView?.({ distance: 95000, pitch: 1.15, yaw: 0.4 });
    },
    settle: 4500,
  },
  {
    id: 'galaxy-edge',
    title: 'Galaxy — edge on, dust lanes',
    setup: async (a) => {
      await a.setRealm('galaxy');
      await a.galaxyView?.({ distance: 78000, pitch: 0.06, yaw: 1.9 });
    },
    settle: 4500,
  },
  {
    id: 'system-wide',
    title: 'Star system — inner planets and the star',
    setup: async (a) => {
      await a.setRealm('system');
      await a.systemView?.({ mode: 'wide' });
    },
    settle: 5000,
  },
  {
    id: 'planet-orbit',
    title: 'Planet from orbit — terminator and atmosphere',
    setup: async (a) => {
      await a.setRealm('surface');
      await a.planetView?.({ mode: 'orbit' });
    },
    settle: 8000,
  },
  {
    id: 'planet-limb',
    title: 'Planet limb — atmospheric scattering against space',
    setup: async (a) => {
      await a.setRealm('surface');
      await a.planetView?.({ mode: 'limb' });
    },
    settle: 8000,
  },
  {
    id: 'surface-vista',
    title: 'Surface — landscape vista, third person',
    setup: async (a) => {
      await a.setRealm('surface');
      await a.planetView?.({ mode: 'vista' });
    },
    settle: 10000,
  },
  {
    id: 'surface-first',
    title: 'Surface — first person, ground detail',
    setup: async (a) => {
      await a.setRealm('surface');
      await a.planetView?.({ mode: 'ground' });
    },
    settle: 10000,
  },
  {
    id: 'surface-city',
    title: 'Surface — settlement at dusk',
    setup: async (a) => {
      await a.setRealm('surface');
      await a.planetView?.({ mode: 'city' });
    },
    settle: 12000,
  },
  {
    id: 'surface-night',
    title: 'Surface — night, aurora and bioluminescence',
    setup: async (a) => {
      await a.setRealm('surface');
      await a.planetView?.({ mode: 'night' });
    },
    settle: 10000,
  },
  {
    id: 'surface-ocean',
    title: 'Surface — coastline, water and sun glint',
    setup: async (a) => {
      await a.setRealm('surface');
      await a.planetView?.({ mode: 'ocean' });
    },
    settle: 10000,
  },
];

async function main() {
  if (!KEEP && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log('› building…');
  await run('npx', ['vite', 'build', '--logLevel', 'warn']);

  console.log(`› serving on :${PORT}`);
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`  [preview] ${d}`));
  await waitForServer(`http://localhost:${PORT}/`, 30000);

  // The image ships a pinned Chromium build that may not match the Playwright
  // package's expected revision, so point at the binary directly rather than
  // downloading another copy.
  const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({
    executablePath: existsSync(PINNED) ? PINNED : undefined,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-frame-rate-limit',
      '--js-flags=--max-old-space-size=4096',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  console.log('› loading…');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // The boot sequence is deliberately unhurried; give it room.
  await page.waitForFunction(() => !!window.__aeon?.ready, null, { timeout: 180000 }).catch(async () => {
    const fatal = await page.textContent('#fatal-msg').catch(() => '');
    throw new Error(`App never became ready.\nFatal pane: ${fatal}\nConsole:\n${logs.join('\n')}`);
  });

  // Dismiss the "Enter" gate so the HUD is in its normal state.
  await page.mouse.click(WIDTH / 2, HEIGHT / 2);
  await sleep(1200);

  await page.evaluate((t) => window.__aeon.setTier(t), TIER);
  await sleep(500);

  const list = ONLY.length ? SHOTS.filter((s) => ONLY.includes(s.id)) : SHOTS;
  const manifest = [];

  for (const shot of list) {
    process.stdout.write(`› ${shot.id} … `);
    try {
      await page.evaluate(async (src) => {
        const fn = new Function('a', `return (${src})(a)`);
        await fn(window.__aeon);
      }, shot.setup.toString());

      await sleep(shot.settle ?? SETTLE);

      // Wait for the frame rate to stabilise so we don't shoot mid-stream-in.
      await page
        .waitForFunction(
          () => {
            const s = window.__aeon.stats();
            return s.fps > 4;
          },
          null,
          { timeout: 20000 }
        )
        .catch(() => {});

      const file = path.join(OUT, `${shot.id}.png`);
      await page.screenshot({ path: file, type: 'png', timeout: 180000 });
      const stats = await page.evaluate(() => window.__aeon.stats());
      manifest.push({ id: shot.id, title: shot.title, file, stats });
      console.log(`ok  (${stats.fps.toFixed(0)} fps, ${stats.drawCalls} draws)`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      manifest.push({ id: shot.id, title: shot.title, error: String(e.message) });
    }
  }

  writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ manifest, logs: logs.slice(0, 200) }, null, 2));

  if (logs.length) {
    console.log(`\n› ${logs.length} console errors/warnings (first 20):`);
    for (const l of logs.slice(0, 20)) console.log(`   ${l}`);
  }

  await browser.close();
  server.kill('SIGTERM');
  console.log(`\n› wrote ${manifest.filter((m) => !m.error).length}/${list.length} shots to ${OUT}/`);
  process.exit(0);
}

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

async function waitForServer(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`server did not start at ${url}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
