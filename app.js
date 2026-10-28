// מילה-פצצה — לוגיקת המשחק
// ארכיטקטורה: Firebase Auth (אנונימי) + Realtime Database. אין שרת משלנו.
// הדפדפן של המנהל משמש "שופט": מגריל פתיל סודי, חושף את רגע הפיצוץ ממש לפני שהוא קורה ומחלק נקודות.
// העברת הפצצה היא טרנזקציה של מי שמחזיק אותה, וה-rules מוודאים שהיא חוקית (ראה database.rules.json).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, connectDatabaseEmulator, ref, get, set, update, remove, onValue, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig, USE_EMULATOR, EMULATOR_CONFIG } from "./firebase-config.js";
import * as audio from "./audio.js";
import * as fx from "./fx.js";

// ---------- Firebase ----------
const fb = initializeApp(USE_EMULATOR ? EMULATOR_CONFIG : firebaseConfig);
const auth = getAuth(fb);
const db = getDatabase(fb);
if (USE_EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectDatabaseEmulator(db, "127.0.0.1", 9000);
}

// ---------- State ----------
const S = {
  me: null,            // uid
  code: null,          // קוד חדר
  screen: false,       // מסך תצוגה (טלוויזיה/לפטופ) במקום טלפון של שחקן
  room: null,          // כל החדר: meta, players, scores, game, used
  offset: 0,           // הפרש בין השעון שלי לשעון השרת (.info/serverTimeOffset)
  words: null,         // { cats: [...], byKey: { key: { w, cat } } }
  word: null,          // { key, wkey, text } — המילה שלי כשהפצצה אצלי
  unsubs: [],
  hasRecord: false,    // יש לי רשומת שחקן בחדר (מסך שנפתח באותו דפדפן של שחקן — אין)
  presence: false,     // אני מנהל את ה-online של הרשומה שלי
  exploded: 0,         // הסבב האחרון שהתפוצץ אצלי (מקומית)
  boomUntil: 0,        // עד מתי מציגים את מסך הפיצוץ לפני התוצאות
  boomTimer: null,
  nextTick: 0,         // מתי התקתוק הבא (שעון שרת)
  tock: false,
  passing: false,
  fuse: null,          // { code, round, ms } — רק אצל המנהל שהגריל
  hostBusy: false,
  lastHostTick: 0,
  lastBoomTry: 0,
  goneSince: {},       // uid -> מתי (בשעון שלי) ראיתי שהוא מנותק
  lastClaim: 0,
  dragging: false,
  renderPending: false,
  appealUntil: 0,      // עד מתי כפתור הערעור מוצג אצלי (שעון שרת)
};

const FUSE_MIN = 40000, FUSE_MAX = 90000; // תואם ל-database.rules.json
const REVEAL_MS = 3000;        // כמה זמן לפני הפיצוץ חושפים את הרגע המדויק לכל הטלפונים
const HOLDER_GRACE_MS = 3000;  // מחזיק שהתנתק: מחכים קצת, כדי שרענון מהיר לא יעביר את הפצצה
const HOST_GRACE_MS = 4000;    // מנהל שהתנתק: אחרי כמה זמן מישהו אחר לוקח את התפקיד
const BOOM_SHOW_MS = 2600;     // כמה זמן מסך הפיצוץ נשאר לפני התוצאות
const APPEAL_MS = 5000;        // חלון הערעור אחרי "נוחש!" (השרת נותן עוד שנייה חסד, ראה database.rules.json)
const BANNER_MS = 3000;        // כמה זמן מוצגת המילה שנוחשה
const MIN_PER_TEAM = 2;
const TARGETS = [5, 7, 10, 15];
const DEFAULT_TARGET = 7;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // בלי I ו-O שמתבלבלים
const TEAM = { A: "קבוצה א'", B: "קבוצה ב'" };

const $ = (s) => document.querySelector(s);
const app = $("#app");

const R = (p = "") => ref(db, `rooms/${S.code}${p ? "/" + p : ""}`);
const M = () => S.room?.meta;
const G = () => S.room?.game;
const P = () => S.room?.players || {};
const serverNow = () => Date.now() + S.offset;
const isHost = () => !!S.room && M()?.hostUid === S.me && !!P()[S.me];
const isOnline = (uid) => P()[uid]?.online === true;
const teamOf = (uid) => P()[uid]?.team || null;
const other = (t) => (t === "A" ? "B" : "A");
const tcls = (t) => (t === "A" ? "ta" : t === "B" ? "tb" : "");
const nameOf = (uid) => P()[uid]?.name || "שחקן שעזב";
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isPlayer = (uid) => !!P()[uid] && !P()[uid].spectator;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// שחקני קבוצה לפי סדר התור
function teamList(t, { onlineOnly = false } = {}) {
  return Object.keys(P())
    .filter((u) => isPlayer(u) && P()[u].team === t && (!onlineOnly || isOnline(u)))
    .sort((a, b) => (P()[a].order ?? 0) - (P()[b].order ?? 0) || (P()[a].joinedAt ?? 0) - (P()[b].joinedAt ?? 0));
}
const unassigned = () => Object.keys(P()).filter((u) => isPlayer(u) && !P()[u].team)
  .sort((a, b) => (P()[a].joinedAt ?? 0) - (P()[b].joinedAt ?? 0));
const smallerTeam = () => (teamList("A", { onlineOnly: true }).length <= teamList("B", { onlineOnly: true }).length ? "A" : "B");

// הבא בתור מקבוצה t: מתחילים מהמצביע המעגלי ומדלגים על מי שלא מחובר. מחזיר גם את המצביע החדש
function nextOf(t, ptr = 0) {
  const all = teamList(t);
  for (let i = 0; i < all.length; i++) {
    const idx = (ptr + i) % all.length;
    if (isOnline(all[idx])) return { uid: all[idx], ptr: (idx + 1) % all.length };
  }
  return null;
}

