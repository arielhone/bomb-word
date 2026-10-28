// הדבק כאן את ה-config מ-Firebase Console:
// Project settings → General → Your apps → Web app → SDK setup and configuration → Config
// חשוב: צריך גם databaseURL (מופיע אחרי שיוצרים Realtime Database בפרויקט).
export const firebaseConfig = {
  apiKey: "AIzaSyA63AJ0HgXDum-0dDEJEwYUPrXjEQkfGAM",
  authDomain: "bomb-word-af859.firebaseapp.com",
  databaseURL: "https://bomb-word-af859-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "bomb-word-af859",
  storageBucket: "bomb-word-af859.firebasestorage.app",
  messagingSenderId: "320586979920",
  appId: "1:320586979920:web:dc5b8867088cd750534f55",
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
