#!/usr/bin/env node
/**
 * Frame-cost probe.
 *
 * The screenshot harness answers "does it look right" in about ten minutes.
 * This answers "what is eating the frame" in about ninety seconds, by posing a
 * view and then toggling one layer at a time and reading the frame rate back.
 *
 * It runs against SwiftShader like everything else here, so the absolute
 * numbers mean nothing. The *ratios* mean everything: a layer that halves the
 * frame rate in software will halve it on a GPU too.
 *
 *   node tools/perf.mjs --view orbit
 *   node tools/perf.mjs --view ground --port 5288
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = parseInt(arg('port', '5266'), 10);
const VIEW = arg('view', 'orbit');
const TIER = arg('tier', 'low');
const W = parseInt(arg('width', '640'), 10);
const H = parseInt(arg('height', '360'), 10);
const SKIP_BUILD = args.includes('--no-build');

function run(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
  });
}

if (!SKIP_BUILD) {
  console.log('› building…');
  await run('npx', ['vite', 'build', '--logLevel', 'warn']);
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
  } catch {
    /* not up */
  }
  await sleep(300);
}

const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: existsSync(PINNED) ? PINNED : undefined,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-frame-rate-limit',
    '--js-flags=--max-old-space-size=4096',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = [];
page.on('console', (m) => {
  if (/Shader Error|ERROR: 0:/.test(m.text())) errs.push(m.text());
});
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !!window.__aeon?.ready, null, { timeout: 180000 });
await page.mouse.click(W / 2, H / 2);
await sleep(800);
await page.evaluate((t) => window.__aeon.setTier(t), TIER);
await sleep(400);

if (VIEW === 'orbit' || VIEW === 'limb') {
  await page.evaluate(async (m) => {
    await window.__aeon.setRealm('surface');
    await window.__aeon.planetView({ mode: m });
  }, VIEW);
} else if (VIEW === 'ground' || VIEW === 'vista') {
  await page.evaluate(async (m) => {
    await window.__aeon.setRealm('surface');
    await window.__aeon.planetView({ mode: m });
  }, VIEW);
} else if (VIEW === 'system') {
  await page.evaluate(async () => {
    await window.__aeon.setRealm('system');
    await window.__aeon.systemView({ mode: 'wide' });
  });
} else if (VIEW === 'galaxy') {
  await page.evaluate(async () => {
    await window.__aeon.setRealm('galaxy');
    await window.__aeon.galaxyView({ distance: 95000, pitch: 1.15, yaw: 0.4 });
  });
} else if (VIEW === 'cosmos') {
  await page.evaluate(async () => {
    await window.__aeon.setRealm('cosmos');
    await window.__aeon.cosmosView({ epoch: 1.0, distance: 340, pitch: 0.35, yaw: 0.6 });
  });
}

// Let the terrain queue drain so we are not measuring streaming.
await page
  .waitForFunction(
    () => {
      const t = window.__aeon.planetDebug?.()?.terrain;
      return !t || t.queued === 0;
    },
    null,
    { timeout: 200000, polling: 1000 }
  )
  .catch(() => {});

async function fps(label) {
  await sleep(2500);
  const s = await page.evaluate(() => window.__aeon.stats());
  console.log(`  ${label.padEnd(26)} ${s.fps.toFixed(1).padStart(6)} fps   ${String(s.drawCalls).padStart(5)} draws`);
  return s.fps;
}

console.log(`\n› ${VIEW} @ ${W}×${H}, tier ${TIER}\n`);
const base = await fps('everything on');

const layers = ['clouds', 'atmosphere', 'ocean', 'terrain'];
for (const l of layers) {
  await page.evaluate((x) => window.__aeon.planetLayer?.(x, false), l);
  const f = await fps(`− ${l}`);
  await page.evaluate((x) => window.__aeon.planetLayer?.(x, true), l);
  if (f > base * 1.15) {
    const share = (1 / base - 1 / f) / (1 / base);
    console.log(`      ↳ ${l} is ${(share * 100).toFixed(0)}% of the frame`);
  }
}

await page.evaluate(() => window.__aeon.setPost(false));
const nopost = await fps('− post chain');
await page.evaluate(() => window.__aeon.setPost(true));
if (nopost > base * 1.15) {
  console.log(`      ↳ post is ${(((1 / base - 1 / nopost) / (1 / base)) * 100).toFixed(0)}% of the frame`);
}

if (errs.length) {
  console.log('\n!! shader errors:');
  for (const e of errs.slice(0, 3)) console.log(e.split('\n').slice(0, 16).join('\n'));
}

await browser.close();
server.kill('SIGTERM');
process.exit(0);