// מועמדים לתפקיד המנהל: מחוברים, לפי ותק (זהה בכל הלקוחות)
function hostCandidates() {
  return Object.keys(P()).filter((u) => u !== M()?.hostUid && isOnline(u))
    .sort((a, b) => (P()[a].joinedAt ?? 0) - (P()[b].joinedAt ?? 0) || (a < b ? -1 : 1));
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
function safeJSON(k) { try { return JSON.parse(safeGet(k)); } catch { return null; } }

// הודעה קצרה בראש המסך. type: "info" | "ok" | "err"
let toastTimer;
function toast(msg, type = "info") {
  const t = $("#toast");
  const icon = { ok: "✓", err: "!", info: "i" }[type] || "i";
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="ticon">${icon}</span><span>${esc(msg)}</span>`;
  t.hidden = false;
  void t.offsetWidth; // מאתחל את האנימציה גם כשהודעה מחליפה הודעה
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    toastTimer = setTimeout(() => (t.hidden = true), 250);
  }, type === "err" ? 3600 : 2600);
}

// הודעת שגיאה קריאה במקום קוד של Firebase
function errText(e) {
  const s = `${e?.code || ""} ${e?.message || ""}`.toLowerCase();
  if (s.includes("permission")) return "אין הרשאה לפעולה הזו. ייתכן שהמנהל התחלף";
  if (s.includes("network") || s.includes("disconnect")) return "אין חיבור לשרת. בדוק את האינטרנט ונסה שוב";
  return "משהו השתבש. נסה שוב";
}

// חלון אישור מעוצב במקום confirm() של הדפדפן. מחזיר true אם אישרו.
function ask({ title, text = "", ok = "אישור", cancel = "ביטול", danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "modal-backdrop";
    el.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="mTitle">
      <h2 id="mTitle">${esc(title)}</h2>
      ${text ? `<p class="muted">${esc(text)}</p>` : ""}
      <div class="row">
        <button class="btn grow ${danger ? "danger" : "primary"}" data-m="ok">${esc(ok)}</button>
        <button class="btn ghost grow" data-m="cancel">${esc(cancel)}</button>
      </div>
    </div>`;
    let closed = false;
    const done = (v) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      el.remove();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    el.addEventListener("click", (e) => {
      const m = e.target.closest("[data-m]")?.dataset.m;
      if (m) done(m === "ok");
      else if (e.target === el) done(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.append(el);
    el.querySelector("[data-m=ok]").focus();
  });
}

// ---------- מילים ----------
async function loadWords() {
  const data = await (await fetch("words.json", { cache: "no-cache" })).json();
  const byKey = {};
  for (const c of data.categories) c.words.forEach((w, i) => (byKey[`${c.id}_${i}`] = { w, cat: c.id }));
  S.words = { cats: data.categories, byKey };
}
const catOf = (id) => S.words.cats.find((c) => c.id === id);

// מילה חדשה מהקטגוריות שנבחרו, בלי מילים שכבר יצאו בחדר (כשנגמרות — מתחילים מחדש)
function pickWordKey() {
  const cats = M()?.cats || {};
  const used = S.room?.used || {};
  const all = Object.keys(S.words.byKey).filter((k) => cats[S.words.byKey[k].cat] !== false);
  let pool = all.filter((k) => !used[k] && k !== S.word?.wkey);
  if (!pool.length) pool = all.filter((k) => k !== S.word?.wkey);
  return pick(pool.length ? pool : all);
}

// המילה מוגרלת רק אצל מי שמחזיק את הפצצה, ולא נשמרת ב-DB בזמן הסבב — אי אפשר לגלות אותה מטלפון אחר
function newWord(key) {
  const wkey = pickWordKey();
  S.word = { key, wkey, text: S.words.byKey[wkey].w };
  safeSet("bomb:word", JSON.stringify(S.word));
  set(R(`used/${wkey}`), true).catch((e) => console.warn("used", e));
}

function ensureWord() {
  const g = G();
  if (!g || g.holder !== S.me || g.boom) return;
  const key = `${S.code}:${g.round}:${g.seq}`;
  if (S.word?.key === key) return;
  // אחרי רענון — אותה מילה, לא חדשה
  const saved = safeJSON("bomb:word");
  if (saved?.key === key && S.words.byKey[saved.wkey]) S.word = saved;
  else newWord(key);
}

// ---------- Boot ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) { console.error(e); app.innerHTML = `<div class="center">שגיאת התחברות ל-Firebase. בדוק את firebase-config.js ושהתחברות אנונימית מופעלת.</div>`; }
    return;
  }
  S.me = user.uid;
  onValue(ref(db, ".info/serverTimeOffset"), (s) => (S.offset = s.val() || 0));
  try { await loadWords(); }
  catch (e) { console.error(e); app.innerHTML = `<div class="center">לא הצלחתי לטעון את words.json</div>`; return; }

  const params = new URLSearchParams(location.search);
  S.screen = params.get("screen") === "1";
  document.body.classList.toggle("tv", S.screen);
  const code = (params.get("room") || "").toUpperCase();
  if (code && S.screen) { await joinScreen(code); return; }
  // חזרה אוטומטית לחדר אחרי רענון
  if (code && safeGet("bomb:room") === code && (await tryRejoin(code))) return;
  render();
});

if (!USE_EMULATOR && firebaseConfig.apiKey.startsWith("PASTE")) {
  app.innerHTML = `<div class="center">צריך להדביק את ה-config של Firebase בקובץ firebase-config.js (ראה README).</div>`;
}

async function tryRejoin(code) {
  try {
    const p = await get(ref(db, `rooms/${code}/players/${S.me}`));
    if (!p.exists()) return false;
    await update(ref(db, `rooms/${code}/players/${S.me}`), { online: true, ready: false });
    await enterRoom(code, { presence: true });
    return true;
  } catch (e) { console.error(e); return false; }
}

// ---------- Room lifecycle ----------
async function createRoom(name, { spectator = false } = {}) {
  let code;
  for (let i = 0; i < 10; i++) {
    code = Array.from({ length: 4 }, () => pick(CODE_CHARS)).join("");
    if (!(await get(ref(db, `rooms/${code}/meta`))).exists()) break;
    code = null;
  }
  if (!code) return toast("לא הצלחתי ליצור חדר. נסה שוב", "err");
  const cats = Object.fromEntries(S.words.cats.map((c) => [c.id, true]));
  const me = { name, joinedAt: serverTimestamp(), online: true, ready: false };
  if (spectator) me.spectator = true;
  await set(ref(db, `rooms/${code}`), {
    meta: { hostUid: S.me, phase: "lobby", target: DEFAULT_TARGET, cats, createdAt: serverTimestamp() },
    scores: { A: 0, B: 0 },
    players: { [S.me]: me },
  });
  if (spectator) {
    S.screen = true;
    document.body.classList.add("tv");
  }
  await enterRoom(code, { presence: true });
}

async function joinRoom(code, name) {
  code = code.toUpperCase().trim();
  if (!(await get(ref(db, `rooms/${code}/meta`))).exists()) return toast("לא מצאתי חדר עם הקוד הזה", "err");
  const pRef = ref(db, `rooms/${code}/players/${S.me}`);
  if ((await get(pRef)).exists()) await update(pRef, { name, online: true });
  else await set(pRef, { name, joinedAt: serverTimestamp(), online: true, ready: false });
  await enterRoom(code, { presence: true });
}

// מסך תצוגה: מצטרף בלי שם. אם באותו דפדפן כבר יש שחקן בחדר — לא נוגעים ברשומה שלו
async function joinScreen(code) {
  try {
    if (!(await get(ref(db, `rooms/${code}/meta`))).exists()) { toast("לא מצאתי חדר עם הקוד הזה", "err"); S.screen = false; document.body.classList.remove("tv"); history.replaceState(null, "", location.pathname); return render(); }
    const pRef = ref(db, `rooms/${code}/players/${S.me}`);
    const p = await get(pRef);
    if (!p.exists()) await set(pRef, { name: "📺 מסך", joinedAt: serverTimestamp(), online: true, spectator: true });
    else if (p.val().spectator) await update(pRef, { online: true });
    await enterRoom(code, { presence: !p.exists() || !!p.val().spectator });
  } catch (e) { console.error(e); toast(errText(e), "err"); render(); }
}

