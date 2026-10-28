// צלילים עם Web Audio API — בלי קבצים.
// iOS Safari משמיע צליל רק אחרי לחיצה של המשתמש, לכן unlock() נקרא מתוך לחיצה ("אני מוכן", יצירה/הצטרפות).

let ctx = null;
let out = null;

export function unlock() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      out = ctx.createGain();
      out.gain.value = 0.9;
      out.connect(ctx.destination);
    }
    if (ctx.state !== "running") ctx.resume();
    // באפר שקט קצר — מה ש"משחרר" סופית את האודיו ב-iOS
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
    return true;
  } catch (e) { console.error("audio", e); return false; }
}

export const ready = () => ctx?.state === "running";

// אחרי נעילת מסך / מעבר טאב ה-context עלול להיעצר
export function resume() { if (ctx && ctx.state !== "running") ctx.resume().catch(() => {}); }

// צליל קצר עם מעטפת: עולה מהר ודועך
function blip(type, freq, dur, vol, at = 0) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// תקתוק שעון. urgency בין 0 ל-1: ככל שגבוה יותר, הצליל חד וגבוה יותר. tock מחליף בין שני גבהים (טיק-טוק)
export function tick(urgency = 0, tock = false) {
  if (!ready()) return;
  const f = (tock ? 1500 : 1900) + urgency * 900;
  blip("square", f, 0.035, 0.18 + urgency * 0.12);
  blip("sine", tock ? 140 : 180, 0.05, 0.25);
}

// "נוחש!" — שני צלילים עולים
export function ding() {
  if (!ready()) return;
  blip("triangle", 880, 0.18, 0.35);
  blip("triangle", 1320, 0.28, 0.35, 0.09);
}

// פיצוץ: רעש לבן עם פילטר שנסגר + "בום" נמוך שצונח
export function boom() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const len = 2.6;
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(4000, t);
  lp.frequency.exponentialRampToValueAtTime(120, t + 1.8);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(1.0, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + len);
  noise.connect(lp).connect(ng).connect(out);
  noise.start(t);

  const o = ctx.createOscillator();
  const og = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(30, t + 1.2);
  og.gain.setValueAtTime(1.0, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
  o.connect(og).connect(out);
  o.start(t);
  o.stop(t + 1.6);
}
