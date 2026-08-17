#!/usr/bin/env node
/**
 * Fast liveness probe.
 *
 * Boots the app once and reports how long a frame actually takes, per realm,
 * at a given tier and size. The full screenshot harness is unusable until this
 * says a frame fits inside a screenshot timeout — under SwiftShader it very
 * often does not, and this tells you that in thirty seconds rather than in
 * thirteen consecutive three-minute failures.
 *
 *   node tools/probe.mjs --width 640 --height 360 --tier low
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
const WIDTH = parseInt(arg('width', '640'), 10);
const HEIGHT = parseInt(arg('height', '360'), 10);
const PORT = parseInt(arg('port', '5198'), 10);
const TIER = arg('tier', 'low');
const POST = args.includes('--post');
const REALMS = arg('realms', 'cosmos,galaxy,system,surface').split(',').filter(Boolean);

async function waitForServer(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error(`server never came up at ${url}`);
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
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 400));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!window.__aeon?.ready, null, { timeout: 240000 });
  console.log(`boot: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  await page.mouse.click(WIDTH / 2, HEIGHT / 2);
  await page.evaluate((t) => window.__aeon.setTier(t), TIER);
  if (!POST) await page.evaluate(() => window.__aeon.setPost(false));
  await sleep(1000);

  for (const realm of REALMS) {
    const ta = Date.now();
    await page.evaluate((r) => window.__aeon.setRealm(r), realm);
    const enter = Date.now() - ta;
    await sleep(3000);
    const s = await page.evaluate(() => window.__aeon.stats());
    const tb = Date.now();
    await page.screenshot({ type: 'png', timeout: 120000 }).catch((e) => console.log(`  shot failed: ${e.message.slice(0, 60)}`));
    console.log(
      `${realm.padEnd(8)} enter ${String(enter).padStart(6)} ms   ${s.fps.toFixed(2)} fps   frame ${s.frameMs.toFixed(0)} ms   draws ${s.drawCalls}   shot ${Date.now() - tb} ms`
    );
  }

  if (errors.length) {
    console.log(`\n${errors.length} console errors:`);
    for (const e of errors.slice(0, 12)) console.log(`  ${e}`);
  }

  await browser.close();
  server.kill('SIGTERM');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
