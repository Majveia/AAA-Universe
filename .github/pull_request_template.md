## What changed

<!-- What this does, and why it is the right shape. Not a list of files. -->

## Why

<!-- The problem. If it is a bug, what the symptom was and what actually caused
     it — those are usually not the same thing in this project. -->

## Verification

- [ ] `npm run check` clean (typecheck · GLSL guard · build · city generator)
- [ ] `npm run shadercheck` clean — **required for any change to a shader**
- [ ] Looked at a picture, if this changes anything visual

<!-- Which shots, and what they showed. "It renders" has been wrong every single
     time in this repository; say what you actually saw. Paste the capture. -->

## Performance

<!-- Draw calls and frame cost if this touches the render path. `node
     tools/perf.mjs --view <realm>` is ninety seconds and answers it. -->

## Known gaps

<!-- What you did not verify, and why. Being explicit here is worth more than
     an optimistic checklist. -->
