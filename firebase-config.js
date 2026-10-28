// הדבק כאן את ה-config מ-Firebase Console:
// Project settings → General → Your apps → Web app → SDK setup and configuration → Config
// חשוב: צריך גם databaseURL (מופיע אחרי שיוצרים Realtime Database בפרויקט).
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://PASTE_PROJECT_ID-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "PASTE_PROJECT_ID",
  appId: "PASTE_APP_ID",
};

// true = עבודה מול האמולטור המקומי (לבדיקות בלבד)
// פעיל אוטומטית כשפותחים את המשחק מ-localhost. כדי לעבוד מ-localhost מול הפרויקט האמיתי: ‎?live=1
export const USE_EMULATOR =
  (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  && !new URLSearchParams(location.search).has("live");

// הפרויקט שהאמולטור מדמה (demo-* לא נוגע בשום פרויקט אמיתי)
export const EMULATOR_CONFIG = {
  apiKey: "demo-key",
  authDomain: "demo-bomb-word.firebaseapp.com",
  databaseURL: "http://127.0.0.1:9000?ns=demo-bomb-word-default-rtdb",
  projectId: "demo-bomb-word",
  appId: "demo-app",
};