async function enterRoom(code, { presence }) {
  S.code = code;
  S.hasRecord = true;
  if (!S.screen) safeSet("bomb:room", code);
  history.replaceState(null, "", `?room=${code}${S.screen ? "&screen=1" : ""}`);

  // נוכחות: השרת עצמו מסמן אותי כמנותק כשהחיבור נופל (גם כשסוגרים את הטאב בלי לצאת)
  if (presence) {
    S.presence = true;
    const onRef = R(`players/${S.me}/online`);
    S.unsubs.push(onValue(ref(db, ".info/connected"), (s) => {
      if (s.val() !== true || !S.code) return;
      onDisconnect(onRef).set(false).then(() => S.code && set(onRef, true)).catch((e) => console.warn("presence", e));
    }));
  }

  S.unsubs.push(onValue(R(), (snap) => {
    const prev = S.room;
    S.room = snap.val();
    if (!S.room?.meta) return leaveLocal("החדר נסגר");
    if (S.hasRecord && !P()[S.me]) return leaveLocal("יצאת מהחדר");
    onRoomChange(prev);
    render();
  }, (e) => { console.error("room", e); leaveLocal("אין גישה לחדר"); }));
}

function onRoomChange(prev) {
  const g = G(), pg = prev?.game;
  if (prev && prev.meta?.hostUid !== M().hostUid && M().hostUid === S.me) toast("אתה המנהל עכשיו 👑", "ok");
  if (g?.round !== pg?.round) {
    S.nextTick = 0;
    S.goneSince = {};
    S.lastBoomTry = 0;
    clearTimeout(S.boomTimer);
  }
  // הפצצה עברה: כולם רואים מה נוחש (או שהיה ערעור), כדי שאי אפשר יהיה ללחוץ "נוחש!" סתם
  if (g && pg && g.round === pg.round && g.seq > pg.seq && g.last && M().phase === "playing") announcePass(g);
  if (M().phase === "playing") {
    fx.keepAwake();
    // הרגע המדויק נחשף: כל הטלפונים מתזמנים את הפיצוץ לאותו רגע בשעון השרת
    if (g?.explodeAt && g.explodeAt !== pg?.explodeAt) {
      clearTimeout(S.boomTimer);
      S.boomTimer = setTimeout(explode, Math.max(0, g.explodeAt - serverNow()));
    }
    if (g?.boom && S.exploded !== g.round) explode();
    // מי שהחזיק כשהתפוצץ — שולח את המילה כדי שתופיע בתוצאות
    if (g?.boom?.holder === S.me && !g.word && S.word?.key?.startsWith(`${S.code}:${g.round}:`)) {
      set(R("game/word"), S.word.text).catch((e) => console.warn("word", e));
    }
  }
  if (M().phase === "lobby" || M().phase === "over") fx.letSleep();
}

function leaveLocal(msg) {
  S.unsubs.forEach((u) => u());
  clearTimeout(S.boomTimer);
  Object.assign(S, { unsubs: [], code: null, room: null, hasRecord: false, presence: false, word: null,
    exploded: 0, boomUntil: 0, fuse: null, goneSince: {}, hostBusy: false });
  fx.letSleep();
  safeSet("bomb:room", null);
  history.replaceState(null, "", location.pathname);
  if (S.screen) { S.screen = false; document.body.classList.remove("tv"); }
  if (msg) toast(msg);
  render();
}

async function leaveRoom() {
  const host = isHost();
  const next = hostCandidates().filter((u) => u !== S.me)[0];
  if (!(await ask({ title: "לצאת מהחדר?", text: !host ? "" : next ? "תפקיד המנהל יעבור לשחקן אחר." : "אין שחקנים מחוברים נוספים, אז החדר ייסגר.", ok: "יציאה", danger: true }))) return;
  const code = S.code;
  const g = G();
  try {
    // מחזיק את הפצצה? קודם מעבירים אותה הלאה
    if (M()?.phase === "playing" && g?.holder === S.me && !g.boom) await passBomb(g.seq).catch(() => {});
    if (host && !next) {
      S.hasRecord = false;
      leaveLocal();
      await update(ref(db), { [`rooms/${code}`]: null, [`fuses/${code}`]: null });
      return;
    }
    if (host) await set(R("meta/hostUid"), next);
    if (S.presence) await onDisconnect(R(`players/${S.me}/online`)).cancel();
    S.hasRecord = false;
    await remove(R(`players/${S.me}`));
  } catch (e) { console.error(e); }
  leaveLocal();
}

// ---------- פעולות שחקן ----------
// "נוחש!": הפצצה עוברת לבא בתור מהקבוצה היריבה. טרנזקציה + בדיקת seq = לחיצה כפולה מעבירה פעם אחת בלבד.
// guessed: המילה נוחשה באמת — היא נחשפת לכולם ונרשמת ביומן הסבב (מעבר בגלל ניתוק/יציאה — בלי מילה, ואי אפשר לערער עליו)
function passBomb(seq, { guessed = false } = {}) {
  const w = guessed && S.word?.key === `${S.code}:${G()?.round}:${seq}` ? S.word.text : null;
  return runTransaction(R("game"), (g) => {
    if (!g || g.boom || g.seq !== seq) return;
    if (g.holder !== S.me && !isHost()) return;
    const t = other(g.team);
    const prevPtr = { A: 0, B: 0, ...g.ptr };
    const ptr = { ...prevPtr };
    const nx = nextOf(t, ptr[t]);
    if (!nx) return; // אין אף אחד מחובר בקבוצה השנייה
    ptr[t] = nx.ptr;
    const n = g.seq + 1;
    const last = { by: g.holder, ptr: prevPtr };
    if (w && g.holder === S.me) last.w = w;
    const log = last.w ? { ...(g.log || {}), [`s${n}`]: { w: last.w, by: g.holder, t: g.team } } : g.log || null;
    return { ...g, holder: nx.uid, team: t, seq: n, ptr, passedAt: serverTimestamp(), last, log };
  });
}

// ערעור: הקבוצה שקיבלה את הפצצה טוענת שלא באמת ניחשו. הפצצה חוזרת למי שהעביר (עם מילה חדשה), פעם אחת לקבוצה בכל סבב
function appeal(seq) {
  return runTransaction(R("game"), (g) => {
    const myT = teamOf(S.me);
    if (!g || g.boom || g.seq !== seq || !g.last?.w || myT !== g.team || g.appealed?.[myT]) return;
    const n = g.seq + 1;
    const log = { ...(g.log || {}) };
    if (log[`s${g.seq}`]) log[`s${g.seq}`] = { ...log[`s${g.seq}`], x: true };
    return { ...g, holder: g.last.by, team: other(g.team), seq: n, ptr: g.last.ptr || g.ptr,
      appealed: { ...(g.appealed || {}), [myT]: true }, passedAt: serverTimestamp(),
      last: { by: S.me, against: g.last.by, appeal: true }, log };
  });
}

