/**
 * Device profiling and quality tiers.
 *
 * The same build runs on a phone and on a desktop with a discrete GPU. Rather
 * than shipping a settings menu nobody opens, ÆON profiles the device once at
 * boot, picks a tier, and then *keeps watching the frame time* — if the GPU is
 * drowning, quality steps down automatically; if there is headroom, it steps
 * back up. The player should never see a slideshow, and should never be given
 * a worse picture than their hardware can afford.
 */

export type Tier = 'potato' | 'low' | 'medium' | 'high' | 'ultra';

export interface QualityProfile {
  tier: Tier;
  /** Render-target scale relative to CSS pixels (before DPR clamp). */
  renderScale: number;
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  shadowCascades: number;
  /** Terrain quadtree: max subdivision depth and per-frame build budget. */
  terrainMaxDepth: number;
  terrainBudgetPerFrame: number;
  terrainPatchRes: number;
  /** Volumetric cloud raymarch steps. 0 disables volumetrics. */
  cloudSteps: number;
  atmosphereSteps: number;
  bloom: boolean;
  ssao: boolean;
  depthOfField: boolean;
  motionBlur: boolean;
  antialias: 'none' | 'fxaa' | 'smaa';
  /** Multiplier on all instanced scatter (grass, rocks, trees, crowds). */
  scatterDensity: number;
  /** Draw distance multiplier for scattered detail. */
  scatterDistance: number;
  particleBudget: number;
  cosmicWebParticles: number;
  anisotropy: number;
  waterReflections: boolean;
}

const PROFILES: Record<Tier, QualityProfile> = {
  potato: {
    tier: 'potato',
    renderScale: 0.6,
    maxPixelRatio: 1,
    shadows: false,
    shadowMapSize: 512,
    shadowCascades: 1,
    terrainMaxDepth: 9,
    terrainBudgetPerFrame: 1,
    terrainPatchRes: 17,
    cloudSteps: 0,
    atmosphereSteps: 6,
    bloom: true,
    ssao: false,
    depthOfField: false,
    motionBlur: false,
    antialias: 'none',
    scatterDensity: 0.12,
    scatterDistance: 0.4,
    particleBudget: 2000,
    cosmicWebParticles: 24576,
    anisotropy: 1,
    waterReflections: false,
  },
  low: {
    tier: 'low',
    renderScale: 0.72,
    maxPixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    shadowCascades: 2,
    terrainMaxDepth: 11,
    terrainBudgetPerFrame: 2,
    terrainPatchRes: 25,
    cloudSteps: 12,
    atmosphereSteps: 8,
    bloom: true,
    ssao: false,
    depthOfField: false,
    motionBlur: false,
    antialias: 'fxaa',
    scatterDensity: 0.3,
    scatterDistance: 0.6,
    particleBudget: 6000,
    cosmicWebParticles: 65536,
    anisotropy: 2,
    waterReflections: false,
  },
  medium: {
    tier: 'medium',
    renderScale: 0.85,
    maxPixelRatio: 1.75,
    shadows: true,
    shadowMapSize: 1536,
    shadowCascades: 3,
    terrainMaxDepth: 13,
    terrainBudgetPerFrame: 3,
    terrainPatchRes: 33,
    cloudSteps: 24,
    atmosphereSteps: 12,
    bloom: true,
    ssao: true,
    depthOfField: false,
    motionBlur: false,
    antialias: 'smaa',
    scatterDensity: 0.6,
    scatterDistance: 0.85,
    particleBudget: 14000,
    cosmicWebParticles: 147456,
    anisotropy: 4,
    waterReflections: true,
  },
  high: {
    tier: 'high',
    renderScale: 1.0,
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    shadowCascades: 3,
    terrainMaxDepth: 15,
    terrainBudgetPerFrame: 4,
    terrainPatchRes: 41,
    cloudSteps: 40,
    atmosphereSteps: 16,
    bloom: true,
    ssao: true,
    depthOfField: true,
    motionBlur: true,
    antialias: 'smaa',
    scatterDensity: 1.0,
    scatterDistance: 1.0,
    particleBudget: 30000,
    cosmicWebParticles: 262144,
    anisotropy: 8,
    waterReflections: true,
  },
  ultra: {
    tier: 'ultra',
    renderScale: 1.0,
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 3072,
    shadowCascades: 4,
    terrainMaxDepth: 16,
    terrainBudgetPerFrame: 6,
    terrainPatchRes: 49,
    cloudSteps: 64,
    atmosphereSteps: 24,
    bloom: true,
    ssao: true,
    depthOfField: true,
    motionBlur: true,
    antialias: 'smaa',
    scatterDensity: 1.5,
    scatterDistance: 1.35,
    particleBudget: 60000,
    cosmicWebParticles: 393216,
    anisotropy: 16,
    waterReflections: true,
  },
};

const TIER_ORDER: Tier[] = ['potato', 'low', 'medium', 'high', 'ultra'];

export interface DeviceInfo {
  isMobile: boolean;
  isTouch: boolean;
  isSafari: boolean;
  cores: number;
  memoryGB: number;
  gpu: string;
  dpr: number;
  maxTextureSize: number;
  supportsFloatBlend: boolean;
  supportsColorBufferFloat: boolean;
}

export function probeDevice(gl: WebGL2RenderingContext | null): DeviceInfo {
  const ua = navigator.userAgent;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua) || (isTouch && Math.min(screen.width, screen.height) < 820);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

  let gpu = 'unknown';
  let maxTextureSize = 4096;
  let supportsFloatBlend = false;
  let supportsColorBufferFloat = false;
  if (gl) {
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    } catch {
      /* privacy-restricted; fall through */
    }
    maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    supportsFloatBlend = !!gl.getExtension('EXT_float_blend');
    supportsColorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
  }

  return {
    isMobile,
    isTouch,
    isSafari,
    cores: navigator.hardwareConcurrency || 4,
    memoryGB: (navigator as any).deviceMemory || (isMobile ? 4 : 8),
    gpu,
    dpr: window.devicePixelRatio || 1,
    maxTextureSize,
    supportsFloatBlend,
    supportsColorBufferFloat,
  };
}

