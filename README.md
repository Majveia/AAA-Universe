# ÆON

A living, procedurally generated universe rendered in real time in a browser —
from the cosmic web down to a footprint in the sand, without a loading screen
between them.

**[▶ Play the current build](https://majveia.github.io/AAA-Universe/)** ·
[Engineering conventions](CLAUDE.md) · [Where things stand](HANDOFF.md)

[![CI](https://github.com/Majveia/AAA-Universe/actions/workflows/ci.yml/badge.svg)](https://github.com/Majveia/AAA-Universe/actions/workflows/ci.yml)
[![Deploy](https://github.com/Majveia/AAA-Universe/actions/workflows/deploy.yml/badge.svg)](https://github.com/Majveia/AAA-Universe/actions/workflows/deploy.yml)

---

## What it is

Four scales, one continuous world, seeded from a single string:

| Realm | What you are looking at |
| --- | --- |
| **Cosmos** | 262,144 particles carrying the large-scale structure of the universe, integrated on the GPU with a Zel'dovich approximation and a particle-mesh solve. You can run cosmic time and watch the filaments collapse. |
| **Galaxy** | A raymarched barred spiral — core, bar, arms, dust lanes — with its stellar population streamed in over it. |
| **System** | Real Keplerian orbits at one unit per metre, floating origin, logarithmic depth. Accelerate time and it becomes an orrery. |
| **Surface** | A quadsphere LOD planet with analytic terrain, ocean, atmosphere and a raymarched cloud deck. Land on it, get out, and walk. |

You explore **on foot**, **in a rover**, and **in a ship** — the same world, three
control schemes, no transition you cannot see through.

Everything is generated. There are no texture or model files in this repository
and there never will be: rust, cracked plaster, lit windows with furniture
behind them, an alien writing system — all of it is noise, SDFs, procedural
meshes and shader-authored material, computed per fragment.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

Controls appear on screen and teach themselves; `Tab` opens settings, `P` is
photo mode.

## Verifying it

```bash
npm run check        # typecheck · GLSL guard · build · city generator  (~1 min)
npm test             # the above, plus compiling every shader for real  (~2 min)
```

Individually:

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | The types hold. |
| `npm run glslcheck` | No shader declares an identifier that is reserved in GLSL ES 3.0. Runs in 40 ms. |
| `npm run shadercheck` | Every material the game can build actually compiles and links against a real WebGL2 driver, with the engine's own renderer configuration. |
| `npm run civcheck` | All eight architectural styles generate a complete city, and its geometry lands on the planet surface where the settlement is. |
| `npm run build` | It ships. |

### Why so much of this is about shaders

A fragment program that fails to compile does not throw and does not draw. The
object is simply *absent*, and everything around it looks fine. This project has
lost real time to that three separate times — most expensively when the façade
shader declared `vec2 half`, which is a reserved word, and an entire generated
city rendered as nothing at all while every test passed.

So `glslcheck` and `shadercheck` run on every push, and the screenshot harness
exits non-zero the moment a program fails to link. See §5 of
[HANDOFF.md](HANDOFF.md) for the rest of the list; it is worth reading before
touching a shader.

## Looking at it

Rendering is judged by pictures, not by whether it threw:

```bash
node tools/shoot.mjs                       # the full shot list
node tools/shoot.mjs --shots surface-vista --tier low --width 640 --height 360
node tools/perf.mjs --view ground          # what is eating the frame
node tools/citywatch.mjs --tier high       # watch a city stream in, phase by phase
node tools/probe.mjs                       # per-realm frame timing
```

`window.__aeon` is the debug bridge all of these drive — `setRealm`,
`planetView`, `planetDebug`, `teleport`, `stream`, `setPost`, `setShadows`,
`stats`. Keep it working; every hard bug in this project was found through it.

## Layout

```
src/
  core/       engine, renderer, post FX, input, settings, noise, RNG
  universe/   seeded generators + shared types
  api/        Contracts.ts — the treaty between modules
  realms/     cosmos / galaxy / system / surface composition
  cosmos/     cosmic web simulation and rendering
  galaxy/     galaxy rendering, nebulae, skybox
  planet/     quadsphere LOD terrain, atmosphere, ocean, clouds
  surface/    scatter (flora/rocks), wildlife, weather
  civ/        placement, layout, geometry, materials, a writing system
  entities/   player, camera rig, rover, starship
  ui/         HUD, touch controls, menus, photo mode
  audio/      procedural music and SFX
```

Cross-module contracts go through `src/api/Contracts.ts`. `core/`, `universe/`,
`api/` and `realms/` are integration-owned — see [CLAUDE.md](CLAUDE.md).

## The bar

Every visual is judged against No Man's Sky, Starfield, Outer Wilds, Breath of
the Wild and Pacific Drive. "It renders" is not done, and it has been wrong
every single time in this project. Look at the picture.

60 fps on desktop, 30+ on mobile. Everything streams; nothing hitches.

## Licence

MIT — see [LICENSE](LICENSE).