const canAppeal = (g = G()) => M()?.appeal === true && !!g?.last?.w && !g.boom && teamOf(S.me) === g.team
  && !g.appealed?.[g.team] && serverNow() < (g.passedAt || 0) + APPEAL_MS;

async function doAppeal(seq) {
  if (S.passing) return;
  S.passing = true;
  try {
    const r = await appeal(seq);
    if (!r.committed) toast("מאוחר מדי לערער", "err");
  } catch (e) { console.warn("appeal", e); toast("מאוחר מדי לערער", "err"); }
  finally { S.passing = false; }
}

// באנר גדול בכל המסכים: מה נוחש, מי ערער, או מי התנתק
let bannerTimer;
function announcePass(g) {
  const L = g.last;
  let html, cls;
  if (L.appeal) {
    html = `🚫 ערעור של <b>${esc(nameOf(L.by))}</b>!<small>הפצצה חוזרת ל${esc(nameOf(L.against))}</small>`;
    cls = "appeal";
    audio.buzz();
  } else if (L.w) {
    html = `✅ נוחש: <b>${esc(L.w)}</b><small>${esc(nameOf(L.by))} העביר/ה ל${esc(nameOf(g.holder))}</small>`;
    cls = "ok";
    if (g.last.by !== S.me) audio.ding();
  } else {
    html = `${esc(nameOf(L.by))} לא מחובר/ת<small>הפצצה עברה ל${esc(nameOf(g.holder))}</small>`;
    cls = "info";
  }
  const el = $("#banner");
  el.className = `banner ${cls}`;
  el.innerHTML = `<span>${html}</span>`;
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (el.hidden = true), BANNER_MS);
}

async function guessed(seq) {
  if (S.passing) return;
  S.passing = true;
  try {
    const r = await passBomb(seq, { guessed: true });
    if (r.committed) { audio.ding(); fx.vibrate(40); }
    else if (!G()?.boom) toast("אין שחקן מחובר בקבוצה השנייה", "err");
  } catch (e) {
    // נדחה בשרת כי הפתיל כבר נגמר — הפיצוץ יגיע בעוד רגע
    if (!G()?.boom) console.warn("pass", e);
  } finally { S.passing = false; }
}

async function markReady() {
  audio.unlock();
  fx.keepAwake();
  audio.tick(0.3);
  if (S.code && P()[S.me] && !P()[S.me].spectator) await update(R(`players/${S.me}`), { ready: true });
  render();
}

// ---------- פיצוץ ----------
function explode() {
  const g = G();
  if (!g || M()?.phase !== "playing" || S.exploded === g.round) return;
  S.exploded = g.round;
  S.boomUntil = Date.now() + BOOM_SHOW_MS;
  clearTimeout(S.boomTimer);
  audio.boom();
  fx.boom();
  render();
}

// רישום הפיצוץ ב-DB. ה-rules דוחים אם הפתיל עוד לא באמת נגמר, אז אפשר לנסות בלי לדעת אותו
function tryBoom() {
  const g = G();
  if (!g || g.boom) return;
  S.lastBoomTry = serverNow();
  set(R("game/boom"), { holder: g.holder, team: g.team, at: serverTimestamp() })
    .catch(() => {}); // מוקדם מדי — ננסה שוב
}

// ---------- לוגיקת המנהל ----------
async function hostDo(fn) {
  if (S.hostBusy) return;
  S.hostBusy = true;
  try { await fn(); }
  catch (e) { console.error(e); toast(errText(e), "err"); }
  finally { S.hostBusy = false; }
}

// פעולות רקע של המנהל — בלי הודעות שגיאה (ננסה שוב בפעימה הבאה)
async function hostQuiet(fn) {
  if (S.hostBusy) return;
  S.hostBusy = true;
  try { await fn(); } catch (e) { console.warn("host", e); } finally { S.hostBusy = false; }
}

async function startRound() {
  const g = G();
  const round = (g?.round || 0) + 1;
  const ptr = { A: 0, B: 0, ...(g?.ptr || {}) };
  let startTeam = round % 2 ? "A" : "B"; // הקבוצה שפותחת מתחלפת בכל סבב
  let nx = nextOf(startTeam, ptr[startTeam]);
  if (!nx) { startTeam = other(startTeam); nx = nextOf(startTeam, ptr[startTeam]); }
  if (!nx) return toast("אין שחקנים מחוברים בקבוצות", "err");
  ptr[startTeam] = nx.ptr;
  const ms = FUSE_MIN + Math.floor(Math.random() * (FUSE_MAX - FUSE_MIN + 1));
  S.fuse = { code: S.code, round, ms };
  safeSet("bomb:fuse", JSON.stringify(S.fuse)); // רענון של המנהל לא ישכח את הפתיל
  await update(ref(db), {
    [`fuses/${S.code}`]: { round, ms },
    [`rooms/${S.code}/game`]: { round, startedAt: serverTimestamp(), startTeam, holder: nx.uid, team: startTeam, seq: 0, ptr },
    [`rooms/${S.code}/meta/phase`]: "playing",
  });
}

function myFuse() {
  const g = G();
  S.fuse ||= safeJSON("bomb:fuse");
  return S.fuse?.code === S.code && S.fuse.round === g?.round ? S.fuse : null;
}

// נקודה לקבוצה היריבה לזו שהחזיקה. הטרנזקציה על meta מבטיחה שהניקוד נרשם פעם אחת
async function scoreRound() {
  const g = G();
  const win = other(g.boom.team);
  const newScore = (S.room.scores?.[win] || 0) + 1;
  const r = await runTransaction(R("meta"), (m) => {
    if (!m || m.phase !== "playing" || m.hostUid !== S.me) return;
    return { ...m, phase: newScore >= m.target ? "over" : "results", point: { round: g.round, team: win } };
  });
  if (r.committed) await set(R(`scores/${win}`), newScore);
}

async function newGame() {
  await update(R(), { "meta/phase": "lobby", "meta/point": null, scores: { A: 0, B: 0 }, game: null });
}
const backToLobby = () => update(R(), { "meta/phase": "lobby" });

async function setTeam(uid, t) {
  if (!P()[uid]) return;
  await update(R(`players/${uid}`), t ? { team: t, order: Date.now() } : { team: null, order: null });
}

async function shuffleTeams() {
  const ids = shuffle(Object.keys(P()).filter((u) => isPlayer(u) && isOnline(u)));
  const flip = Math.random() < 0.5 ? 1 : 0;
  const upd = {};
  ids.forEach((u, i) => {
    upd[`players/${u}/team`] = (i + flip) % 2 ? "B" : "A";
    upd[`players/${u}/order`] = i;
  });
  if (ids.length) await update(R(), upd);
}

