# ÆON — handoff

State of the project as of the merge of `claude/project-completion-shipping-du9z7k`.
Read `CLAUDE.md` first for the engineering conventions; this document is only
about *where things actually stand* and what will bite you.

---

## 1. How to get moving in five minutes

```bash
npm install
npm run check              # typecheck · GLSL guard · build · city generator
npm run dev                # http://localhost:5173

# before touching a shader, and after: compiles every material the game can
# build against a real WebGL2 driver. CI runs it on every push.
npm run shadercheck

# what is eating the frame — ~90 seconds, no screenshots
node tools/perf.mjs --view orbit          # orbit | ground | system | galaxy | cosmos

# what it actually looks like — minutes per shot, see §2
node tools/shoot.mjs --tier low --width 640 --height 360 --shots planet-orbit

# does the city generator still produce cities — 4 seconds, no browser
node tools/civcheck.mjs

# is a frame slow or is the page hung — 30 seconds
node tools/probe.mjs --tier low

# watch one city stream in, phase by phase
node tools/citywatch.mjs --tier medium --fast --post
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
| `setShadows(bool)` | shadows off — the single biggest ground-shot cost |
| `stream(ms)` | terrain build budget per frame; raise it for offline capture |
| `teleport(realm, opts)` | switch realm *and* pose the shot in one call |
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
| **Surface, on foot** | Terrain, 150 k scatter instances, the starship landed on its gear and the rover parked beside it, all in one frame. |
| **Cities** | Generate and install end to end: sites placed, heightfield graded, layout built, geometry emitted (6 meshes, 59 k vertices). Verified by numbers and by `civcheck`, **not** yet by a clean photograph — see §4.1. |
| **Starship** | Flies, lands on the gear, takes impact damage, boards and disembarks. |

---

## 4. What is broken — start here

### 4.1 A ground-level city has never been photographed cleanly

The city itself is fine — this is a terrain-streaming problem and it is the one
thing left blocking the visual review of civilization.

A terrain patch on a 12,000 km world costs roughly **200 ms** to generate on
SwiftShader. Standing in a city the LOD wants ~1,580 patches and a run reaches
~450 before it has to end, so the skyline sits partly *below* ground that has
not refined. What you see is lamp posts poking through a smooth plain.

Everything else about the city is confirmed by numbers rather than by picture:

- `civcheck` transforms emitted vertices back to planet-local through the
  settlement's own basis and asserts they land on the surface at the site.
- `planetDebug().civ` reports `nearestM`, `nearestRadius`, `readyMeshes` and
  `readyVerts` — the numbers that separate "the camera is nowhere near it" from
  "it is right there and the geometry is wrong".
- A settlement now pins terrain detail over its own footprint as it starts
  emitting, so on hardware that can stream it, a city cannot be buried.

**On a machine with a GPU this should just work.** That is the first thing to
check, and it is cheap: `node tools/citywatch.mjs --tier high`.

### 4.2 Surface look, still unjudged

The substrate work in `cae0911` has now been *seen* but not judged: the vista
capture shows terrain, scatter and both vehicles, on a snow world under heavy
overcast, which flatters nothing. Re-shoot on a temperate world before drawing
conclusions about the substrate bands or `uScatterGain`.

Note that every ground shot before this branch was lit by accident — see the
`frameSunAt` entry in §5 — so any earlier judgement about surface lighting was
made against an arbitrary time of day.

### 4.3 Player pose

The character rendered sprawled/horizontal rather than standing. Not diagnosed.
`planetDebug().player` now reports `{alt, grounded, view, speed}` — check
`grounded` first. `CharacterMesh.update` picks an airborne pose when
`!grounded && swimming < 0.5 && jetpack < 0.5`, and a swim pose when
`swimming > 0.5`; the observed limbs-out pose matches both.

### 4.4 Never rendered even once

Wildlife, weather, audio, mobile touch controls, and the rover in motion.
`surface-ocean` has never produced an image.

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
- Declaring `vec2 half` — also reserved, and it cost the entire civilisation
  subsystem. The city generated perfectly, the geometry installed, the buffers
  were correct, and nothing appeared, for hours.
- Injecting the noise library *after* code that calls into it.

`tools/shoot.mjs` prints shader errors the instant they appear **and now exits
non-zero on one**. Keep both. Every shot "succeeded" while the city was
invisible; a harness that reports success in that state is worse than no
harness. `citywatch.mjs` does the same.

**Shared scratch vectors do not survive a call.** `frameSunAt` took its up
vector from the module's `_tmp` and then called `updateSun()` in a loop;
`updateSun` writes `_tmp` when it snaps the shadow camera to the texel grid. So
every ground shot has been lit by an arbitrary time of day — the city measured
46° when it asked for 11°. If a function calls anything, it holds its own
vectors.

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

**A screen-space error target has no upper bound.** Terrain patch count grows
as (screenH / pixelError)²; on a 12,000 km world it settled at 2,543 against a
cap of 500, and eviction could not help because every one of them was being
selected that frame and none was stale. `QuadSphere` now contracts split
distances 2% a frame over budget and relaxes 1% a frame under it. A cap that
only reclaims idle resources is not a cap.

**Unbounded synchronous loops read as hangs.** `prime(320)` was over a million
terrain evaluations in one statement; from inside a `page.evaluate` that is
indistinguishable from a crash. Anything that scales with world size gets both
a count bound and a wall-clock bound.

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
  civ/        Civilization (orchestration + streaming), Placement (where
              settlements go), Layout (the plan), Build (the triangles),
              CivMath, Materials, Glyphs, CivTypes
  entities/   Player, CameraRig, CharacterMesh, Rover, Starship, ShipMesh,
              Motion, Materials
  ui/         Hud, Markers, TouchControls, Theme, Learn, Dom, Glyphs
  audio/      AudioEngine, Music, Instruments, Dsp, Graph, Theory, Voices
tools/
  shoot.mjs   screenshot harness (the visual review loop)
  perf.mjs    frame-cost probe, one layer at a time
  diag.mjs    boot diagnostic with a short leash
  civcheck.mjs  headless city generation over all eight styles, 4 s, no browser
  probe.mjs     per-realm frame timing — slow harness vs hung one
  citywatch.mjs watch one city stream in, phase by phase
```

