/**
 * The entire HUD stylesheet, injected once into <head> and scoped under
 * `.aeon-hud`.
 *
 * Art direction, stated plainly so nobody "improves" it later:
 *
 *  - The screen belongs to the world. The HUD lives in the margins, never the
 *    middle, and is mostly invisible: it appears when it has something to say
 *    and dissolves when it doesn't.
 *  - One accent colour (a cold cyan that matches the boot mark), one warm
 *    signal colour reserved for danger. Everything else is ink at 20–70%.
 *  - Hairlines at exactly 1px, generous tracking, tabular numerals, and type
 *    that gets *smaller* rather than louder as it gets less important.
 *  - Nothing pops. Everything fades, over 200–600 ms, on a single easing curve
 *    (0.22, 1, 0.36, 1) — the curve that makes motion feel like it has mass.
 *  - Only `transform`, `opacity` and `filter` animate. Anything that would hit
 *    layout is set once at construction or on resize.
 */

export const HUD_STYLE_ID = 'aeon-hud-style';

export const HUD_CSS = `
.aeon-hud{
  --ae-ink:#e4ebf6;
  --ae-dim:#93a1b6;
  --ae-faint:rgba(228,235,246,.38);
  --ae-ghost:rgba(228,235,246,.16);
  --ae-hair:rgba(228,235,246,.14);
  --ae-hair-s:rgba(228,235,246,.28);
  --ae-accent:#6fd3ff;
  --ae-accent-d:rgba(111,211,255,.55);
  --ae-warm:#ffb27a;
  --ae-bad:#ff7a86;
  --ae-shadow:0 1px 12px rgba(0,0,0,.55);
  --ae-ease:cubic-bezier(.22,1,.36,1);
  --ae-ease-io:cubic-bezier(.4,0,.2,1);
  --ae-sans:ui-sans-serif,-apple-system,"SF Pro Text",Inter,"Segoe UI",system-ui,sans-serif;
  --ae-serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman",serif;
  --ae-mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --ae-st:env(safe-area-inset-top,0px);
  --ae-sb:env(safe-area-inset-bottom,0px);
  --ae-sl:env(safe-area-inset-left,0px);
  --ae-sr:env(safe-area-inset-right,0px);
  --ae-pad:clamp(14px,3.1vw,30px);
  --ae-micro:clamp(8px,1.5vw,9.5px);
  --ae-small:clamp(9.5px,1.7vw,11px);
  --ae-value:clamp(16px,2.5vw,21px);

  position:absolute; inset:0; overflow:hidden;
  pointer-events:none;
  z-index:40;
  color:var(--ae-ink);
  font-family:var(--ae-sans);
  font-variant-numeric:tabular-nums;
  font-feature-settings:"tnum" 1,"cv01" 1;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
  user-select:none; -webkit-user-select:none;
  contain:layout style;
}
.aeon-hud *{box-sizing:border-box;}

/* The stage holds everything that answers to setVisible(); the veil and the
   shutter flash deliberately sit outside it so a transition still reads even
   when the HUD is dismissed. */
.ae-stage{position:absolute;inset:0;opacity:1;transition:opacity .55s var(--ae-ease);}
.aeon-hud.ae-off .ae-stage{opacity:0;}
.aeon-hud.ae-photo .ae-h{opacity:0 !important;transition:opacity .4s var(--ae-ease);}
.aeon-hud.ae-off .ae-stage,.aeon-hud.ae-photo .ae-h{pointer-events:none;}

/* ═══════════════════ world markers ═══════════════════ */

.ae-markers{position:absolute;inset:0;contain:layout style paint;}
.ae-mk{
  position:absolute;left:0;top:0;width:0;height:0;
  color:var(--ae-ink);
  opacity:0;
  will-change:transform,opacity;
  transform:translate3d(-999px,-999px,0);
}
.ae-mk-g,.ae-mk-c{
  position:absolute;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;
  filter:drop-shadow(0 0 5px rgba(0,0,0,.75));
  transition:opacity .18s linear;
}
.ae-mk-c{opacity:0;}
.ae-mk.ae-edge .ae-mk-g{opacity:0;}
.ae-mk.ae-edge .ae-mk-c{opacity:1;}
.ae-mk-l{
  position:absolute;left:15px;top:0;
  transform:translateY(-50%);
  white-space:nowrap;
  opacity:0;
  transition:opacity .22s var(--ae-ease);
  text-shadow:0 1px 10px rgba(0,0,0,.9);
}
.ae-mk.ae-flip .ae-mk-l{left:auto;right:15px;text-align:right;}
.ae-mk-n{
  display:block;font-size:var(--ae-small);letter-spacing:.19em;
  text-transform:uppercase;color:var(--ae-ink);line-height:1.35;
}
.ae-mk-d{
  display:block;font-size:var(--ae-micro);letter-spacing:.14em;
  color:var(--ae-faint);line-height:1.4;
}
.ae-mk.ae-imp{color:var(--ae-accent);}
.ae-mk.ae-imp .ae-mk-g{filter:drop-shadow(0 0 7px var(--ae-accent-d));}
.ae-mk.ae-imp .ae-mk-n{color:#d8f3ff;}
.ae-mk.ae-anomaly .ae-mk-g{animation:ae-spin 22s linear infinite;}
.aeon-hud.ae-scanning .ae-mk{color:var(--ae-accent);}
.aeon-hud.ae-scanning .ae-mk-g{filter:drop-shadow(0 0 8px var(--ae-accent-d));}

@keyframes ae-spin{to{transform:rotate(360deg);}}

/* ═══════════════════ compass ═══════════════════ */

.ae-compass{
  position:absolute;top:calc(var(--ae-st) + clamp(12px,2.4vh,26px));
  left:50%;width:min(430px,54vw);height:26px;
  transform:translate3d(-50%,0,0);
  opacity:0;transition:opacity .5s var(--ae-ease);
}
.ae-compass.ae-on{opacity:.9;}
.ae-cp-win{
  position:absolute;inset:0;overflow:hidden;
  -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 20%,#000 80%,transparent 100%);
  mask-image:linear-gradient(90deg,transparent 0,#000 20%,#000 80%,transparent 100%);
}
.ae-cp-track{
  position:absolute;top:0;left:0;height:100%;width:2376px;
  will-change:transform;
  background-image:
    repeating-linear-gradient(90deg,var(--ae-ghost) 0 1px,transparent 1px 22px),
    repeating-linear-gradient(90deg,var(--ae-hair-s) 0 1px,transparent 1px 99px);
  background-position:0 12px,0 9px;
  background-size:22px 6px,99px 9px;
  background-repeat:repeat-x;
}
.ae-cp-lbl{
  position:absolute;top:1px;left:0;
  font-size:var(--ae-micro);letter-spacing:.24em;color:var(--ae-dim);
  transform:translateX(-50%);
  text-shadow:0 1px 8px rgba(0,0,0,.8);
}
.ae-cp-lbl.ae-card{color:var(--ae-ink);}
.ae-cp-pip{
  position:absolute;top:13px;left:0;width:5px;height:5px;margin-left:-2.5px;
  border:1px solid var(--ae-accent);transform:rotate(45deg);
  box-shadow:0 0 6px var(--ae-accent-d);
}
.ae-cp-head{
  position:absolute;left:50%;top:-1px;width:1px;height:9px;
  background:linear-gradient(180deg,var(--ae-ink),transparent);
  transform:translateX(-50%);
}

/* ═══════════════════ bottom-left: hints + location ═══════════════════ */

.ae-left{
  position:absolute;left:calc(var(--ae-sl) + var(--ae-pad));
  bottom:calc(var(--ae-sb) + var(--ae-pad));
  display:flex;flex-direction:column;gap:14px;align-items:flex-start;
  max-width:min(46vw,420px);
}
.ae-loc{opacity:1;transition:opacity .45s var(--ae-ease),transform .45s var(--ae-ease);}
.ae-loc.ae-swap{opacity:0;transform:translateY(6px);}
.ae-loc-rule{
  width:26px;height:1px;background:var(--ae-hair-s);margin-bottom:9px;
  transform-origin:left center;transform:scaleX(1);
  transition:transform .7s var(--ae-ease);
}
.ae-loc.ae-swap .ae-loc-rule{transform:scaleX(.1);}
.ae-loc-p{
  font-size:clamp(11px,1.9vw,13px);letter-spacing:.30em;text-transform:uppercase;
  color:var(--ae-ink);line-height:1.4;text-shadow:0 1px 12px rgba(0,0,0,.85);
}
.ae-loc-s{
  font-size:var(--ae-micro);letter-spacing:.22em;text-transform:uppercase;
  color:var(--ae-faint);line-height:1.6;margin-top:3px;
  text-shadow:0 1px 10px rgba(0,0,0,.8);
}

.ae-hints{display:flex;flex-direction:column;gap:7px;align-items:flex-start;}
.ae-hint{
  display:flex;align-items:center;gap:9px;
  opacity:0;transform:translateY(4px);
  transition:opacity .5s var(--ae-ease),transform .5s var(--ae-ease);
}
.ae-hint.ae-on{opacity:.72;transform:translateY(0);}
.ae-key{
  min-width:19px;height:17px;padding:0 5px;
  display:inline-flex;align-items:center;justify-content:center;
  border:1px solid var(--ae-hair-s);border-radius:3px;
  font-size:8.5px;letter-spacing:.1em;color:var(--ae-ink);
  background:rgba(8,12,20,.32);
}
.ae-hint-t{
  font-size:var(--ae-micro);letter-spacing:.2em;text-transform:uppercase;color:var(--ae-faint);
  text-shadow:0 1px 8px rgba(0,0,0,.8);
}

/* ═══════════════════ bottom-right: vitals rail ═══════════════════ */

.ae-rail{
  position:absolute;right:calc(var(--ae-sr) + var(--ae-pad));
  bottom:calc(var(--ae-sb) + var(--ae-pad));
  display:flex;flex-direction:column;align-items:flex-end;gap:11px;
  text-align:right;
}
.ae-ro{
  opacity:0;transform:translateY(7px);
  transition:opacity .42s var(--ae-ease),transform .42s var(--ae-ease);
  transition-delay:calc(var(--ae-i,0) * 55ms);
}
.ae-ro.ae-on{opacity:1;transform:translateY(0);}
.ae-ro.ae-out{opacity:0;transform:translateY(-5px);transition-duration:.3s;transition-delay:0ms;}
.ae-ro-h{
  font-size:var(--ae-micro);letter-spacing:.34em;text-transform:uppercase;
  color:var(--ae-faint);margin-bottom:1px;padding-right:.34em;
}
.ae-ro-b{display:flex;align-items:baseline;justify-content:flex-end;gap:4px;}
.ae-ro-v{
  font-size:var(--ae-value);font-weight:250;letter-spacing:.02em;line-height:1.06;
  color:var(--ae-ink);text-shadow:0 1px 14px rgba(0,0,0,.85);
}
.ae-ro-u{font-size:var(--ae-micro);letter-spacing:.16em;color:var(--ae-faint);}
.ae-ro-m{
  width:54px;height:1px;background:var(--ae-ghost);margin-top:6px;margin-left:auto;
  position:relative;overflow:hidden;
}
.ae-ro-m>i{
  position:absolute;inset:0;background:var(--ae-ink);
  transform-origin:right center;transform:scaleX(1);
  transition:transform .3s var(--ae-ease),background-color .5s linear;
}
.ae-ro.ae-warn .ae-ro-v{color:var(--ae-warm);}
.ae-ro.ae-warn .ae-ro-m>i{background:var(--ae-warm);}
.ae-ro.ae-crit .ae-ro-v{color:var(--ae-bad);animation:ae-pulse 1.6s var(--ae-ease-io) infinite;}
.ae-ro.ae-crit .ae-ro-m>i{background:var(--ae-bad);}
@keyframes ae-pulse{0%,100%{opacity:1;}50%{opacity:.42;}}

/* ═══════════════════ toasts + pointer prompt ═══════════════════ */

.ae-toasts{
  position:absolute;left:50%;bottom:calc(var(--ae-sb) + clamp(56px,11vh,104px));
  transform:translateX(-50%);
  display:flex;flex-direction:column;align-items:center;gap:7px;
  width:max-content;max-width:min(74vw,560px);
}
.ae-toast{
  opacity:0;transform:translateY(9px);
  transition:opacity .45s var(--ae-ease),transform .45s var(--ae-ease);
  font-size:var(--ae-small);letter-spacing:.24em;text-transform:uppercase;
  color:var(--ae-ink);text-align:center;line-height:1.6;
  text-shadow:0 1px 14px rgba(0,0,0,.9);
}
.ae-toast.ae-on{opacity:.92;transform:translateY(0);}
.ae-toast.ae-out{opacity:0;transform:translateY(-6px);}

.ae-prompt{
  position:absolute;left:50%;bottom:calc(var(--ae-sb) + clamp(22px,4.4vh,44px));
  transform:translateX(-50%);
  font-size:var(--ae-micro);letter-spacing:.32em;text-transform:uppercase;
  color:var(--ae-faint);white-space:nowrap;
  opacity:0;transition:opacity .6s var(--ae-ease);
  text-shadow:0 1px 12px rgba(0,0,0,.9);
}
.ae-prompt.ae-on{opacity:1;animation:ae-breathe 3.6s var(--ae-ease-io) infinite;}
@keyframes ae-breathe{0%,100%{opacity:.42;}50%{opacity:.95;}}

/* ═══════════════════ title card ═══════════════════ */

.ae-title{
  position:absolute;inset:0;display:none;place-items:center;
  opacity:0;
}
.ae-title.ae-on{display:grid;}
.ae-title-wash{
  position:absolute;inset:0;
  background:radial-gradient(78% 52% at 50% 42%,rgba(6,10,18,.62) 0%,rgba(6,10,18,0) 72%);
  opacity:0;transition:opacity 1.2s var(--ae-ease);
}
.ae-title.ae-play .ae-title-wash{opacity:1;}
.ae-title-in{
  position:relative;text-align:center;transform:translateY(-6vh);
  padding:0 8vw;
}
.ae-t-eyebrow{
  font-size:var(--ae-micro);letter-spacing:.62em;text-transform:uppercase;
  color:var(--ae-accent);opacity:0;margin-left:.62em;
  transform:translateY(10px);filter:blur(6px);
}
.ae-t-name{
  font-family:var(--ae-serif);
  font-size:clamp(30px,7.2vw,74px);font-weight:300;
  letter-spacing:.26em;margin-left:.26em;line-height:1.12;
  color:#f2f7ff;opacity:0;
  transform:translateY(18px);filter:blur(10px);
  text-shadow:0 2px 40px rgba(0,0,0,.7);
}
.ae-t-rule{
  width:min(320px,52vw);height:1px;margin:clamp(14px,2.4vh,24px) auto;
  background:linear-gradient(90deg,transparent,var(--ae-hair-s) 22%,var(--ae-accent-d) 50%,var(--ae-hair-s) 78%,transparent);
  transform:scaleX(0);opacity:0;
}
.ae-t-sub{
  font-size:clamp(9.5px,1.7vw,12px);letter-spacing:.44em;text-transform:uppercase;
  color:var(--ae-dim);opacity:0;margin-left:.44em;
  transform:translateY(10px);filter:blur(6px);
}
.ae-title.ae-play .ae-t-eyebrow{animation:ae-t-rise 1.1s .05s var(--ae-ease) forwards;}
.ae-title.ae-play .ae-t-name{animation:ae-t-rise 1.6s .18s var(--ae-ease) forwards;}
.ae-title.ae-play .ae-t-rule{animation:ae-t-rule 1.5s .55s var(--ae-ease) forwards;}
.ae-title.ae-play .ae-t-sub{animation:ae-t-rise 1.3s .72s var(--ae-ease) forwards;}
.ae-title.ae-out{opacity:0;transform:translateY(-14px) scale(1.012);filter:blur(7px);
  transition:opacity 1.5s var(--ae-ease),transform 1.5s var(--ae-ease),filter 1.5s var(--ae-ease);}
.ae-title.ae-play{opacity:1;}
@keyframes ae-t-rise{from{opacity:0;transform:translateY(16px);filter:blur(10px);}
  to{opacity:1;transform:translateY(0);filter:blur(0);}}
@keyframes ae-t-rule{from{opacity:0;transform:scaleX(0);}to{opacity:1;transform:scaleX(1);}}

/* ═══════════════════ scanner ═══════════════════ */

.ae-scan{position:absolute;inset:0;display:none;opacity:0;transition:opacity .45s var(--ae-ease);}
.ae-scan.ae-mounted{display:block;}
.ae-scan.ae-on{opacity:1;}
.ae-scan-field{
  position:absolute;inset:0;
  background:radial-gradient(64% 64% at 50% 50%,rgba(111,211,255,0) 42%,rgba(111,211,255,.07) 78%,rgba(111,211,255,.14) 100%);
}
.ae-scan-ring{
  position:absolute;left:50%;top:50%;width:44vmax;height:44vmax;margin:-22vmax 0 0 -22vmax;
  border:1px solid var(--ae-accent);border-radius:50%;
  opacity:0;transform:scale(.06);
  animation:ae-ring 3.4s var(--ae-ease-io) infinite;
}
.ae-scan-ring:nth-child(3){animation-delay:1.13s;}
.ae-scan-ring:nth-child(4){animation-delay:2.26s;}
@keyframes ae-ring{
  0%{opacity:0;transform:scale(.05);}
  12%{opacity:.5;}
  100%{opacity:0;transform:scale(1.9);}
}
.ae-scan-meta{
  position:absolute;right:calc(var(--ae-sr) + var(--ae-pad));
  top:calc(var(--ae-st) + var(--ae-pad));
  text-align:right;font-family:var(--ae-mono);
  font-size:var(--ae-micro);letter-spacing:.14em;color:var(--ae-accent);
  opacity:.82;line-height:1.85;
  text-shadow:0 1px 10px rgba(0,0,0,.9);
}
.ae-scan-meta .ae-sm-h{letter-spacing:.4em;color:var(--ae-faint);margin-bottom:5px;}
.ae-scan-row{display:flex;justify-content:flex-end;gap:12px;}
.ae-scan-row span:last-child{color:var(--ae-dim);min-width:56px;}
.ae-scan-brk{position:absolute;inset:calc(var(--ae-st) + 14px) 14px calc(var(--ae-sb) + 14px) 14px;pointer-events:none;}
.ae-scan-brk i{position:absolute;width:16px;height:16px;border:1px solid var(--ae-accent);opacity:.4;}
.ae-scan-brk i:nth-child(1){left:0;top:0;border-right:0;border-bottom:0;}
.ae-scan-brk i:nth-child(2){right:0;top:0;border-left:0;border-bottom:0;}
.ae-scan-brk i:nth-child(3){left:0;bottom:0;border-right:0;border-top:0;}
.ae-scan-brk i:nth-child(4){right:0;bottom:0;border-left:0;border-top:0;}

/* ═══════════════════ touch controls ═══════════════════ */

.ae-touch{position:absolute;inset:0;display:none;}
.aeon-hud.ae-touch-on .ae-touch{display:block;}

.ae-stick{
  position:absolute;left:0;top:0;width:0;height:0;
  opacity:0;transition:opacity .25s var(--ae-ease);
  will-change:transform,opacity;
}
.ae-stick.ae-on{opacity:1;transition:opacity .12s linear;}
.ae-stick-ring{
  position:absolute;left:0;top:0;width:140px;height:140px;margin:-70px 0 0 -70px;
  border-radius:50%;border:1px solid rgba(228,235,246,.17);
  background:radial-gradient(circle at 50% 50%,rgba(228,235,246,.045) 0%,rgba(228,235,246,0) 62%);
  transform:scale(.8);transition:transform .3s var(--ae-ease);
}
.ae-stick.ae-on .ae-stick-ring{transform:scale(1);}
.ae-stick-arc{
  position:absolute;left:0;top:0;width:140px;height:140px;margin:-70px 0 0 -70px;
  color:var(--ae-accent);opacity:0;
  transition:opacity .18s linear;
  will-change:transform,opacity;
}
.ae-stick-dot{
  position:absolute;left:0;top:0;width:19px;height:19px;margin:-9.5px 0 0 -9.5px;
  border-radius:50%;
  background:radial-gradient(circle at 50% 40%,rgba(255,255,255,.92),rgba(180,214,240,.55) 62%,rgba(140,190,230,.12) 100%);
  box-shadow:0 0 12px rgba(150,210,255,.35);
  will-change:transform;
}

.ae-btn{
  position:absolute;left:0;top:0;
  display:grid;place-items:center;border-radius:50%;
  color:var(--ae-ink);
  border:1px solid rgba(228,235,246,.19);
  background:radial-gradient(circle at 50% 34%,rgba(20,28,42,.34),rgba(8,12,20,.20));
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);
  opacity:0;transform:scale(.86);
  transition:opacity .32s var(--ae-ease),transform .22s var(--ae-ease),
             border-color .2s linear,box-shadow .28s var(--ae-ease);
  will-change:transform,opacity;
}
.ae-btn.ae-on{opacity:.62;transform:scale(1);}
.ae-btn.ae-press{
  opacity:1;transform:scale(.9);
  border-color:var(--ae-accent);
  box-shadow:0 0 0 1px rgba(111,211,255,.18),0 0 20px rgba(111,211,255,.32);
  transition-duration:.09s;
}
.ae-btn svg{width:56%;height:56%;opacity:.92;}
/* Captions sit *above* the glyph: the bottom cluster lives in the safe-area
   gutter and anything below it would be eaten by the home indicator. */
.ae-btn-cap{
  position:absolute;bottom:calc(100% + 5px);left:50%;transform:translateX(-50%);
  font-size:7.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--ae-faint);
  white-space:nowrap;opacity:1;transition:opacity .6s var(--ae-ease);
  text-shadow:0 1px 8px rgba(0,0,0,.9);
}
.ae-btn.ae-known .ae-btn-cap{opacity:0;}
.ae-btn.ae-mini{border-color:transparent;background:none;-webkit-backdrop-filter:none;backdrop-filter:none;}
.ae-btn.ae-mini.ae-on{opacity:.44;}
.ae-btn.ae-mini.ae-press{opacity:.95;box-shadow:none;transform:scale(.88);}

/* ═══════════════════ settings sheet ═══════════════════ */

.ae-panel{position:absolute;inset:0;display:none;}
.ae-panel.ae-mounted{display:block;}
.ae-panel-scrim{
  position:absolute;inset:0;background:rgba(3,5,9,.42);
  opacity:0;transition:opacity .42s var(--ae-ease);
  -webkit-backdrop-filter:blur(1.5px);backdrop-filter:blur(1.5px);
}
.ae-panel.ae-on .ae-panel-scrim{opacity:1;pointer-events:auto;}
.ae-sheet{
  position:absolute;top:0;right:0;bottom:0;
  width:min(372px,86vw);
  padding:calc(var(--ae-st) + 26px) calc(var(--ae-sr) + 24px) calc(var(--ae-sb) + 20px) 26px;
  background:linear-gradient(255deg,rgba(7,10,16,.93) 0%,rgba(7,10,16,.86) 60%,rgba(7,10,16,.78) 100%);
  -webkit-backdrop-filter:blur(18px) saturate(1.15);backdrop-filter:blur(18px) saturate(1.15);
  border-left:1px solid var(--ae-hair);
  transform:translate3d(100%,0,0);
  transition:transform .46s var(--ae-ease);
  overflow:hidden;
  will-change:transform;
}
.ae-panel.ae-on .ae-sheet{transform:translate3d(0,0,0);pointer-events:auto;}
.ae-sheet-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:20px;}
.ae-sheet-title{font-size:var(--ae-small);letter-spacing:.44em;text-transform:uppercase;color:var(--ae-ink);}
.ae-sheet-esc{font-size:var(--ae-micro);letter-spacing:.22em;text-transform:uppercase;color:var(--ae-faint);}
.ae-sheet-clip{position:absolute;left:26px;right:calc(var(--ae-sr) + 24px);
  top:calc(var(--ae-st) + 62px);bottom:calc(var(--ae-sb) + 20px);overflow:hidden;
  -webkit-mask-image:linear-gradient(180deg,transparent 0,#000 18px,#000 calc(100% - 22px),transparent 100%);
  mask-image:linear-gradient(180deg,transparent 0,#000 18px,#000 calc(100% - 22px),transparent 100%);}
.ae-sheet-body{position:absolute;left:0;right:0;top:0;padding:8px 0 26px;will-change:transform;}
.ae-grp{margin-bottom:22px;}
.ae-grp-h{
  font-size:var(--ae-micro);letter-spacing:.4em;text-transform:uppercase;
  color:var(--ae-accent);opacity:.75;margin-bottom:11px;
  padding-bottom:8px;border-bottom:1px solid var(--ae-hair);
}
.ae-row{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:32px;}
.ae-row-k{font-size:var(--ae-small);letter-spacing:.14em;color:var(--ae-dim);white-space:nowrap;}
.ae-row-col{display:block;padding:5px 0 9px;}
.ae-row-col .ae-row{min-height:24px;}

.ae-seg{display:flex;gap:0;border:1px solid var(--ae-hair);border-radius:3px;overflow:hidden;}
.ae-seg-b{
  padding:5px 8px;font-size:8.5px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--ae-faint);cursor:pointer;transition:color .2s linear,background-color .2s linear;
  border-right:1px solid var(--ae-hair);
}
.ae-seg-b:last-child{border-right:0;}
.ae-seg-b.ae-sel{color:#04070c;background:var(--ae-accent);}

.ae-sw{
  width:34px;height:17px;border-radius:9px;border:1px solid var(--ae-hair-s);
  position:relative;cursor:pointer;flex:none;
  transition:border-color .25s linear,background-color .25s linear;
}
.ae-sw>i{
  position:absolute;left:2px;top:1.5px;width:11px;height:11px;border-radius:50%;
  background:var(--ae-faint);
  transition:transform .28s var(--ae-ease),background-color .25s linear,box-shadow .25s linear;
}
.ae-sw.ae-sel{border-color:var(--ae-accent-d);background:rgba(111,211,255,.10);}
.ae-sw.ae-sel>i{transform:translateX(15px);background:var(--ae-accent);box-shadow:0 0 9px var(--ae-accent-d);}

.ae-sld{display:flex;align-items:center;gap:11px;flex:1;max-width:190px;}
.ae-sld-track{
  position:relative;flex:1;height:16px;cursor:pointer;touch-action:none;
}
.ae-sld-track::before{
  content:"";position:absolute;left:0;right:0;top:7.5px;height:1px;background:var(--ae-ghost);
}
.ae-sld-fill{
  position:absolute;left:0;top:7.5px;height:1px;width:100%;background:var(--ae-accent);
  transform-origin:left center;transform:scaleX(0);opacity:.8;
}
.ae-sld-knob{
  position:absolute;left:0;top:3.5px;width:9px;height:9px;margin-left:-4.5px;border-radius:50%;
  background:var(--ae-ink);box-shadow:0 0 8px rgba(0,0,0,.6);
  transition:box-shadow .2s linear,transform .12s var(--ae-ease);
}
.ae-sld-track.ae-drag .ae-sld-knob{transform:scale(1.28);box-shadow:0 0 12px var(--ae-accent-d);}
.ae-sld-val{
  font-size:var(--ae-micro);letter-spacing:.1em;color:var(--ae-ink);
  min-width:38px;text-align:right;
}
.ae-note{
  font-size:var(--ae-micro);letter-spacing:.12em;color:var(--ae-faint);
  line-height:1.9;margin-top:7px;
}
.ae-btn-t{
  padding:6px 11px;border:1px solid var(--ae-hair-s);border-radius:3px;
  font-size:8.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--ae-dim);
  cursor:pointer;transition:color .2s linear,border-color .2s linear;
}
.ae-btn-t:active,.ae-btn-t.ae-sel{color:var(--ae-accent);border-color:var(--ae-accent-d);}

/* ═══════════════════ photo mode ═══════════════════ */

.ae-pm{position:absolute;inset:0;display:none;}
.ae-pm.ae-mounted{display:block;}
.ae-pm-bar{
  position:absolute;left:0;right:0;height:50%;background:#000;
  transform-origin:top center;transform:scaleY(0);
  transition:transform .6s var(--ae-ease);
}
.ae-pm-bar.ae-t{top:0;transform-origin:top center;}
.ae-pm-bar.ae-b{bottom:0;transform-origin:bottom center;}
.ae-pm-bar.ae-l,.ae-pm-bar.ae-r{
  top:0;bottom:0;height:auto;width:50%;transform:scaleX(0);
  transition:transform .6s var(--ae-ease);
}
.ae-pm-bar.ae-l{left:0;transform-origin:left center;}
.ae-pm-bar.ae-r{right:0;transform-origin:right center;}
.ae-pm-aspect{
  font-size:8.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--ae-dim);
  padding:6px 10px;border:1px solid var(--ae-hair);border-radius:3px;cursor:pointer;min-width:58px;
  text-align:center;transition:color .2s linear,border-color .2s linear;
}
.ae-pm-aspect:active{color:var(--ae-accent);border-color:var(--ae-accent-d);}
.ae-pm-grid{position:absolute;inset:0;opacity:0;transition:opacity .5s var(--ae-ease);}
.ae-pm.ae-on .ae-pm-grid{opacity:.22;}
.ae-pm-grid i{position:absolute;background:var(--ae-ink);}
.ae-pm-grid i.v{top:0;bottom:0;width:1px;}
.ae-pm-grid i.h{left:0;right:0;height:1px;}
.ae-pm-strip{
  position:absolute;left:50%;bottom:calc(var(--ae-sb) + clamp(18px,4vh,38px));
  transform:translateX(-50%) translateY(14px);
  display:flex;align-items:center;gap:14px;
  opacity:0;transition:opacity .5s var(--ae-ease),transform .5s var(--ae-ease);
}
.ae-pm.ae-on .ae-pm-strip{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto;}
.ae-pm-shutter{
  width:44px;height:44px;border-radius:50%;border:1px solid var(--ae-hair-s);
  display:grid;place-items:center;cursor:pointer;
  transition:transform .16s var(--ae-ease),border-color .2s linear,box-shadow .3s var(--ae-ease);
}
.ae-pm-shutter>i{width:28px;height:28px;border-radius:50%;background:var(--ae-ink);opacity:.86;transition:transform .16s var(--ae-ease);}
.ae-pm-shutter:active{transform:scale(.93);border-color:var(--ae-accent);box-shadow:0 0 22px var(--ae-accent-d);}
.ae-pm-shutter:active>i{transform:scale(.82);}
.ae-pm-hint{
  position:absolute;left:50%;top:calc(var(--ae-st) + clamp(16px,3.4vh,34px));
  transform:translateX(-50%);
  font-size:var(--ae-micro);letter-spacing:.3em;text-transform:uppercase;color:var(--ae-faint);
  white-space:nowrap;opacity:0;transition:opacity .8s var(--ae-ease);
}
.ae-pm.ae-on .ae-pm-hint{opacity:1;}
.ae-pm.ae-quiet .ae-pm-hint{opacity:0;}

/* ═══════════════════ veil + shutter flash ═══════════════════ */

.ae-veil{position:absolute;inset:-8%;display:none;opacity:0;will-change:opacity;}
.ae-veil.ae-mounted{display:block;}
.ae-veil-core{
  position:absolute;inset:0;
  background:radial-gradient(118% 88% at 50% 50%,rgba(5,8,15,0) 12%,rgba(5,8,15,.5) 48%,rgba(2,3,6,.98) 84%);
}
.ae-veil-chroma{
  position:absolute;inset:0;mix-blend-mode:screen;filter:blur(14px);
  transform:scale(var(--ae-veil-s,1));
  will-change:transform;
  background:
    radial-gradient(70% 56% at 50% 50%,rgba(96,196,255,0) 44%,rgba(96,196,255,.30) 60%,rgba(96,196,255,0) 74%),
    radial-gradient(76% 60% at 50% 50%,rgba(255,108,190,0) 50%,rgba(255,108,190,.20) 65%,rgba(255,108,190,0) 80%),
    radial-gradient(64% 50% at 50% 50%,rgba(255,196,120,0) 38%,rgba(255,196,120,.17) 54%,rgba(255,196,120,0) 68%);
}
.ae-veil-streak{
  position:absolute;inset:-20%;opacity:.09;mix-blend-mode:screen;
  background:repeating-conic-gradient(from 0deg at 50% 50%,
    rgba(255,255,255,0) 0deg 2.2deg,rgba(255,255,255,.6) 2.2deg 2.7deg);
  -webkit-mask-image:radial-gradient(closest-side,transparent 26%,#000 76%);
  mask-image:radial-gradient(closest-side,transparent 26%,#000 76%);
  animation:ae-spin 52s linear infinite;
}
.ae-flash{
  position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;
}
.ae-flash.ae-fire{animation:ae-flash .42s var(--ae-ease);}
@keyframes ae-flash{0%{opacity:0;}9%{opacity:.85;}100%{opacity:0;}}

/* ═══════════════════ responsive + accessibility ═══════════════════ */

@media (orientation:landscape) and (max-height:520px){
  .aeon-hud{--ae-pad:clamp(10px,2.2vh,18px);}
  .ae-compass{width:min(340px,42vw);}
  .ae-toasts{bottom:calc(var(--ae-sb) + 46px);}
}
@media (max-width:520px){
  .ae-mk-d{display:none;}
  .ae-left{max-width:62vw;}
}
@media (prefers-reduced-motion:reduce){
  .aeon-hud *{animation-duration:.001ms !important;animation-iteration-count:1 !important;}
}
.aeon-hud.ae-calm .ae-scan-ring,.aeon-hud.ae-calm .ae-veil-streak,
.aeon-hud.ae-calm .ae-mk.ae-anomaly .ae-mk-g,.aeon-hud.ae-calm .ae-prompt.ae-on,
.aeon-hud.ae-calm .ae-ro.ae-crit .ae-ro-v{animation:none;}
`;

/** Inject once. Repeated Hud instances (hot reload) reuse the same node. */
export function ensureStyle(): HTMLStyleElement {
  let node = document.getElementById(HUD_STYLE_ID) as HTMLStyleElement | null;
  if (!node) {
    node = document.createElement('style');
    node.id = HUD_STYLE_ID;
    node.textContent = HUD_CSS;
    document.head.appendChild(node);
  } else {
    node.textContent = HUD_CSS;
  }
  return node;
}