async function kick(uid) {
  if (!(await ask({ title: `להוציא את ${nameOf(uid)}?`, ok: "הוצא", danger: true }))) return;
  await remove(R(`players/${uid}`));
}

// רץ כל 250ms אצל המנהל
function hostTick() {
  if (!isHost() || S.hostBusy) return;
  const m = M(), g = G(), now = serverNow();
  if (m.phase === "playing" && g) {
    if (g.boom) return hostQuiet(scoreRound);
    const f = myFuse();
    // 3 שניות לפני הסוף: חושפים את הרגע המדויק, כדי שהפיצוץ יקרה בכל הטלפונים יחד
    if (f && !g.explodeAt && now >= g.startedAt + f.ms - REVEAL_MS) {
      return hostQuiet(() => set(R("game/explodeAt"), g.startedAt + f.ms));
    }
    // רישום הפיצוץ. בלי הפתיל (המנהל התחלף/רוענן) — מנסים כל שנייה מהמינימום, וה-rules מחליטים
    const due = f ? g.startedAt + f.ms : g.startedAt + FUSE_MIN;
    if (now >= due && now - S.lastBoomTry > 1000) tryBoom();
    // המחזיק התנתק או יצא — הפצצה עוברת לבא בתור
    const h = g.holder;
    if (!isOnline(h)) {
      S.goneSince[h] ||= Date.now();
      if (Date.now() - S.goneSince[h] > HOLDER_GRACE_MS) {
        S.goneSince[h] = Date.now();
        return hostQuiet(() => passBomb(g.seq));
      }
    } else delete S.goneSince[h];
  }
  // מי שהצטרף באמצע המשחק — לקבוצה הקטנה
  if (m.phase !== "lobby") {
    const late = unassigned().filter(isOnline);
    if (late.length) return hostQuiet(() => setTeam(late[0], smallerTeam()));
  }
}

// רץ אצל כל השחקנים: השתלטות על תפקיד המנהל וגיבוי לרישום הפיצוץ
function memberTick() {
  if (!S.code || !S.room || !P()[S.me] || isHost()) return;
  const hu = M().hostUid, g = G(), now = serverNow();
  const hostGone = !isOnline(hu);
  if (hostGone) {
    S.goneSince[hu] ||= Date.now();
    const gone = Date.now() - S.goneSince[hu] > HOST_GRACE_MS;
    if (gone && hostCandidates()[0] === S.me && isOnline(S.me) && Date.now() - S.lastClaim > 5000) {
      S.lastClaim = Date.now();
      set(R("meta/hostUid"), S.me).catch((e) => console.warn("claim", e));
    }
  } else delete S.goneSince[hu];
  if (M().phase === "playing" && g && !g.boom && now - S.lastBoomTry > 2000) {
    const late = g.explodeAt && now > g.explodeAt + 1500;
    if (late || (hostGone && now >= g.startedAt + FUSE_MIN)) tryBoom();
  }
}

// ---------- לולאה ראשית: תקתוק, פיצוץ ופעולות רקע ----------
setInterval(() => {
  const g = G(), now = serverNow();
  if (M()?.phase === "playing" && g && S.exploded !== g.round) {
    if (g.boom || (g.explodeAt && now >= g.explodeAt)) explode();
    else if (now >= S.nextTick && g.startedAt) {
      // הקצב לפי הזמן שעבר מתחילת הסבב — לא לפי מה שנשאר, כדי לא לגלות את הפתיל.
      // רק כשהרגע המדויק נחשף (3 שניות לפני) — קצב מטורף
      const elapsed = Math.max(0, now - g.startedAt);
      const urgency = g.explodeAt ? 1 : Math.min(1, elapsed / FUSE_MAX);
      const iv = g.explodeAt ? 110 : 1000 - urgency * 760;
      S.tock = !S.tock;
      audio.tick(urgency, S.tock);
      const b = $("#bomb");
      if (b) { b.classList.remove("beat"); void b.offsetWidth; b.classList.add("beat"); }
      S.nextTick = now + iv;
    }
  }
  if (S.boomUntil && Date.now() >= S.boomUntil) { S.boomUntil = 0; render(); }
  if (S.appealUntil && now >= S.appealUntil) { S.appealUntil = 0; render(); }
  if (S.renderPending && !S.dragging) render();
  if (Date.now() - S.lastHostTick > 250) {
    S.lastHostTick = Date.now();
    hostTick();
    memberTick();
  }
}, 25);

// ---------- Views ----------
function header() {
  const p = P()[S.me];
  const t = teamOf(S.me);
  return `<header class="top">
    <div class="code-chip">חדר <b>${esc(S.code)}</b></div>
    <div class="me-chip ${tcls(t)}">${t ? '<span class="dot"></span>' : ""}${esc(p?.name || "")}${isHost() ? ' <span class="crown">👑</span>' : ""}</div>
    <button class="leave-btn" data-act="leave" aria-label="יציאה מהחדר" title="יציאה מהחדר">🚪</button>
  </header>`;
}

function homeView() {
  const urlCode = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
  const name = safeGet("bomb:name") || "";
  return `<section class="home">
    <div class="logo">
      <div class="logo-bomb">💣</div>
      <h1>מילה-פצצה</h1>
      <p class="muted">מסבירים, מנחשים ומעבירים — לפני שזה מתפוצץ.</p>
    </div>
    <label class="field"><span>השם שלך</span>
      <input id="nameIn" maxlength="16" autocomplete="nickname" value="${esc(name)}" placeholder="למשל: אריאל" />
    </label>
    ${urlCode ? `
      <button class="btn primary big" data-act="join">הצטרף לחדר ${esc(urlCode)}</button>
      <input id="codeIn" type="hidden" value="${esc(urlCode)}" />
      <button class="btn ghost" data-act="create">או: פתח חדר חדש</button>
    ` : `
      <button class="btn primary big" data-act="create">פתח חדר חדש</button>
      <div class="or">או הצטרף עם קוד</div>
      <div class="row">
        <input id="codeIn" class="code-input" maxlength="4" placeholder="ABCD" autocapitalize="characters" />
        <button class="btn" data-act="join">הצטרף</button>
      </div>
      <button class="btn ghost small" data-act="create-screen">📺 פתח חדר ממסך תצוגה (לפטופ/טלוויזיה)</button>
    `}
  </section>`;
}

const guessedText = (n = 0) => (n === 1 ? "מילה אחת נוחשה" : `${n} מילים נוחשו`);
const roomUrl = () => `${location.origin}${location.pathname}?room=${S.code}`;

function scoreBar({ big = false } = {}) {
  const sc = S.room.scores || {};
  return `<div class="scorebar ${big ? "big" : ""}">
    <div class="sc ta"><span>${TEAM.A}</span><b>${sc.A || 0}</b></div>
    <div class="vs">עד ${M().target}</div>
    <div class="sc tb"><span>${TEAM.B}</span><b>${sc.B || 0}</b></div>
  </div>`;
}

