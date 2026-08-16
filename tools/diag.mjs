#!/usr/bin/env node
/**
 * Boot diagnostic.
 *
 * The screenshot harness waits three minutes for the app to come up, which is
 * a terrible feedback loop when something is wrong at boot. This does the same
 * load with a short leash and prints exactly how far the boot sequence got,
 * plus every console error, so a failure is a ten-second answer.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = parseInt(process.argv[2] ?? '5240', 10);
const WAIT = parseInt(process.argv[3] ?? '90', 10) * 1000;

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));

const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  try {
    const r = await fetch(`http://localhost:${PORT}/`);
    if (r.ok) break;
  } catch {
    /* not up yet */
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
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

const deadline = Date.now() + WAIT;
let ready = false;
let lastStatus = '';
while (Date.now() < deadline) {
  const s = await page
    .evaluate(() => ({
      ready: !!window.__aeon?.ready,
      status: document.getElementById('boot-status')?.textContent ?? '',
      fatal: document.getElementById('fatal-msg')?.textContent ?? '',
    }))
    .catch(() => null);
  if (!s) break;
  if (s.status !== lastStatus) {
    lastStatus = s.status;
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] boot: ${s.status}`);
  }
  if (s.fatal) {
    console.log(`\nFATAL: ${s.fatal}`);
    break;
  }
  if (s.ready) {
    ready = true;
    break;
  }
  await sleep(500);
}

console.log(`\nready=${ready} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (ready) {
  // Dismiss the enter gate, then let the render loop actually run — the first
  // frames are shader compilation, which in software takes a while.
  await page.mouse.click(640, 360);
  // Pin the tier: adaptive quality drops to 'potato' under a software
  // rasteriser, which is not the configuration worth looking at.
  await page.evaluate((t) => window.__aeon.setTier(t), process.env.AEON_TIER ?? 'medium');
  await sleep(1500);
  const HOLD = parseInt(process.argv[4] ?? '30', 10) * 1000;
  const step = 5000;
  for (let waited = 0; waited < HOLD; waited += step) {
    await sleep(step);
    const st = await page.evaluate(() => window.__aeon.stats());
    console.log(`  [+${(waited + step) / 1000}s] fps=${st.fps.toFixed(1)} draws=${st.drawCalls} tris=${st.triangles} progs=${st.programs} tier=${st.tier}`);
  }
  await page.screenshot({ path: 'captures/diag.png' });
  console.log('wrote captures/diag.png');
  // Raw scene, no post chain: separates "nothing is being drawn" from
  // "something in post is eating it".
  await page.evaluate(() => window.__aeon.setPost?.(false));
  await sleep(3000);
  await page.screenshot({ path: 'captures/diag-nopost.png' });
  console.log('wrote captures/diag-nopost.png');
  await page.evaluate(() => window.__aeon.setPost?.(true));
  await sleep(1500);
  const camInfo = await page.evaluate(() => window.__aeon.debugBox?.(true));
  console.log('camera:', JSON.stringify(camInfo));
  await sleep(3000);
  await page.screenshot({ path: 'captures/diag-box.png' });
  console.log('wrote captures/diag-box.png');
  await page.evaluate(() => window.__aeon.debugBox?.(false));
  await page.evaluate(() => window.__aeon.webDebug?.({ flat: true }));
  await sleep(3000);
  await page.screenshot({ path: 'captures/diag-flat.png' });
  console.log('wrote captures/diag-flat.png');
  await page.evaluate(() => window.__aeon.webDebug?.({ flat: false }));
  await sleep(1000);
  // Paint the density atlas straight to the screen: if the splat is working
  // this is unmistakable, and it needs no pixel readback.
  for (const stage of ['splat', 'blur']) {
    await page.evaluate((st) => window.__aeon.webDebug?.({ showGrid: st }), stage);
    await sleep(4000);
    const d = await page.evaluate(() => window.__aeon.webDebug?.({}));
    console.log(`  ${stage} diag:`, JSON.stringify(d?.diag), 'rho:', JSON.stringify(d?.rho));
    await page.screenshot({ path: `captures/diag-${stage}.png` });
    console.log(`wrote captures/diag-${stage}.png`);
  }
}

const seen = new Set();
console.log('\n--- console (deduped) ---');
for (const l of logs) {
  const k = l.slice(0, 90);
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(l.slice(0, 1400));
}

await browser.close();
server.kill('SIGTERM');
process.exit(0);
