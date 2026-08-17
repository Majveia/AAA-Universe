# ÆON — handoff

State of the project as of commit `31d3b79` on branch
`claude/aaa-3d-universe-threejs-x9kbrt`. Read `CLAUDE.md` first for the
engineering conventions; this document is only about *where things actually
stand* and what will bite you.

---

## 1. How to get moving in five minutes

```bash
npm install
npm run typecheck          # must be clean before anything else
npm run dev                # http://localhost:5173

# what is eating the frame — ~90 seconds, no screenshots
node tools/perf.mjs --view orbit          # orbit | ground | system | galaxy | cosmos

# what it actually looks like — minutes per shot, see §2
node tools/shoot.mjs --tier low --width 640 --height 360 --shots planet-orbit
```

`window.__aeon` is the debug bridge the harnesses drive. The useful ones:

| Call | Does |
| --- | --- |
| `setRealm(id)` | `cosmos` / `galaxy` / `system` / `surface` |
| `planetView({mode})` | `orbit` `limb` `vista` `ground` `city` `night` `ocean` |
| `planetDebug()` | terrain LOD, scatter counts, weather, player state |
| `galaxyDebug()` | type, arms, stream-in progress |
| `planetLayer(name, bool)` | isolate `terrain` `ocean` `atmosphere` `clouds` |
| `plainTerrain(bool)` | swap terrain for MeshNormalMaterial |
| `setPost(bool)` | bypass the whole post chain |
| `stats()` | fps, draw calls, tier, realm |

Keep these working. Every hard bug in this project was found by bisecting with
them, and several were invisible without them.

---

## 2. Why iteration is slow, and how to not make it worse

**There is no GPU.** The harness runs headless Chromium on SwiftShader, a
software rasteriser. A planet-surface frame at 640×360 costs ~70–100 ms of CPU.
A single shot needs terrain streaming to settle, a 10 s settle, and a
screenshot — 2–4 minutes each, before anything is wrong.

Consequences that are worth internalising:

- **Cost a shader with `perf.mjs` before committing it to a screenshot run.**
  Two of the slowest bugs in this project (a 243-cell-per-pixel starfield, a
  galaxy volume doing 128 noise evaluations per pixel) would have been caught
  in 90 seconds instead of 20 minutes.
- **A run only tests the build it started with.** If shot 1 reveals a bug,
  shots 2–4 are testing stale code. Kill and restart rather than reading them.
- **Screenshot timeouts are not always frame rate.** See §5, "the HUD one".
- `pkill -f "shoot.mjs"` matches its own shell and kills it (exit 144). Use
  `pgrep -f "shoot\.mjs" | xargs -r kill`.

---

## 3. What is verified working, with evidence

Each of these has been seen in a capture, not merely compiled.

| Area | State |
| --- | --- |
| **Cosmic web** | Dark voids, blue filaments and sheets, gold cluster cores. Zel'dovich + PM solve on GPU, ΛCDM growth factor. Looks right. |
| **Galaxy** | Barred spiral: golden core, bar, arms, dust lanes, blue outer disc, resolved stars over the diffuse body. |
| **System** | Orbit ellipses, star with corona, deep-sky backdrop, correct flight HUD. Captures only when the galaxy realm has not run first. |
| **Planet from orbit** | Terrain with continents, ocean with depth-graded colour, atmospheric limb, cloud deck. |
| **Deep sky** | Starfield with Planck-locus colour, galaxy band with dust lanes, nebulae, local star disc. Fades under daylight. |
| **World selection** | Lands on a terran world with an ocean, standing ~112 m above the waterline. |

---

## 4. What is broken — start here

### 4.1 Surface shots time out (live regression, introduced by `cae0911`)

`surface-vista` and `surface-first` now exceed the 180 s screenshot timeout.
Before the scatter fix they captured fine.