function chip(u, host) {
  const p = P()[u];
  const off = !isOnline(u);
  return `<li class="chip ${host ? "draggable" : ""} ${off ? "off" : ""}" ${host ? `data-drag="${u}"` : ""}>
    <span class="avatar">${esc((p.name || "?")[0])}</span>
    <span class="pname">${esc(p.name)}${u === M().hostUid ? " 👑" : ""}${u === S.me ? ' <span class="muted">(אתה)</span>' : ""}</span>
    <span class="ready" title="${p.ready ? "מוכן" : "עוד לא לחץ 'אני מוכן'"}">${off ? "📵" : p.ready ? "✓" : "⏳"}</span>
    ${host && u !== S.me ? `<button class="x" data-act="kick" data-uid="${u}" aria-label="הוצא">✕</button>` : ""}
  </li>`;
}

function teamsView({ host }) {
  const col = (t) => `<div class="team-col ${tcls(t)}" data-team="${t}">
    <h3>${TEAM[t]} <span class="muted">(${teamList(t).length})</span></h3>
    <ul class="chips">${teamList(t).map((u) => chip(u, host)).join("") || '<li class="empty muted">אין עדיין שחקנים</li>'}</ul>
  </div>`;
  const wait = unassigned();
  return `<div class="teams">${col("A")}${col("B")}</div>
    ${wait.length || host ? `<div class="team-col none" data-team="none">
      <h3>ממתינים לשיבוץ <span class="muted">(${wait.length})</span></h3>
      <ul class="chips">${wait.map((u) => chip(u, host)).join("") || '<li class="empty muted">גרור לכאן כדי להוציא מקבוצה</li>'}</ul>
    </div>` : ""}
    ${host ? `<p class="muted small center-text">גרור שחקן בין הקבוצות, או הקש עליו כדי להעביר לקבוצה השנייה</p>` : ""}`;
}

function settingsView() {
  const cats = M().cats || {};
  return `<div class="setting">
      <div class="setting-label">🏁 משחק עד</div>
      <div class="seg" role="radiogroup">${TARGETS.map((n) => `<button type="button" role="radio" aria-checked="${n === M().target}"
        class="${n === M().target ? "on" : ""}" data-act="target" data-val="${n}">${n}</button>`).join("")}</div>
    </div>
    <div class="setting">
      <div class="setting-label">🗂️ קטגוריות</div>
      <div class="cats">${S.words.cats.map((c) => `<button type="button" class="cat ${cats[c.id] !== false ? "on" : ""}"
        data-act="cat" data-id="${c.id}" aria-pressed="${cats[c.id] !== false}">${c.emoji} ${esc(c.name)}</button>`).join("")}</div>
    </div>
    <div class="setting">
      <div class="setting-label">🚫 ערעור על "נוחש!"</div>
      <div class="seg" role="radiogroup">${[[false, "כבוי"], [true, "פעיל"]].map(([v, l]) => `<button type="button" role="radio"
        aria-checked="${!!M().appeal === v}" class="${!!M().appeal === v ? "on" : ""}" data-act="appeal-opt" data-val="${v}">${l}</button>`).join("")}</div>
      <p class="muted small">${APPEAL_TEXT}</p>
    </div>`;
}
const APPEAL_TEXT = `${APPEAL_MS / 1000} שניות אחרי "נוחש!" הקבוצה שקיבלה את הפצצה יכולה לערער, פעם אחת בכל סבב, והפצצה חוזרת למי שהעביר.`;

function canStart() {
  return teamList("A", { onlineOnly: true }).length >= MIN_PER_TEAM && teamList("B", { onlineOnly: true }).length >= MIN_PER_TEAM;
}

function hostControls() {
  const played = !!G()?.round;
  return `<section class="card settings">
    <div class="row between"><h2>הגדרות</h2><button class="btn small" data-act="shuffle">🔀 ערבב קבוצות</button></div>
    ${settingsView()}
  </section>
  <button class="btn primary big sticky" data-act="start" ${canStart() ? "" : "disabled"}>
    ${canStart() ? (played ? "▶ ממשיכים לשחק" : "💣 התחל משחק") : `צריך לפחות ${MIN_PER_TEAM} שחקנים מחוברים בכל קבוצה`}
  </button>`;
}

function readyCard() {
  const p = P()[S.me];
  if (p?.ready && audio.ready()) return `<p class="center-text good-text">✓ אתה מוכן. תשאיר את הטלפון פתוח והצליל דלוק</p>`;
  return `<button class="btn ready-btn big" data-act="ready">🔊 אני מוכן</button>
    <p class="muted small center-text">מפעיל צליל ומונע מהמסך להיכבות באמצע סבב</p>`;
}

function lobbyView() {
  const host = isHost();
  return `${header()}
  ${G()?.round ? scoreBar() : ""}
  <section class="card center-text">
    <div class="muted">קוד החדר</div>
    <div class="big-code">${esc(S.code)}</div>
    <div id="qr" class="qr"></div>
    <div class="row centered">
      <button class="btn ghost small" data-act="share">📤 שתף קישור</button>
      <a class="btn ghost small" href="?room=${esc(S.code)}&screen=1" target="_blank" rel="noopener">📺 מסך תצוגה</a>
    </div>
  </section>
  ${readyCard()}
  <section class="card">
    ${teamsView({ host })}
  </section>
  ${host ? hostControls() : `${M().appeal ? `<p class="center-text muted small">🚫 ערעור פעיל: ${APPEAL_TEXT}</p>` : ""}
  <p class="center-text muted pulse">מחכים שהמנהל יתחיל…</p>`}`;
}

// כפתור "לא נוחש!" — רק לקבוצה שקיבלה את הפצצה, רק בחלון הערעור
function appealButton() {
  const g = G();
  if (!canAppeal(g)) return "";
  S.appealUntil = g.passedAt + APPEAL_MS;
  return `<button class="btn appeal big" data-act="appeal" data-seq="${g.seq}">🚫 לא נוחש! <small>(ערעור על "${esc(g.last.w)}")</small></button>`;
}

// מילים שנוחשו בסבב, לפי הסדר. מילה שערערו עליה — מחוקה
const guessLog = (g) => Object.keys(g?.log || {}).sort((a, b) => a.slice(1) - b.slice(1)).map((k) => g.log[k]);
const guessCount = (g) => guessLog(g).filter((e) => !e.x).length;

// מי הבא בתור מהקבוצה היריבה (בשביל "אתה הבא!")
function upNext() {
  const g = G();
  const t = other(g.team);
  return nextOf(t, g.ptr?.[t] || 0)?.uid;
}

function boomView({ big = false } = {}) {
  const g = G();
  const h = g?.boom?.holder || g?.holder;
  return `<section class="boom-screen ${big ? "big" : ""}">
    <div class="boom-emoji">💥</div>
    <h1>בום!</h1>
    <p>הפצצה התפוצצה אצל <b class="${tcls(teamOf(h))}">${esc(nameOf(h))}</b></p>
  </section>`;
}