/** Heuristic first guess. The adaptive loop corrects it within a few seconds. */
export function guessTier(d: DeviceInfo): Tier {
  const g = d.gpu.toLowerCase();

  // Software rasterisers — bail out hard.
  if (/swiftshader|llvmpipe|software|basic render/.test(g)) return 'potato';

  if (d.isMobile) {
    // Apple's mobile GPUs punch far above the rest of the phone market.
    if (/apple\s*(a1[4-9]|a2[0-9]|m[1-9])/.test(g)) return 'high';
    if (/apple/.test(g)) return 'medium';
    if (/adreno\s*(7[3-9]\d|8\d\d)/.test(g)) return 'medium';
    if (/mali-g7\d|mali-g[89]\d|immortalis/.test(g)) return 'medium';
    if (d.cores >= 8 && d.memoryGB >= 6) return 'low';
    return 'potato';
  }

  if (/rtx\s*(40|50)\d\d|rtx\s*30(8|9)0|radeon\s*rx\s*(7[89]|9)\d\d/.test(g)) return 'ultra';
  if (/rtx|radeon\s*rx\s*[5-9]\d\d\d|arc\s*a[5-9]\d\d/.test(g)) return 'high';
  if (/apple\s*m[1-9]/.test(g)) return 'high';
  if (/gtx\s*1[06][5-8]0|radeon\s*rx\s*[45]\d\d/.test(g)) return 'medium';
  if (/intel|uhd|iris/.test(g)) return d.cores >= 8 ? 'medium' : 'low';
  return d.cores >= 8 && d.memoryGB >= 8 ? 'high' : 'medium';
}

export interface UserPrefs {
  motionBlur: boolean;
  filmGrain: boolean;
  chromaticAberration: boolean;
  vignette: boolean;
  fovDeg: number;
  lookSensitivity: number;
  invertY: boolean;
  headBob: boolean;
  music: number;
  sfx: number;
  reduceMotion: boolean;
  showHud: boolean;
  autoQuality: boolean;
}

const PREF_KEY = 'aeon.prefs.v1';

export function defaultPrefs(): UserPrefs {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  return {
    motionBlur: !reduce,
    filmGrain: true,
    chromaticAberration: !reduce,
    vignette: true,
    fovDeg: 68,
    lookSensitivity: 1,
    invertY: false,
    headBob: !reduce,
    music: 0.7,
    sfx: 0.85,
    reduceMotion: reduce,
    showHud: true,
    autoQuality: true,
  };
}

export function loadPrefs(): UserPrefs {
  const base = defaultPrefs();
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) Object.assign(base, JSON.parse(raw));
  } catch {
    /* storage blocked — defaults are fine */
  }
  return base;
}

export function savePrefs(p: UserPrefs): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/**
 * Watches frame time and nudges the tier. Deliberately sluggish: it takes a
 * sustained problem (not one hitchy frame from a terrain build) to drop a tier,
 * and a long stretch of comfort to raise one.
 */
export class AdaptiveQuality {
  tier: Tier;
  profile: QualityProfile;
  onChange: ((p: QualityProfile) => void) | null = null;
  enabled = true;

  private samples: number[] = [];
  private cooldown = 3.0;
  private goodStreak = 0;
  private targetMs: number;
  private manualFloor = 0;

  constructor(tier: Tier, targetFps = 60) {
    this.tier = tier;
    this.profile = { ...PROFILES[tier] };
    this.targetMs = 1000 / targetFps;
  }

  /** Pin the tier and stop adapting (used by the settings panel). */
  setManual(tier: Tier): void {
    this.enabled = false;
    this.tier = tier;
    this.profile = { ...PROFILES[tier] };
    this.onChange?.(this.profile);
  }

  setAuto(): void {
    this.enabled = true;
    this.cooldown = 3;
  }

  update(dtMs: number): void {
    if (!this.enabled) return;
    // Ignore obvious stalls (tab switch, shader compile, GC pause).
    if (dtMs > 400) return;

    this.samples.push(dtMs);
    if (this.samples.length > 90) this.samples.shift();
    this.cooldown -= dtMs / 1000;
    if (this.cooldown > 0 || this.samples.length < 60) return;

    // 90th-percentile frame time: judge by the stutters, not the average.
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const idx = TIER_ORDER.indexOf(this.tier);

    if (p90 > this.targetMs * 1.65 && idx > this.manualFloor) {
      this.tier = TIER_ORDER[idx - 1];
      this.profile = { ...PROFILES[this.tier] };
      this.onChange?.(this.profile);
      this.samples.length = 0;
      this.cooldown = 6;
      this.goodStreak = 0;
    } else if (p90 < this.targetMs * 0.72 && idx < TIER_ORDER.length - 1) {
      this.goodStreak++;
      // Require several consecutive comfortable windows before climbing.
      if (this.goodStreak >= 4) {
        this.tier = TIER_ORDER[idx + 1];
        this.profile = { ...PROFILES[this.tier] };
        this.onChange?.(this.profile);
        this.samples.length = 0;
        this.cooldown = 8;
        this.goodStreak = 0;
      } else {
        this.cooldown = 2;
      }
    } else {
      this.goodStreak = 0;
      this.cooldown = 2;
    }
  }
}

export function profileFor(tier: Tier): QualityProfile {
  return { ...PROFILES[tier] };
}

export { PROFILES, TIER_ORDER };