~35k lines.

---

## 7. Suggested order of work

1. **Shoot a city on real hardware** (§4.1). Everything says it is there; the
   only thing missing is a machine that can stream the ground under it.
   `node tools/citywatch.mjs --tier high` is the whole test.
2. **Re-judge the surface on a temperate world**, now that the sun framing is
   no longer scanning against a corrupted vector (§4.2).
3. **Player pose** (§4.3) — `planetDebug().player.grounded` is the first check.
4. **`surface-ocean`** — the near-field ocean with Gerstner waves is still dark.
5. **Wildlife, weather, audio, touch controls** — all still dark.
6. Only then go back for polish: galaxy hint text, the framebuffer feedback
   warning, shadow verification, a higher-resolution pass on the hero shots.

## 8. What CI enforces

`ci.yml` runs on every pull request and on the default branch:

| Job | Covers |
| --- | --- |
| `typecheck · shaders (static) · build · generators` | `npm run check`, plus it uploads the built `dist` as an artifact so a branch can be looked at without deploying over the live page. ~20 s. |
| `shaders (compiled)` | Every material the game can build, linked against real WebGL2 with the engine's own renderer configuration. ~45 s. |

`deploy.yml` runs the same gate before publishing to Pages, so the live build at
https://majveia.github.io/AAA-Universe/ is always one that passed.

None of this can judge a picture. It only guarantees that what you are looking
at is the thing the code describes — which, given §5, is not a small guarantee.

---

A note on judging: "it renders" has been wrong every single time in this
project. Every realm had a first-render bug that was invisible from the code,
the console, the draw-call count and the frame rate, and visible only in a
screenshot. Look at the picture.