function audioGate() {
  if (audio.ready()) return "";
  return `<div class="gate">
    <div class="gate-box">
      <div class="logo-bomb">💣</div>
      <h2>הסבב התחיל!</h2>
      <p class="muted">לחץ כדי לשמוע את התקתוק ואת הפיצוץ</p>
      <button class="btn ready-btn big" data-act="ready">אני מוכן 🔊</button>
    </div>
  </div>`;
}

function playingView() {
  const g = G();
  if (S.exploded === g.round || g.boom) return boomView();
  const h = g.holder, ht = g.team, mine = h === S.me;
  if (mine) {
    ensureWord();
    const cat = catOf(S.words.byKey[S.word.wkey].cat);
    return `${header()}${scoreBar()}
    <section class="bomb-screen holder ${tcls(ht)}">
      <div id="bomb" class="bomb">💣</div>
      ${appealButton()}
      <div class="muted">הפצצה אצלך! תסביר לקבוצה שלך:</div>
      <div class="word">${esc(S.word.text)}</div>
      <div class="cat-tag">${cat.emoji} ${esc(cat.name)}</div>
      <button class="btn guessed huge" data-act="guessed" data-seq="${g.seq}">✅ נוחש!</button>
      <button class="btn ghost" data-act="skip">⏭ דלג על המילה</button>
      <p class="muted small">אסור להגיד את המילה, חלק ממנה או תרגום שלה</p>
    </section>${audioGate()}`;
  }
  const myT = teamOf(S.me);
  const next = upNext() === S.me;
  return `${header()}${scoreBar()}
  <section class="bomb-screen ${tcls(ht)}">
    <div id="bomb" class="bomb">💣</div>
    <div class="muted">הפצצה אצל</div>
    <div class="holder-name">${esc(nameOf(h))}</div>
    <div class="team-tag ${tcls(ht)}">${TEAM[ht] || ""}</div>
    <p class="hint">${!myT ? "צופה בסבב. המנהל ישבץ אותך בקבוצה" : ht === myT ? "🗣️ הקבוצה שלך מנחשת — מהר!" : "הקבוצה היריבה מנחשת. שקט!"}</p>
    ${next ? `<div class="next-me">⚡ אתה הבא בתור — תתכונן!</div>` : ""}
    ${appealButton()}
  </section>${audioGate()}`;
}

function resultsView({ big = false } = {}) {
  const g = G(), m = M();
  const h = g?.boom?.holder;
  const win = m.point?.team;
  const over = m.phase === "over";
  const host = isHost();
  const sc = S.room.scores || {};
  const winner = over ? win || (sc.A >= sc.B ? "A" : "B") : null;
  return `${S.screen ? tvTop() : header()}
  <section class="card center-text results ${big ? "big" : ""}">
    ${over ? `<div class="trophy">🏆</div><h1 class="${tcls(winner)}">${TEAM[winner]} ניצחה!</h1>
      <p class="muted">${teamList(winner).map((u) => esc(nameOf(u))).join(" · ")}</p>`
    : `<div class="boom-emoji small">💥</div>
      <p>הפצצה התפוצצה אצל <b class="${tcls(g?.boom?.team)}">${esc(nameOf(h))}</b></p>`}
    ${g?.word ? `<p>המילה הייתה: <b class="word-inline">${esc(g.word)}</b></p>` : ""}
    ${win && !over ? `<p class="point ${tcls(win)}">+1 ל${TEAM[win]}</p>` : ""}
    <p class="muted small">${guessedText(guessCount(g))} בסבב ${g?.round || ""}</p>
    ${guessLog(g).length ? `<ul class="glog">${guessLog(g).map((e) => `<li class="${tcls(e.t)} ${e.x ? "x" : ""}"
      title="${e.x ? "ערערו על המילה" : ""}">${esc(e.w)} <span class="muted">· ${esc(nameOf(e.by))}${e.x ? " 🚫" : ""}</span></li>`).join("")}</ul>` : ""}
  </section>
  ${scoreBar({ big: true })}
  ${host ? (over
    ? `<button class="btn primary big sticky" data-act="new-game">🔁 משחק חדש</button>`
    : `<button class="btn primary big sticky" data-act="start" ${canStart() ? "" : "disabled"}>${canStart() ? "💣 סבב הבא" : "חסרים שחקנים מחוברים בקבוצות"}</button>
       <button class="btn ghost" data-act="lobby">⚙️ חזרה ללובי (קבוצות והגדרות)</button>`)
    : `<p class="center-text muted pulse">מחכים שהמנהל ${over ? "יתחיל משחק חדש" : "יתחיל את הסבב הבא"}…</p>`}`;
}

// ---------- מסך תצוגה (טלוויזיה / לפטופ) ----------
function tvTop() {
  return `<header class="top tv-top">
    <div class="code-chip">חדר <b>${esc(S.code)}</b></div>
    ${isHost() ? '<div class="me-chip">👑 מנהל</div>' : ""}
    ${audio.ready() ? "" : '<button class="btn small" data-act="ready">🔊 הפעל צליל</button>'}
    <button class="leave-btn" data-act="leave" aria-label="יציאה" title="יציאה">🚪</button>
  </header>`;
}

function tvLobby() {
  const host = isHost();
  return `${tvTop()}
  <div class="tv-lobby">
    <section class="card center-text tv-join">
      <div class="muted">נכנסים מהטלפון עם הקוד</div>
      <div class="big-code huge">${esc(S.code)}</div>
      <div id="qr" class="qr"></div>
      <div class="muted small ltr">${esc(roomUrl())}</div>
    </section>
    <div class="tv-side">
      ${G()?.round ? scoreBar({ big: true }) : ""}
      <section class="card">${teamsView({ host })}</section>
      ${host ? hostControls() : ""}
    </div>
  </div>`;
}

function tvPlaying() {
  const g = G();
  if (S.exploded === g.round || g.boom) return `${tvTop()}${boomView({ big: true })}`;
  const ht = g.team;
  return `${tvTop()}${scoreBar({ big: true })}
  <section class="tv-play ${tcls(ht)}">
    <div class="muted">סבב ${g.round} · ${guessedText(guessCount(g))}</div>
    <div id="bomb" class="bomb huge">💣</div>
    <div class="muted">הפצצה אצל</div>
    <div class="holder-name huge">${esc(nameOf(g.holder))}</div>
    <div class="team-tag ${tcls(ht)}">${TEAM[ht] || ""}</div>
  </section>`;
}

function view() {
  if (!S.me || !S.words) return `<div class="center muted">מתחבר…</div>`;
  if (!S.code) return homeView();
  if (!S.room || !P()[S.me] && S.hasRecord) return `<div class="center muted">נכנס לחדר…</div>`;
  const phase = M().phase;
  // מסך הפיצוץ נשאר עוד רגע גם אחרי שהמנהל כבר עבר לתוצאות
  if (S.boomUntil && phase !== "lobby") return S.screen ? `${tvTop()}${boomView({ big: true })}` : boomView();
  if (S.screen) {
    if (phase === "lobby") return tvLobby();
    if (phase === "playing") return tvPlaying();
    return resultsView({ big: true });
  }
  switch (phase) {
    case "lobby": return lobbyView();
    case "playing": return playingView();
    case "results": case "over": return resultsView();
  }
  return "";
}