Cause is almost certainly draw-call count. `ScatterSystem` creates **one
InstancedMesh per (cell, species)**. With the corrected cell size (~96 m) the
draw radius holds ~29 cells, and `SurfaceRealm.debugView` calls `prime(320)`,
which builds far more than that synchronously. 320 cells × ~5 species ≈ 1600
draw calls.

Fixes worth trying, in order:
1. Drop `prime(320)` to `prime(40)` — the draw radius only needs ~29 cells.
2. Merge all species of one cell into a single InstancedMesh keyed by a
   per-instance species index, so a cell is 1 draw call rather than 5.
3. Confirm with `planetDebug().scatter` — it reports `cells`, `meshes`,
   `instances`, `cellSizeM`, `pending`.

### 4.2 Surface still does not look good

Even before the timeout, the ground was wrong. The substrate work in `cae0911`
is committed but **has never been seen** — the first run after it hit the
`patch` reserved-word error, and the second timed out. So:

- Terrain substrate variation (40 m / 150 m bands, clumped vegetation, pebble
  speckle): **written, compiles, unverified.**
- Sky brightness from the ground (`uScatterGain` 0.38 → 1.0): **unverified.**
- Scatter appearing at all: **unverified.**

### 4.3 Player pose

The character rendered sprawled/horizontal rather than standing. Not diagnosed.
`planetDebug().player` now reports `{alt, grounded, view, speed}` — check
`grounded` first. `CharacterMesh.update` picks an airborne pose when
`!grounded && swimming < 0.5 && jetpack < 0.5`, and a swim pose when
`swimming > 0.5`; the observed limbs-out pose matches both.

### 4.4 Never rendered even once

Wildlife, weather, cities/civilization, audio, mobile touch controls, the
rover in motion, the starship. `surface-city` and `surface-ocean` have never
produced an image.

### 4.5 Smaller known issues

- `system-wide` captures alone but times out if `galaxy-face` ran first.
- Galaxy hint text says "Q / E TO RUN COSMIC TIME" — that is cosmos copy.
- `Feedback loop formed between Framebuffer and active Texture` warning,
  uninvestigated, present since early on.
- No shadow verification. The cascade in `SurfaceRealm.updateSun` is
  configured and enabled but has not been seen working.

---

## 5. The gotcha list — hard-won, do not relearn these

**Shaders that compile until they don't.** Three separate black-screen bugs
came from a fragment program failing to compile. A failed program draws black,
silently. Causes hit so far:

- Writing `metalnessFactor` after `<roughnessmap_fragment>` — three declares it
  one chunk later. Inject after `<metalnessmap_fragment>`.
- Referencing a uniform that is in the JS uniform object but never declared in
  GLSL (`uSunColor`, `uSunIntensity`).
- Declaring `float patch` — reserved word in GLSL ES 3.0.
- Injecting the noise library *after* code that calls into it.

`tools/shoot.mjs` prints shader errors the instant they appear. Keep that.

**`Object3D.lookAt` is not camera-style.** For anything that is not a camera or
a light it builds the opposite orientation. `FlyCamera.lookAt` uses
`Matrix4.lookAt` for exactly this reason — using `Object3D.lookAt` aimed every
realm's camera 180° away from its subject and rendered black.

**Back-face shells lose the depth test over the planet.** The atmosphere shell
is `BackSide` so it can double as sky from underneath, which means over the
planet's disc it fails depth against the ground and contributes only the limb.
That is why terrain and ocean compute their own aerial perspective
(`src/planet/Aerial.ts`). The cloud shell flips `FrontSide`/`BackSide` per
frame on camera radius instead — see `CloudDeck.update`.

**Emissivity exponents are physics, not contrast knobs.** The cosmic web reads
as a glowing ball at ρ^0.92 and as a web at ρ^1.6, because recombination
emission scales as ρ². Reach for the physical value before the art knob.

