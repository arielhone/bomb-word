// אפקטים פיזיים: מסך שלא נכבה (Wake Lock), רטט והבזק מסך.

let lock = null;
let wanted = false;

export async function keepAwake() {
  wanted = true;
  if (lock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    lock = await navigator.wakeLock.request("screen");
    lock.addEventListener("release", () => (lock = null));
  } catch (e) { console.warn("wakeLock", e); }
}

export function letSleep() {
  wanted = false;
  lock?.release().catch(() => {});
  lock = null;
}

// הדפדפן משחרר את הנעילה כשהטאב מוסתר — מבקשים שוב כשחוזרים
document.addEventListener("visibilitychange", () => {
  if (wanted && document.visibilityState === "visible") keepAwake();
});

// iOS Safari לא תומך ב-vibrate — שם ההבזק חזק יותר במקום
export const canVibrate = typeof navigator.vibrate === "function";
export function vibrate(pattern) { try { navigator.vibrate?.(pattern); } catch {} }

export function flash(cls = "flash") {
  const el = document.createElement("div");
  el.className = cls;
  document.body.append(el);
  const done = () => el.remove();
  el.addEventListener("animationend", done);
  setTimeout(done, 3000);
}

export function boom() {
  if (canVibrate) { vibrate([500, 120, 400, 120, 700]); flash("flash"); }
  else flash("flash strong");
  document.body.classList.remove("shake");
  void document.body.offsetWidth;
  document.body.classList.add("shake");
  setTimeout(() => document.body.classList.remove("shake"), 900);
}