function render() {
  // באמצע גרירה לא מחליפים את ה-DOM
  if (S.dragging) { S.renderPending = true; return; }
  S.renderPending = false;
  const saved = {};
  app.querySelectorAll("input[id]").forEach((el) => (saved[el.id] = el.value));
  const focused = document.activeElement?.id;

  app.innerHTML = view();

  for (const [id, v] of Object.entries(saved)) {
    const el = document.getElementById(id);
    if (el && el.type !== "hidden") el.value = v;
  }
  if (focused) document.getElementById(focused)?.focus();

  const qr = $("#qr");
  if (qr && window.QRCode) {
    const size = S.screen ? 260 : 150;
    new window.QRCode(qr, { text: roomUrl(), width: size, height: size, colorDark: "#120d0b", colorLight: "#ffffff" });
  }
}

// ---------- Events ----------
app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const getName = () => {
    const n = $("#nameIn")?.value.trim();
    if (!n) { toast("כתוב את השם שלך", "err"); return null; }
    safeSet("bomb:name", n);
    return n;
  };
  // כל לחיצה היא הזדמנות לשחרר אודיו (iOS דורש שזה יקרה בתוך לחיצה)
  if (["create", "join", "create-screen", "ready"].includes(act)) audio.unlock();
  else audio.resume();
  try {
    switch (act) {
      case "create": { const n = getName(); if (n) { el.disabled = true; try { await createRoom(n); } finally { if (!S.code) el.disabled = false; } } break; }
      case "create-screen": { el.disabled = true; try { await createRoom("📺 מסך", { spectator: true }); } finally { if (!S.code) el.disabled = false; } break; }
      case "join": {
        const n = getName(); const c = $("#codeIn")?.value.trim();
        if (!n) break;
        if (!c || c.length !== 4) { toast("קוד החדר הוא 4 אותיות", "err"); break; }
        el.disabled = true; try { await joinRoom(c, n); } finally { if (!S.code) el.disabled = false; } break;
      }
      case "share": {
        if (navigator.share) await navigator.share({ title: "מילה-פצצה", text: `בוא לשחק! קוד: ${S.code}`, url: roomUrl() }).catch(() => {});
        else { await navigator.clipboard?.writeText(roomUrl()); toast("הקישור הועתק", "ok"); }
        break;
      }
      case "ready": await markReady(); break;
      case "leave": await leaveRoom(); break;
      case "kick": await kick(el.dataset.uid); break;
      case "shuffle": if (isHost()) hostDo(shuffleTeams); break;
      case "target": if (isHost()) await set(R("meta/target"), Number(el.dataset.val)); break;
      case "cat": {
        if (!isHost()) break;
        const cats = M().cats || {};
        const on = S.words.cats.filter((c) => cats[c.id] !== false).length;
        if (cats[el.dataset.id] !== false && on <= 1) { toast("צריך לפחות קטגוריה אחת", "err"); break; }
        await set(R(`meta/cats/${el.dataset.id}`), cats[el.dataset.id] === false);
        break;
      }
      case "start": {
        if (!isHost() || !canStart()) break;
        const notReady = Object.keys(P()).filter((u) => isPlayer(u) && teamOf(u) && isOnline(u) && !P()[u].ready);
        if (M().phase === "lobby" && notReady.length && !(await ask({ title: "לא כולם מוכנים",
          text: `${notReady.map(nameOf).join(", ")} עוד לא לחצו "אני מוכן" (בלי זה אולי לא ישמעו צליל). להתחיל בכל זאת?`, ok: "💣 התחל" }))) break;
        if (M().phase !== "playing") hostDo(startRound);
        break;
      }
      case "guessed": await guessed(Number(el.dataset.seq)); break;
      case "appeal": await doAppeal(Number(el.dataset.seq)); break;
      case "appeal-opt": if (isHost()) await set(R("meta/appeal"), el.dataset.val === "true"); break;
      case "skip": {
        const g = G();
        if (g?.holder === S.me && !g.boom) { newWord(`${S.code}:${g.round}:${g.seq}`); render(); }
        break;
      }
      case "lobby": hostDo(backToLobby); break;
      case "new-game": hostDo(newGame); break;
    }
  } catch (err) {
    console.error(err);
    toast(errText(err), "err");
    el.disabled = false;
  }
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "codeIn" || e.target.id === "nameIn") ($("[data-act=join]") || $("[data-act=create]"))?.click();
});

app.addEventListener("input", (e) => {
  if (e.target.id === "codeIn") e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
});

// ---------- גרירת שחקנים בין קבוצות (Pointer Events: עובד גם במגע וגם בעכבר) ----------
let drag = null;
const zoneAt = (x, y) => document.elementFromPoint(x, y)?.closest("[data-team]");

app.addEventListener("pointerdown", (e) => {
  const c = e.target.closest("[data-drag]");
  if (!c || e.target.closest("[data-act]") || !isHost() || e.button > 0) return;
  drag = { uid: c.dataset.drag, x: e.clientX, y: e.clientY, chip: c, ghost: null, id: e.pointerId };
});

document.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.ghost) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
    drag.ghost = drag.chip.cloneNode(true);
    drag.ghost.classList.add("ghost");
    document.body.append(drag.ghost);
    drag.chip.classList.add("lifted");
    S.dragging = true;
  }
  e.preventDefault();
  drag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
  const z = zoneAt(e.clientX, e.clientY);
  document.querySelectorAll(".team-col.over").forEach((el) => el !== z && el.classList.remove("over"));
  z?.classList.add("over");
}, { passive: false });

async function endDrag(e, cancel = false) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  S.dragging = false;
  document.querySelectorAll(".team-col.over").forEach((el) => el.classList.remove("over"));
  try {
    if (d.ghost) {
      d.ghost.remove();
      const t = cancel ? null : zoneAt(e.clientX, e.clientY)?.dataset.team;
      if (t && (t === "none" ? null : t) !== teamOf(d.uid)) await setTeam(d.uid, t === "none" ? null : t);
    } else if (!cancel) {
      // הקשה בלי גרירה: לקבוצה השנייה (או לקטנה, למי שעוד לא שובץ)
      const cur = teamOf(d.uid);
      await setTeam(d.uid, cur ? other(cur) : smallerTeam());
    }
  } catch (err) { console.error(err); toast(errText(err), "err"); }
  render();
}
document.addEventListener("pointerup", (e) => endDrag(e));
document.addEventListener("pointercancel", (e) => endDrag(e, true));

// חזרה לטאב: האודיו של iOS נעצר כשהמסך ננעל
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { audio.resume(); render(); } });
