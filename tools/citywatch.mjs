#!/usr/bin/env node
/**
 * Watch a city being built.
 *
 * Drives the game to a settlement and polls `planetDebug()` on a timer, so the
 * slow phase shows up as a gap in the log instead of as a screenshot that never
 * arrives. Written because "surface-city" sat for twenty minutes with no output
 * and there was no way to tell terrain streaming apart from city generation
 * apart from an outright hang.
 *
 *   node tools/citywatch.mjs [--tier medium] [--stream 120]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = parseInt(arg('port', '5361'), 10);
const TIER = arg('tier', 'medium');
const STREAM = parseInt(arg('stream', '120'), 10);
const W = parseInt(arg('width', '640'), 10);
const H = parseInt(arg('height', '360'), 10);
const OUT = arg('out', 'captures/citywatch.png');
// Shadows are what actually kills the frame rate on a ground shot; the post
// chain is comparatively cheap and is the only thing that makes the image
// look like the game rather than like raw linear radiance.
const KEEP_POST = args.includes('--post');

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s`;
const log = (...a) => console.log(stamp(), ...a);

async function waitForServer(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error('server never started');
}

async function main() {
  await new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--logLevel', 'error'], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build ${c}`))));
  });
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForServer(`http://localhost:${PORT}/`, 30000);

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
      '--js-flags=--max-old-space-size=3072',
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  let shaderFailures = 0;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // A failed compile is silent on screen — the mesh is just absent — so it
    // has to be shouted about here or it hides behind a plausible picture.
    if (/Shader Error|ERROR: 0:/.test(text)) {
      shaderFailures++;
      log('SHADER ERROR\n' + text.split('\n').slice(0, 20).join('\n'));
      return;
    }
    log('CONSOLE', text.slice(0, 300));
  });
  page.on('pageerror', (e) => log('PAGEERROR', e.message.slice(0, 300)));

  log('loading');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!window.__aeon?.ready, null, { timeout: 240000 });
  log('ready');
  await page.mouse.click(W / 2, H / 2);
  await page.evaluate((t) => window.__aeon.setTier(t), TIER);
  await page.evaluate((ms) => window.__aeon.stream?.(ms), STREAM);
  if (args.includes('--fast')) {
    await page.evaluate((keepPost) => {
      window.__aeon.setShadows?.(false);
      if (!keepPost) window.__aeon.setPost?.(false);
    }, KEEP_POST);
    log('shadows and post off');
  }

  // Poll on an interval that is independent of the page, so a blocked main
  // thread shows up as silence rather than as a missing line.
  let done = false;
  const poll = (async () => {
    while (!done) {
      try {
        const d = await page.evaluate(() => window.__aeon.planetDebug?.() ?? null, null, { timeout: 20000 });
        if (d) {
          const t = d.terrain ?? {};
          const c = d.civ ?? {};
          log(
            `mode=${d.mode} terrain[p=${t.patches} q=${t.queued} built=${t.builtEver} budget=${t.lodBudget}] ` +
              `scatter[c=${d.scatter?.cells} i=${d.scatter?.instances}] ` +
              `civ[built=${c.built} making=${c.building ?? '-'} ${c.progress ?? 0} bldgs=${c.buildings} ` +
              `near=${c.nearest}/${c.nearestKind} ${c.nearestM}m r=${c.nearestRadius} ` +
              `ready=${c.readyName} meshes=${c.readyMeshes} verts=${c.readyVerts} sunUp=${c.sunUp}]`
          );
        }
      } catch (e) {
        log('poll blocked:', String(e.message).slice(0, 80));
      }
      await sleep(5000);
    }
  })();

  log('entering surface');
  await page.evaluate(() => window.__aeon.setRealm('surface'));
  log('surface entered');
  await sleep(2000);

  const MODE = arg('mode', 'city');
  const DETAIL = parseInt(arg('detail', '40000'), 10);
  log('posing view', MODE);
  await page.evaluate(([m, d]) => window.__aeon.planetView({ mode: m, detailTimeoutMs: d }), [MODE, DETAIL]);
  log('view posed');

  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const c = await page.evaluate(() => window.__aeon.planetDebug?.()?.civ ?? null);
    if (c && c.built > 0) {
      log('city built');
      break;
    }
  }

  const url = await page.evaluate(() => window.__aeon.capture());
  writeFileSync(OUT, Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'));
  log('wrote', OUT);

  done = true;
  await poll;
  await browser.close();
  server.kill('SIGTERM');
  if (shaderFailures) {
    console.error(`\n!! ${shaderFailures} shader compile failure(s).`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
