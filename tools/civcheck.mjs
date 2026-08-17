#!/usr/bin/env node
/**
 * Headless smoke test for the civilisation generator.
 *
 * Cities are the most combinatorial thing in the project: eight architectural
 * languages × six street patterns × whatever terrain the world happens to have
 * under them. Finding a divide-by-zero in that from a screenshot takes twenty
 * minutes; finding it here takes four seconds. Runs every style against a
 * synthetic planet and reports the shape of what came out.
 *
 *   node tools/civcheck.mjs
 */

import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Bundle inside the project so bare imports still resolve against node_modules.
const dir = mkdtempSync(path.join(process.cwd(), '.civcheck-'));
const entry = path.join(dir, 'entry.ts');

writeFileSync(
  entry,
  `
import { Vector3 } from 'three';
import { placeSettlements } from '${path.resolve('src/civ/Placement.ts').replace(/\\/g, '/')}';
import { buildLayout } from '${path.resolve('src/civ/Layout.ts').replace(/\\/g, '/')}';
import { emitCity } from '${path.resolve('src/civ/Build.ts').replace(/\\/g, '/')}';
import { Heightfield, TangentFrame } from '${path.resolve('src/civ/CivMath.ts').replace(/\\/g, '/')}';
import { fbm3 } from '${path.resolve('src/core/Noise.ts').replace(/\\/g, '/')}';

const R = 6.2e6;
const SEA = R + 40;

/** A synthetic world: continents, mountains, an ocean. Cheap and repeatable. */
function makePlanet(seed: number): any {
  const heightAt = (d: any) => {
    const c = fbm3(d.x * 1.6 + seed, d.y * 1.6, d.z * 1.6, { octaves: 5 });
    const m = fbm3(d.x * 7.0, d.y * 7.0 + seed, d.z * 7.0, { octaves: 4 });
    return c * 2600 + m * 420;
  };
  return {
    radius: R,
    root: null,
    spec: null,
    heightAt,
    sampleSurface(d: any) {
      const h = heightAt(d);
      return {
        elevation: h,
        normal: d.clone(),
        slope: Math.min(1, Math.abs(fbm3(d.x * 9, d.y * 9, d.z * 9, { octaves: 2 })) * 1.2),
        temperature: Math.max(0, Math.min(1, 1 - Math.abs(d.y) * 1.1)),
        humidity: Math.max(0, Math.min(1, 0.5 + fbm3(d.x * 3, d.y * 3, d.z * 3, { octaves: 3 }) * 0.6)),
        biome: 3,
        underwater: R + h < SEA,
      };
    },
    seaLevelRadius: () => SEA,
    ensureDetail: async () => {},
    setSun() {},
    setViewer() {},
    setWeather() {},
    isReady: () => true,
    update() {},
    dispose() {},
    setQuality() {},
  };
}

const STYLES = ['brutalist', 'organic', 'crystalline', 'arcology', 'nomadic', 'hive', 'baroque', 'ruins'];

export function run() {
  const out: any[] = [];
  for (let i = 0; i < STYLES.length; i++) {
    const style = STYLES[i];
    const civ: any = {
      present: true,
      name: 'Test',
      techLevel: 0.15 + (i / STYLES.length) * 0.8,
      population: 4.2e6,
      cityCount: 8,
      style,
      structure: [0.34, 0.33, 0.31],
      neon: [0.25, 1.4, 2.2],
      orbital: 0.4,
      decay: style === 'ruins' ? 0.8 : 0.08,
    };
    const planet = makePlanet(i * 13.7);
    planet.spec = { seed: 1000 + i * 7, civilization: civ, name: 'Test' };

    const t0 = Date.now();
    const sites = placeSettlements(planet, civ, 2200);
    const tPlace = Date.now() - t0;
    if (!sites.length) {
      out.push({ style, error: 'no sites placed' });
      continue;
    }

    const site = sites[0];
    const frame = new TangentFrame(site.dir, R, site.elevation);
    const hf = new Heightfield(frame, site.radius * 1.45, 96, SEA - R);
    const t1 = Date.now();
    while (!hf.fill(planet, 4000));
    const tHeights = Date.now() - t1;

    const t2 = Date.now();
    const layout = buildLayout(site, civ, hf, { maxBuildings: 2100, detail: 1, traffic: 40 });
    const tLayout = Date.now() - t2;

    const t3 = Date.now();
    const gen = emitCity(layout, hf, civ, { detail: 1, traffic: 40, signs: 26 });
    let slices = 0;
    let res = gen.next();
    while (!res.done) {
      res = gen.next();
      if (++slices > 500) throw new Error('emitter never finished');
    }
    const geo: any = res.value;
    const tEmit = Date.now() - t3;

    const verts = (g: any) => (g ? g.getAttribute('position').count : 0);
    const tris = (g: any) => (g && g.index ? g.index.count / 3 : 0);

    out.push({
      style,
      sites: sites.length,
      kinds: sites.map((s: any) => s.kind).join(','),
      radius: Math.round(site.radius),
      pattern: layout.pattern,
      streets: layout.streets.length,
      blocks: layout.blocks.length,
      buildings: layout.buildings.length,
      props: layout.props.length,
      lanes: layout.lanes.length,
      skyline: Math.round(layout.skylineHeight),
      cityTris: Math.round(tris(geo.city)),
      cityVerts: verts(geo.city),
      roadTris: Math.round(tris(geo.road)),
      groundTris: Math.round(tris(geo.ground)),
      holoTris: Math.round(tris(geo.holo)),
      traffic: geo.traffic ? geo.traffic.instanceCount : 0,
      obstacles: geo.obstacles.length,
      slices,
      ms: { place: tPlace, heights: tHeights, layout: tLayout, emit: tEmit },
    });
  }
  return out;
}
`
);

const bundle = path.join(dir, 'bundle.mjs');
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  external: ['three'],
  logLevel: 'error',
});

const mod = await import(pathToFileURL(bundle).href);
const rows = mod.run();
let bad = 0;
for (const r of rows) {
  if (r.error) {
    bad++;
    console.log(`${r.style.padEnd(12)} ERROR ${r.error}`);
    continue;
  }
  if (r.buildings === 0 || r.cityTris === 0) bad++;
  console.log(
    `${r.style.padEnd(12)} ${r.pattern.padEnd(8)} r=${String(r.radius).padStart(5)}m  ` +
      `blocks ${String(r.blocks).padStart(5)}  bldgs ${String(r.buildings).padStart(5)}  ` +
      `tris ${String(r.cityTris).padStart(6)}/${String(r.roadTris).padStart(5)}/${String(r.groundTris).padStart(5)}/${String(r.holoTris).padStart(4)}  ` +
      `streets ${String(r.streets).padStart(4)}  props ${String(r.props).padStart(4)}  cars ${String(r.traffic).padStart(4)}  ` +
      `skyline ${String(r.skyline).padStart(4)}m  ` +
      `[place ${r.ms.place} · height ${r.ms.heights} · layout ${r.ms.layout} · emit ${r.ms.emit} ms in ${r.slices} slices]`
  );
  console.log(`             sites: ${r.kinds}`);
}
rmSync(dir, { recursive: true, force: true });
if (bad) {
  console.error(`\n${bad} style(s) produced nothing.`);
  process.exit(1);
}
console.log('\nall styles generated.');
