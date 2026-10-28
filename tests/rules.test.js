// בדיקות ל-database.rules.json מול אמולטור Realtime Database.
// הרצה: npm test (מתוך התיקייה tests/, דורש Java).
// כל בדיקה מתחילה מחדר באמצע סבב: מנהל host, בקבוצה א' alice (מחזיקה את הפצצה) ו-carol, בקבוצה ב' bob ו-dave.

import { test, before, beforeEach, after } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";

const ROOM = "ABCD";
const FUSE = 60000;
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-bomb-word",
    database: { rules: readFileSync(new URL("../database.rules.json", import.meta.url), "utf8"), host: "127.0.0.1", port: 9000 },
  });
});

after(() => env.cleanup());

// startedAgo: כמה מילישניות עברו מתחילת הסבב
async function seed({ startedAgo = 1000, phase = "playing", hostOnline = true } = {}) {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const p = (name, team, order, online = true) => ({ name, team, order, joinedAt: order, online, ready: true });
    await ctx.database().ref().set({
      rooms: {
        [ROOM]: {
          meta: { hostUid: "host", phase, target: 7, cats: { food: true } },
          scores: { A: 0, B: 0 },
          players: {
            host: { name: "host", joinedAt: 0, online: hostOnline, spectator: true },
            alice: p("alice", "A", 1), carol: p("carol", "A", 2),
            bob: p("bob", "B", 3), dave: p("dave", "B", 4),
          },
          game: { round: 1, startedAt: Date.now() - startedAgo, startTeam: "A", holder: "alice", team: "A", seq: 0, ptr: { A: 1, B: 0 } },
        },
      },
      fuses: { [ROOM]: { round: 1, ms: FUSE } },
    });
  });
}

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).database();
const at = (uid, path) => db(uid).ref(`rooms/${ROOM}/${path}`);
async function getGame() {
  let g;
  await env.withSecurityRulesDisabled(async (ctx) => { g = (await ctx.database().ref(`rooms/${ROOM}/game`).get()).val(); });
  return g;
}
const passed = (g, over = {}) => ({ ...g, holder: "bob", team: "B", seq: g.seq + 1, ptr: { A: 1, B: 1 }, ...over });

beforeEach(() => seed());

// ---------- הפתיל הסודי ----------
test("אף אחד לא קורא את הפתיל, גם לא המנהל", async () => {
  await assertFails(db("alice").ref(`fuses/${ROOM}`).get());
  await assertFails(db("host").ref(`fuses/${ROOM}`).get());
});

test("רק המנהל כותב פתיל, ובטווח 40-90 שניות", async () => {
  await assertFails(db("alice").ref(`fuses/${ROOM}`).set({ round: 2, ms: 50000 }));
  await assertFails(db("host").ref(`fuses/${ROOM}`).set({ round: 2, ms: 10000 }));
  await assertSucceeds(db("host").ref(`fuses/${ROOM}`).set({ round: 2, ms: 50000 }));
});

// ---------- העברת הפצצה ----------
test("המחזיקה מעבירה לשחקן מהקבוצה היריבה", async () => {
  await assertSucceeds(at("alice", "game").set(passed(await getGame())));
});

test("מי שלא מחזיק לא יכול להעביר", async () => {
  await assertFails(at("bob", "game").set(passed(await getGame(), { holder: "dave" })));
});

test("seq חייב לעלות באחד בדיוק (לחיצה כפולה לא מעבירה פעמיים)", async () => {
  const g = await getGame();
  await assertFails(at("alice", "game").set(passed(g, { seq: g.seq })));
  await assertFails(at("alice", "game").set(passed(g, { seq: g.seq + 2 })));
  await assertSucceeds(at("alice", "game").set(passed(g)));
  // אותה לחיצה שוב, עם המצב הישן — alice כבר לא מחזיקה
  await assertFails(at("alice", "game").set(passed(g)));
});

test("אסור להעביר לחבר מאותה קבוצה", async () => {
  await assertFails(at("alice", "game").set(passed(await getGame(), { holder: "carol", team: "A" })));
  await assertFails(at("alice", "game").set(passed(await getGame(), { holder: "carol", team: "B" })));
});

