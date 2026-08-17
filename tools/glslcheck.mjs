#!/usr/bin/env node
/**
 * Static guard over every shader in the project.
 *
 * This project has lost real time three separate times to a fragment program
 * that failed to compile — silently, because a failed program neither throws
 * nor draws, it just leaves the object absent. Twice the cause was the same:
 * a perfectly ordinary variable name that happens to be reserved in GLSL ES
 * 3.0. `float patch` cost a commit. `vec2 half` hid an entire civilisation
 * subsystem — the city generated, the geometry installed, the buffers were
 * correct, and nothing appeared.
 *
 * A regex finds both in about forty milliseconds. There is no excuse for
 * learning it a third time from a screenshot.
 *
 *   node tools/glslcheck.mjs [--verbose]
 */

import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

const VERBOSE = process.argv.includes('--verbose');

/**
 * Reserved and future-reserved in GLSL ES 3.00 (§3.7), minus the ones that are
 * also legal in the version we target. Using any of these as an identifier is
 * a compile error, and the error message names the token but not the file.
 */
const RESERVED = [
  'asm', 'attribute', 'cast', 'class', 'coherent', 'common', 'double', 'enum',
  'extern', 'external', 'filter', 'fixed', 'fvec2', 'fvec3', 'fvec4', 'goto',
  'half', 'hvec2', 'hvec3', 'hvec4', 'inline', 'input', 'interface', 'long',
  'namespace', 'noinline', 'output', 'packed', 'partition', 'patch', 'public',
  'resource', 'restrict', 'sample', 'short', 'sizeof', 'static', 'subroutine',
  'superp', 'template', 'this', 'typedef', 'union', 'unsigned', 'using',
  'varying', 'volatile',
];

/** Every type a declaration can start with. */
const TYPES = [
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'bvec2', 'bvec3', 'bvec4',
  'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4',
  'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'samplerCube', 'sampler3D', 'sampler2DArray',
];

const DECL = new RegExp(`\\b(${TYPES.join('|')})\\s+(${RESERVED.join('|')})\\b`, 'g');

/**
 * Does this template literal look like a shader?
 *
 * Deliberately generous: a false positive costs one harmless scan, and a false
 * negative is the whole point of the tool. Anything holding a `main`, a GLSL
 * builtin or a three.js include chunk gets checked.
 */
function looksLikeGlsl(text) {
  return (
    /\bvoid\s+main\s*\(/.test(text) ||
    /\bgl_(Position|FragColor|PointSize|FragCoord|PointCoord|FragDepth)\b/.test(text) ||
    /#include\s+</.test(text) ||
    /^\s*(uniform|attribute|varying|in|out)\s+\w+\s+\w+\s*;/m.test(text)
  );
}

/** Pull every template literal out of a TypeScript source, with line numbers. */
function templateLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // Skip over ordinary strings and comments so their backticks do not count.
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '`') {
      const start = i + 1;
      i++;
      let depth = 0;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        // `${...}` can itself contain backticks; track the nesting.
        if (src[i] === '$' && src[i + 1] === '{') {
          depth++;
          i += 2;
          continue;
        }
        if (depth > 0 && src[i] === '}') {
          depth--;
          i++;
          continue;
        }
        if (depth === 0 && src[i] === '`') break;
        i++;
      }
      out.push({ text: src.slice(start, i), offset: start });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

function lineOf(src, offset) {
  return src.slice(0, offset).split('\n').length;
}

const files = globSync('src/**/*.ts', { cwd: process.cwd() });
const problems = [];
let scanned = 0;

for (const rel of files) {
  const abs = path.resolve(rel);
  const src = readFileSync(abs, 'utf8');
  for (const lit of templateLiterals(src)) {
    if (!looksLikeGlsl(lit.text)) continue;
    scanned++;
    DECL.lastIndex = 0;
    let m;
    while ((m = DECL.exec(lit.text)) !== null) {
      problems.push({
        file: rel,
        line: lineOf(src, lit.offset + m.index),
        type: m[1],
        word: m[2],
        text: m[0],
      });
    }
  }
}

if (VERBOSE) console.log(`scanned ${scanned} shader blocks across ${files.length} files`);

if (problems.length) {
  console.error(`\n${problems.length} reserved word(s) used as identifiers in GLSL:\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  "${p.text}"  — '${p.word}' is reserved in GLSL ES 3.0`);
  }
  console.error(
    '\nA shader that uses one of these fails to compile, and a failed program is\n' +
      'silent: it does not throw and it does not draw. Rename the identifier.\n'
  );
  process.exit(1);
}

console.log(`glslcheck: ${scanned} shader blocks clean.`);