**One irradiance convention.** The sun is passed to three's `DirectionalLight`
*and* to every custom shader in the same units, normalised so a surface of
albedo A returns radiance A under full sun (`intensity * π * 1.35`). Gains in
the atmosphere and ocean shaders were retuned to match. Do not change one side
alone.

**CSS `will-change` over a WebGL canvas.** 28 HUD marker slots each carried
`will-change: transform, opacity`, promoting every one to its own compositor
layer. Frames rendered at 14 fps but a screenshot never completed. Elements
already moved by `translate3d` gain nothing from promotion and cost GPU memory
per layer.

**Direction-space cell loops are cubic.** A starfield dicing 3-space and
looping 27 neighbours across three layers is 243 cell evaluations per pixel.
The same result on a 2D equirect grid is 9 per layer.

**Procedural fields are 2D when they are thin.** Cloud coverage on a deck a few
km thick over a body thousands of km across is a function of direction only.
Bake it once per frame into a small equirect texture and the raymarch does one
fetch per step instead of fifteen noise evaluations. `src/planet/Clouds.ts`.

**Cell grids must be sized in metres.** `2R/1024` is 24 km per cell on an
Earth-sized world. Derive the grid from a target edge length instead.

**Return values mean things.** `StarField.grow()` returned the increment rather
than the running total, so the galaxy never reported finishing streaming and
the harness waited 240 s per shot.

**Procedural generation is cubic too.** `systemsNear(120 ly)` covered 60,000
cells and generated a complete star system for each occupied one — tens of
seconds of blocked main thread. It now walks outward in Chebyshev shells and
stops at a limit.

---

## 6. Layout and ownership

Per `CLAUDE.md`, integration-owned: `core/`, `universe/`, `api/`, `realms/`.
Cross-module contracts go through `src/api/Contracts.ts`.

```
src/
  core/       Engine, PostFX, Noise, Rand, Input, Settings, Realm
  universe/   seeded generators (Universe.ts is the big one), Types
  api/        Contracts.ts
  realms/     Cosmos / Galaxy / System / Surface composition, FlyCamera,
              StarRenderer, BodyRenderer, Orbits
  cosmos/     CosmicWeb (GPGPU), Shaders, Cosmology, Field
  galaxy/     GalaxyModel, GalaxyRenderer, StarField, GalaxyVolume, Skybox
  planet/     Planet, QuadSphere, TerrainField, TerrainMaterial, Clouds, Aerial
  surface/    ScatterSystem, Wildlife, Weather, Env, Geo
  civ/        Civilization, CivMath, Materials, Glyphs
  entities/   Player, CameraRig, CharacterMesh, Rover, Motion, Materials
  ui/         Hud, Markers, TouchControls, Theme, Learn, Dom, Glyphs
  audio/      AudioEngine, Music, Instruments, Dsp, Graph, Theory, Voices
tools/
  shoot.mjs   screenshot harness (the visual review loop)
  perf.mjs    frame-cost probe, one layer at a time
  diag.mjs    boot diagnostic with a short leash
```

~30k lines. Roughly a third has never been rendered.

---

## 7. Suggested order of work

1. **Unblock the surface shots** (§4.1). Nothing else about the surface can be
   judged until a capture completes.
2. **Look at `surface-vista` and `surface-first`.** The substrate, sky and
   scatter work is all committed and all unverified; one capture tells you
   which of the three landed.
3. **Player pose** (§4.3) — `planetDebug().player.grounded` is the first check.
4. **`surface-city` and `surface-ocean`** — the first look at civilization and
   at the near-field ocean with Gerstner waves.
5. **Wildlife, weather, audio, touch controls** — all still dark.
6. Only then go back for polish: galaxy hint text, the framebuffer feedback
   warning, shadow verification, a higher-resolution pass on the hero shots.

A note on judging: "it renders" has been wrong every single time in this
project. Every realm had a first-render bug that was invisible from the code,
the console, the draw-call count and the frame rate, and visible only in a
screenshot. Look at the picture.