test("מסירה אחרי שהפתיל נגמר נדחית בשרת", async () => {
  await seed({ startedAgo: FUSE + 500 });
  await assertFails(at("alice", "game").set(passed(await getGame())));
});

test("המחזיקה לא יכולה לשנות את זמן ההתחלה או לחשוף פיצוץ", async () => {
  const g = await getGame();
  await assertFails(at("alice", "game").set(passed(g, { startedAt: Date.now() })));
  await assertFails(at("alice", "game").set(passed(g, { explodeAt: Date.now() + 99999 })));
});

// ---------- פיצוץ ----------
test("אי אפשר לרשום פיצוץ לפני שהפתיל נגמר", async () => {
  await assertFails(at("bob", "game/boom").set({ holder: "alice", team: "A", at: 1 }));
  await assertFails(at("host", "game/boom").set({ holder: "alice", team: "A", at: 1 }));
});

test("אחרי שהפתיל נגמר: פיצוץ אחד, על המחזיקה הנוכחית", async () => {
  await seed({ startedAgo: FUSE + 500 });
  await assertFails(at("bob", "game/boom").set({ holder: "bob", team: "B", at: 1 }));
  await assertSucceeds(at("bob", "game/boom").set({ holder: "alice", team: "A", at: 1 }));
  await assertFails(at("carol", "game/boom").set({ holder: "alice", team: "A", at: 2 }));
});

test("מי שלא בחדר לא רושם פיצוץ ולא מילים", async () => {
  await seed({ startedAgo: FUSE + 500 });
  await assertFails(at("eve", "game/boom").set({ holder: "alice", team: "A", at: 1 }));
  await assertFails(at("eve", "used/food_1").set(true));
  await assertFails(at(null, "meta").get());
});

test("רק מי שהתפוצצה אצלו כותב את המילה", async () => {
  await seed({ startedAgo: FUSE + 500 });
  await assertSucceeds(at("bob", "game/boom").set({ holder: "alice", team: "A", at: 1 }));
  await assertFails(at("bob", "game/word").set("פלאפל"));
  await assertSucceeds(at("alice", "game/word").set("פלאפל"));
});

// ---------- שחקנים, ניקוד וחדרים ----------
test("שחקן לא משנה לעצמו קבוצה, לא נוגע באחרים ולא בניקוד", async () => {
  await assertFails(at("alice", "players/alice/team").set("B"));
  await assertFails(at("alice", "players/bob/name").set("xx"));
  await assertFails(at("alice", "scores/A").set(5));
  await assertFails(at("alice", "meta/phase").set("over"));
  await assertSucceeds(at("alice", "players/alice/ready").set(false));
  await assertSucceeds(at("host", "players/alice/team").set("B"));
});

test("onDisconnect של שחקן שנמחק לא יוצר רשומת רפאים", async () => {
  await assertSucceeds(at("alice", "players/alice").remove());
  await assertFails(at("alice", "players/alice/online").set(false));
});

test("יצירת חדר רק בקוד פנוי, ורק עם עצמך כמנהל", async () => {
  const room = (host) => ({ meta: { hostUid: host, phase: "lobby", target: 7 }, players: { [host]: { name: "x", joinedAt: 1, online: true } } });
  await assertSucceeds(db("eve").ref("rooms/WXYZ").set(room("eve")));
  await assertFails(db("eve").ref(`rooms/${ROOM}`).set(room("eve")));
  await assertFails(db("eve").ref("rooms/QQQQ").set(room("bob")));
  await assertFails(db("eve").ref("rooms/abcd").set(room("eve")));
});

test("רק המנהל מוחק את החדר", async () => {
  await assertFails(at("alice", "").remove());
  await assertSucceeds(db("host").ref().update({ [`rooms/${ROOM}`]: null, [`fuses/${ROOM}`]: null }));
});

test("השתלטות על תפקיד המנהל רק כשהוא לא מחובר", async () => {
  await assertFails(at("alice", "meta/hostUid").set("alice"));
  await seed({ hostOnline: false });
  await assertFails(at("alice", "meta/hostUid").set("bob"));
  await assertSucceeds(at("alice", "meta/hostUid").set("alice"));
});
