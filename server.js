// 考試系統 — 獨立版伺服器
// Node.js + Express + SQLite（Node 內置 node:sqlite，唔使裝原生模組）
// 啟動：npm install 之後 npm start，預設 http://localhost:3000
// 首次開啟先建立管理員帳號，之後考生自行註冊。登入狀態存資料庫 sessions 表。
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (e) {
  console.error("啟動失敗：需要 Node.js 22 或以上版本（建議安裝 Node.js 24 LTS），因為要用內置的 node:sqlite。");
  console.error("請去 https://nodejs.org 下載最新 LTS 版本再試。");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "exam.db");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS questions (
    question_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    answer TEXT NOT NULL,
    explanation TEXT NOT NULL DEFAULT '',
    exam TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT '中等',
    media TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS exam_records (
    exam_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    question_list TEXT NOT NULL DEFAULT '[]',
    score INTEGER,
    total_questions INTEGER NOT NULL DEFAULT 0,
    start_time TEXT NOT NULL,
    end_time TEXT,
    duration_sec INTEGER,
    status TEXT NOT NULL DEFAULT '進行中'
  );
  CREATE TABLE IF NOT EXISTS answer_records (
    record_id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER,
    user_id INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    user_answer TEXT NOT NULL DEFAULT '',
    is_correct INTEGER NOT NULL DEFAULT 0,
    answer_time TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    question_id TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS favorites (
    favorite_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS exam_progress (
    exam_id INTEGER PRIMARY KEY,
    answers TEXT NOT NULL DEFAULT '{}',
    marked TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS paper_templates (
    template_id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// ---------- 遷移：舊資料庫嘅 questions 表加 media 欄位 ----------
// 新資料庫 CREATE TABLE 已經有 media；舊資料庫升級之後第一次啟動會喺度補加。
// 用 PRAGMA 檢查欄位係咪存在，唔存在先至 ALTER TABLE，唔會影響舊資料。
(function migrateMediaColumn() {
  const cols = db.prepare("PRAGMA table_info(questions)").all();
  if (!cols.some((c) => c.name === "media")) {
    db.exec("ALTER TABLE questions ADD COLUMN media TEXT NOT NULL DEFAULT '[]'");
    console.log("資料庫遷移：questions 表已加 media 欄位（題目圖片／影片）。");
  }
})();

// ---------- 種子資料：第一次啟動、題庫為空時寫入 Test-001 ----------
function seedIfEmpty() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM questions").get();
  if (row.n > 0) return;
  const seedPath = path.join(ROOT, "seed.json");
  if (!fs.existsSync(seedPath)) return;
  let seed = [];
  try { seed = JSON.parse(fs.readFileSync(seedPath, "utf8")); } catch (e) { return; }
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO questions (question_id,type,content,options,answer,explanation,exam,difficulty,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const s of seed) {
    ins.run(s.question_id, s.type, s.content, JSON.stringify(s.options || []), s.answer, s.explanation || "", s.exam || "", s.difficulty || "中等", now);
  }
  console.log("已寫入種子題目：Test-001（一條試驗題，等你之後用 CSV 匯入更多 VTS / 430 題）。");
}
seedIfEmpty();

// ---------- 小工具 ----------
function nowIso() { return new Date().toISOString(); }
function safeJson(s, fallback) { try { return JSON.parse(s); } catch (e) { return fallback; } }
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(pw, salt, 100000, 64, "sha512").toString("hex");
  return salt + "$" + hash;
}
function verifyPassword(pw, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 2) return false;
  const hash = crypto.pbkdf2Sync(pw, parts[0], 100000, 64, "sha512").toString("hex");
  try { return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(parts[1])); } catch (e) { return false; }
}
function newToken() { return crypto.randomBytes(32).toString("hex"); }
function publicUser(u) { return u ? { user_id: u.user_id, username: u.username, role: u.role, created_at: u.created_at } : null; }
function rowToQuestion(r) {
  if (!r) return null;
  return { question_id: r.question_id, type: r.type, content: r.content, options: safeJson(r.options, []), answer: r.answer, explanation: r.explanation, exam: r.exam, difficulty: r.difficulty, media: parseMedia(r.media), created_at: r.created_at };
}
// media 欄位存 JSON 陣列，每項係 {type:"image"|"video", url, place, option?}：
// place 係 stem（題幹）/ explanation（解析）/ option（某個選項），
// place 係 option 嗰陣 option 係該選項嘅字母（例如 "B"）；冇寫明位置嘅當題幹處理。
// 舊資料或者格式唔啱，一律當做冇媒體，唔會令成題壞掉。
function parseMedia(v) {
  const a = safeJson(v, []);
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const x of a) {
    const r = normalizeMediaItem(x);
    if (r.ok) out.push(r.item);
  }
  return out;
}
// 逐項驗證一格媒體：連結只接受 /uploads/ 或者 http(s)；type 唔寫就按副檔名估；
// place 唔寫或者唔啱就當題幹；place 係 option 一定要指明邊個選項。
function normalizeMediaItem(it) {
  if (!it || typeof it !== "object") return { ok: false, error: "媒體格式唔啱。" };
  const url = String(it.url || "").trim();
  if (!url) return { ok: false, error: "媒體連結唔可以留空。" };
  if (!isSafeMediaUrl(url)) return { ok: false, error: "媒體連結唔啱：淨係接受 /uploads/ 檔案或者 http(s) 連結（" + url + "）。" };
  let place = String(it.place || "stem").trim().toLowerCase();
  if (!["stem", "explanation", "option"].includes(place)) place = "stem";
  let option = null;
  if (place === "option") {
    option = String(it.option || "").trim().toUpperCase();
    if (!/^[A-Z]$/.test(option)) return { ok: false, error: "選項圖片要指明係邊個選項（例如 B）。" };
  }
  const type = it.type === "video" || it.type === "image" ? it.type : (VIDEO_EXTS.has(mediaExtOf(url)) ? "video" : "image");
  const item = { type, url, place };
  if (place === "option") item.option = option;
  return { ok: true, item };
}
function hideAnswer(q) {
  if (!q) return null;
  const c = Object.assign({}, q);
  delete c.answer;
  return c;
}

// ---------- 交易小工具：出錯就成個 rollback，唔會做一半 ----------
// 注意：node:sqlite 係同步 API，fn 入面唔可以用 await。
function withTx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (e2) {}
    throw e;
  }
}

// ---------- 登入次數限制 ----------
// 同一 IP 加同一帳號，15 分鐘內失敗 5 次就暫時鎖 15 分鐘（返 429），時間到自動解鎖，唔會鎖死。
// 存喺記憶體，伺服器重啟會清空；管理員帳號一樣受呢個限制，但只係鎖 15 分鐘，唔使人手解鎖。
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map();
function loginKey(req, username) { return (req.ip || "?") + "\n" + String(username || ""); }
function loginLockedMinutes(req, username) {
  const rec = loginFails.get(loginKey(req, username));
  if (!rec) return 0;
  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) return Math.ceil((rec.lockedUntil - now) / 60000);
  if (now - rec.firstAt > LOGIN_WINDOW_MS) { loginFails.delete(loginKey(req, username)); return 0; }
  return 0;
}
function recordLoginFail(req, username) {
  const key = loginKey(req, username);
  const now = Date.now();
  let rec = loginFails.get(key);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) rec = { count: 0, firstAt: now, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= LOGIN_MAX_FAILS) rec.lockedUntil = now + LOGIN_LOCK_MS;
  loginFails.set(key, rec);
}
function clearLoginFails(req, username) { loginFails.delete(loginKey(req, username)); }

// ---------- 登入狀態有效期：30 日 ----------
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ---------- 答案格式驗證 ----------
// 單選只准一個字母；多選字母自動排序正規化；字母超出選項範圍即報錯；
// 判斷題答案必須係選項之一。回傳 { ok, normalized, error }
function validateAnswer(type, options, answer) {
  const opts = Array.isArray(options) ? options : [];
  const a = String(answer == null ? "" : answer).trim();
  if (!a) return { ok: false, error: "答案唔可以留空。" };
  const letters = opts.map((_, i) => String.fromCharCode(65 + i));
  if (type === "單選") {
    const up = a.toUpperCase();
    if (!/^[A-Z]$/.test(up)) return { ok: false, error: "單選答案只准一個字母（例如 B）。" };
    if (!letters.includes(up)) return { ok: false, error: "答案 " + up + " 超出選項範圍（得 " + letters.join("、") + "）。" };
    return { ok: true, normalized: up };
  }
  if (type === "多選") {
    const parts = a.toUpperCase().replace(/[^A-Z]/g, "").split("").filter(Boolean);
    const uniq = Array.from(new Set(parts)).sort();
    if (uniq.length === 0) return { ok: false, error: "多選答案至少要一個字母（例如 A、C）。" };
    for (const L of uniq) {
      if (!letters.includes(L)) return { ok: false, error: "答案 " + L + " 超出選項範圍（得 " + letters.join("、") + "）。" };
    }
    return { ok: true, normalized: uniq.join("") };
  }
  if (type === "判斷") {
    if (opts.includes(a)) return { ok: true, normalized: a };
    const up = a.toUpperCase();
    if (/^[A-Z]$/.test(up) && letters.includes(up)) return { ok: true, normalized: opts[letters.indexOf(up)] };
    return { ok: false, error: "判斷題答案必須係選項之一（" + opts.join(" / ") + "）。" };
  }
  return { ok: true, normalized: a };
}
function gradeAnswer(q, userAnswer) {
  if (!q) return false;
  const ua = String(userAnswer == null ? "" : userAnswer).trim();
  if (q.type === "多選") {
    const norm = (s) => String(s).toUpperCase().replace(/[^A-Z]/g, "").split("").filter(Boolean).sort().join("");
    return norm(ua) === norm(q.answer) && ua !== "";
  }
  if (q.type === "判斷") {
    if (ua === q.answer) return true;
    const letters = q.options.map((_, i) => String.fromCharCode(65 + i));
    const idx = letters.indexOf(ua.toUpperCase());
    if (idx >= 0) return q.options[idx] === q.answer;
    return false;
  }
  if (q.type === "單選") return ua.toUpperCase() === String(q.answer).toUpperCase();
  return false;
}

// ---------- CSV 解析（支援引號、逗號、換行） ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const s = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else { field += c; }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}
function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function parseOptionsCell(cell) {
  const t = String(cell == null ? "" : cell).trim();
  if (!t) return [];
  if (t.startsWith("[")) { try { const a = JSON.parse(t); return Array.isArray(a) ? a.map(String) : []; } catch (e) { return []; } }
  return t.split("|").map((x) => x.trim()).filter(Boolean);
}
// CSV 匯出用：media 欄寫返位置前綴，匯入嗰陣可以原樣還原。
// 題幹唔寫前綴，選項寫 optB:連結，解析寫 explanation:連結。
function mediaCellForCsv(media) {
  return parseMedia(media).map((mItem) => {
    if (mItem.place === "option") return "opt" + (mItem.option || "") + ":" + mItem.url;
    if (mItem.place === "explanation") return "explanation:" + mItem.url;
    return mItem.url;
  }).join(";");
}
const CSV_HEADERS = ["question_id", "type", "content", "options", "answer", "explanation", "exam", "difficulty", "media"];
function csvTemplate() {
  const rows = [
    ["DEMO-001", "單選", "避碰規則：兩船對遇時，邊一邊應該讓路？", "左舷讓路|右舷讓路|直航船讓路|兩船同時轉向", "A", "對遇局面，兩船都應該向右轉，互相從左舷通過。", "VTS", "簡單", "stem:https://example.com/eg-ship.jpg"],
    ["DEMO-002", "多選", "以下邊啲屬於 VTS 服務範圍？", "船舶交通組織|助航服務|危險品監控|天氣預報", "ABC", "VTS 提供交通組織、助航同危險品監控，天氣預報唔係 VTS 本身服務。", "VTS", "中等", ""],
    ["DEMO-003", "判斷", "追越船必須讓路給被追越船。", "正確|錯誤", "正確", "追越船係讓路船，必須避讓被追越船。", "VTS", "簡單", "optA:https://example.com/eg-yes.jpg"],
    ["DEMO-004", "簡答", "請簡述 VHF 第 16 頻道嘅用途。", "", "第 16 頻道係國際遇險、緊急同呼叫頻道，用於遇險求救同建立聯絡，聯絡好之後要轉去工作頻道通話，唔好長期佔用。", "第 16 頻道係國際遇險、緊急同呼叫頻道，用於遇險求救同建立聯絡，聯絡好之後要轉去工作頻道通話，唔好長期佔用。", "VTS", "中等", "explanation:https://example.com/eg-ch16.mp4"],
  ];
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  return lines.join("\n");
}

// ---------- 題目媒體（圖片／影片） ----------
// 每條題目最多 5 個媒體。連結只接受兩種：/uploads/ 開頭（本站上傳嘅檔案）
// 或者 http(s) 連結（外部圖片／影片）。其他寫法（javascript:、data:、相對路徑、
// 含 ..）一律拒絕，避免 XSS 同路徑穿越。
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_MAX_BYTES = 20 * 1024 * 1024;
const MEDIA_MAX_PER_QUESTION = 5;
function mediaExtOf(url) {
  const clean = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  const i = clean.lastIndexOf(".");
  return i >= 0 ? clean.slice(i) : "";
}
function isSafeMediaUrl(url) {
  const u = String(url || "").trim();
  if (!u || /\s/.test(u)) return false;
  if (u.startsWith("/uploads/")) return !u.includes("..");
  return /^https?:\/\/[^/]+/i.test(u);
}
// 嚴格版：傳一個唔啱就成題失敗（新增／修改題目用）。
function normalizeMedia(input) {
  if (input == null || input === "") return { ok: true, media: [] };
  let arr;
  if (typeof input === "string") {
    const t = input.trim();
    if (!t) return { ok: true, media: [] };
    if (t.startsWith("[")) {
      try { const a = JSON.parse(t); if (!Array.isArray(a)) return { ok: false, error: "媒體格式唔啱。" }; arr = a; }
      catch (e) { return { ok: false, error: "媒體格式唔啱。" }; }
    } else arr = t.split(";").map((s) => s.trim()).filter(Boolean).map((u) => ({ url: u }));
  } else if (Array.isArray(input)) arr = input;
  else return { ok: false, error: "媒體格式唔啱。" };
  if (arr.length > MEDIA_MAX_PER_QUESTION) return { ok: false, error: "每條題目最多 " + MEDIA_MAX_PER_QUESTION + " 個媒體。" };
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    const r = normalizeMediaItem(it);
    if (!r.ok) return r;
    const key = r.item.place + "|" + (r.item.option || "") + "|" + r.item.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.item);
  }
  return { ok: true, media: out };
}
// 寬鬆版：逐條連結驗證，唔啱就跳過並記低（CSV 匯入用，唔好因為一條連結錯成行題目都唔入）。
// 支援位置前綴：stem:連結（題幹，唔寫前綴都當題幹）、optB:連結（選項 B）、explanation:連結（解析），用 ; 分隔。
function parseMediaListLenient(cell) {
  const media = [];
  const skipped = [];
  const parts = String(cell == null ? "" : cell).split(";").map((s) => s.trim()).filter(Boolean);
  for (const seg of parts) {
    if (media.length >= MEDIA_MAX_PER_QUESTION) { skipped.push(seg + "（超過每題 5 個上限）"); continue; }
    let place = "stem", option = null, url = seg;
    const m = seg.match(/^(stem|explanation|opt([A-Za-z]))\s*:\s*(.+)$/i);
    if (m) {
      const head = m[1].toLowerCase();
      if (head === "explanation") place = "explanation";
      else if (head.startsWith("opt")) { place = "option"; option = m[2].toUpperCase(); }
      url = m[3].trim();
    }
    const r = normalizeMediaItem({ url, place, option });
    if (!r.ok) { skipped.push(seg + "（" + r.error + "）"); continue; }
    const key = r.item.place + "|" + (r.item.option || "") + "|" + r.item.url;
    if (media.some((mm) => mm.place + "|" + (mm.option || "") + "|" + mm.url === key)) continue;
    media.push(r.item);
  }
  return { media, skipped };
}
// 備份還原用：將任何形式嘅 media 寫法正規化做可以存入資料庫嘅 JSON 字串。
function mediaJson(v) {
  if (typeof v === "string") {
    try { const a = JSON.parse(v); if (Array.isArray(a)) return JSON.stringify(parseMedia(v)); } catch (e) {}
    const r = normalizeMedia(v);
    return r.ok ? JSON.stringify(r.media) : "[]";
  }
  if (Array.isArray(v)) return JSON.stringify(parseMedia(JSON.stringify(v)));
  return "[]";
}

// ---------- 驗證一題（新增、修改、匯入共用） ----------
function validateQuestionInput(b, isNew) {
  const qid = String(b.question_id || "").trim();
  const type = String(b.type || "").trim();
  const content = String(b.content || "").trim();
  const exam = String(b.exam || "").trim();
  const difficulty = String(b.difficulty || "中等").trim();
  const explanation = String(b.explanation || "").trim();
  const options = Array.isArray(b.options) ? b.options.map(String) : parseOptionsCell(b.options);
  const answer = String(b.answer == null ? "" : b.answer).trim();
  const missing = [];
  if (!qid) missing.push("編號");
  if (!content) missing.push("題幹");
  if (!exam) missing.push("考試");
  if (!type) missing.push("題型");
  if (type === "單選" || type === "多選") {
    if (options.length < 2) missing.push("選項（至少兩個）");
  }
  if (type === "判斷") {
    if (options.length < 2) missing.push("選項（判斷題要兩個選項，例如 正確、錯誤）");
  }
  if (!answer) missing.push("答案");
  if (missing.length > 0) return { ok: false, error: "請填寫： " + missing.join("、") + "。" };
  if (!["單選", "多選", "判斷", "簡答"].includes(type)) return { ok: false, error: "題型只可以係單選、多選、判斷、簡答。" };
  if (!["簡單", "中等", "困難"].includes(difficulty)) return { ok: false, error: "難度只可以係簡單、中等、困難。" };
  const mediaRes = normalizeMedia(b.media);
  if (!mediaRes.ok) return { ok: false, error: mediaRes.error };
  if (type !== "簡答") {
    const v = validateAnswer(type, options, answer);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, q: { question_id: qid, type, content, options, answer: v.normalized, explanation, exam, difficulty, media: mediaRes.media } };
  }
  return { ok: true, q: { question_id: qid, type, content, options, answer, explanation, exam, difficulty, media: mediaRes.media } };
}
function saveQuestion(q) {
  const now = nowIso();
  db.prepare("INSERT INTO questions (question_id,type,content,options,answer,explanation,exam,difficulty,media,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(question_id) DO UPDATE SET type=excluded.type, content=excluded.content, options=excluded.options, answer=excluded.answer, explanation=excluded.explanation, exam=excluded.exam, difficulty=excluded.difficulty, media=excluded.media").run(q.question_id, q.type, q.content, JSON.stringify(q.options), q.answer, q.explanation, q.exam, q.difficulty, JSON.stringify(q.media || []), now);
}

// ---------- Express ----------
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // 經 nginx 反向代理時，req.ip 先至係訪客真實 IP（登入次數限制用）
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "20mb" })); // 還原備份 JSON 可能比較大
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, "public")));
// 題目上傳嘅圖片／影片：檔案實體存喺 data/uploads/（更新成個資料夾覆蓋嗰陣唔會刪走），
// 用 /uploads 掛出嚟。副檔名已經喺上傳嗰陣驗證過（唔接受 svg / html 等），加埋 nosniff header。
app.use("/uploads", express.static(UPLOAD_DIR));

// ---------- 認證 ----------
function getSessionUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : (req.headers["x-session"] || "");
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(token);
  if (!s) return null;
  // 30 日過期：過期 token 自動失效兼刪除
  const created = new Date(s.created_at).getTime();
  if (!isNaN(created) && Date.now() - created > SESSION_MAX_AGE_MS) {
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run(token);
    return null;
  }
  const u = db.prepare("SELECT * FROM users WHERE user_id = ?").get(s.user_id);
  return u ? publicUser(u) : null;
}
function requireAuth(req, res, next) {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error: "請先登入。" });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "只有管理員先可以用呢個功能。" });
  next();
}
function createSessionFor(userId) {
  // 順手清理已過期嘅舊 token，唔等 sessions 表無限變大
  db.prepare("DELETE FROM sessions WHERE created_at < ?").run(new Date(Date.now() - SESSION_MAX_AGE_MS).toISOString());
  const token = newToken();
  db.prepare("INSERT INTO sessions (session_id, user_id, created_at) VALUES (?,?,?)").run(token, userId, nowIso());
  return token;
}

app.get("/api/bootstrap", (req, res) => {
  const n = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  res.json({ configured: n > 0, hasAdmin: n > 0, userCount: n });
});

// 首次開啟：未有任何帳號時，註冊即係建立管理員
app.post("/api/auth/register", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!username || !password) return res.status(400).json({ error: "請填寫帳號同密碼。" });
  if (password.length < 6) return res.status(400).json({ error: "密碼至少要 6 個字。" });
  const total = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const role = total === 0 ? "admin" : "user";
  try {
    const info = db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)").run(username, hashPassword(password), role, nowIso());
    const u = db.prepare("SELECT * FROM users WHERE user_id = ?").get(info.lastInsertRowid);
    const token = createSessionFor(u.user_id);
    res.json({ token, user: publicUser(u), firstAdmin: total === 0 });
  } catch (e) {
    return res.status(400).json({ error: "呢個帳號已經有人用咗，請換另一個。" });
  }
});
app.post("/api/auth/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const waitMin = loginLockedMinutes(req, username);
  if (waitMin > 0) return res.status(429).json({ error: "登入失敗太多次，請等 " + waitMin + " 分鐘再試。" });
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!u || !verifyPassword(password, u.password_hash)) {
    recordLoginFail(req, username);
    return res.status(401).json({ error: "帳號或者密碼唔啱。" });
  }
  clearLoginFails(req, username);
  const token = createSessionFor(u.user_id);
  res.json({ token, user: publicUser(u) });
});
app.post("/api/auth/logout", requireAuth, (req, res) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (token) db.prepare("DELETE FROM sessions WHERE session_id = ?").run(token);
  res.json({ ok: true });
});
app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.user }));
app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const oldPw = String(req.body.oldPassword || "");
  const newPw = String(req.body.newPassword || "");
  if (newPw.length < 6) return res.status(400).json({ error: "新密碼至少要 6 個字。" });
  const u = db.prepare("SELECT * FROM users WHERE user_id = ?").get(req.user.user_id);
  if (!u || !verifyPassword(oldPw, u.password_hash)) return res.status(400).json({ error: "舊密碼唔啱。" });
  db.prepare("UPDATE users SET password_hash = ? WHERE user_id = ?").run(hashPassword(newPw), req.user.user_id);
  res.json({ ok: true });
});

// ---------- 帳號管理（管理員） ----------
app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM users ORDER BY user_id").all();
  res.json({ users: rows.map(publicUser) });
});
app.post("/api/admin/users/:id/role", requireAuth, requireAdmin, (req, res) => {
  const role = String(req.body.role || "");
  if (!["user", "admin"].includes(role)) return res.status(400).json({ error: "角色只可以係 user 或者 admin。" });
  const id = Number(req.params.id);
  if (id === req.user.user_id && role === "user") {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (admins <= 1) return res.status(400).json({ error: "唔可以將最後一個管理員降級。" });
  }
  db.prepare("UPDATE users SET role = ? WHERE user_id = ?").run(role, id);
  res.json({ ok: true });
});

// ---------- 媒體上傳（管理員） ----------
// 上傳即存檔，唔使事先開題目；回傳嘅 url 填入題目表格嘅媒體清單就得。
// 檔案名用隨機名加原本副檔名，唔用用戶傳上嚟嘅檔名（防路徑穿越）；
// 圖片唔多過 5 MB、影片唔多過 20 MB；每條題目最多 5 個媒體（喺儲存題目嗰陣驗證）。
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      cb(null, crypto.randomBytes(16).toString("hex") + ext);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) return cb(null, true);
    cb(new Error("唔接受呢種檔案格式：圖片只接受 jpg / jpeg / png / gif / webp，影片只接受 mp4 / webm / mov（唔接受 svg、html 等）。"));
  },
  limits: { fileSize: VIDEO_MAX_BYTES },
});
app.post("/api/upload", requireAuth, requireAdmin, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "檔案太大：圖片唔可以超過 5 MB，影片唔可以超過 20 MB。" });
      return res.status(400).json({ error: err.message || "上傳失敗。" });
    }
    if (!req.file) return res.status(400).json({ error: "請揀一個檔案上傳。" });
    const ext = path.extname(req.file.filename).toLowerCase();
    const type = VIDEO_EXTS.has(ext) ? "video" : "image";
    const max = type === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
    if (req.file.size > max) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "圖片唔可以超過 5 MB（你上傳咗 " + Math.round(req.file.size / 1024 / 1024 * 10) / 10 + " MB）。" });
    }
    res.json({ url: "/uploads/" + req.file.filename, type });
  });
});

// ---------- 題庫 ----------
app.get("/api/questions", requireAuth, (req, res) => {
  const { exam, difficulty, type, q } = req.query;
  let sql = "SELECT * FROM questions WHERE 1=1";
  const params = [];
  if (exam) { sql += " AND exam = ?"; params.push(exam); }
  if (difficulty) { sql += " AND difficulty = ?"; params.push(difficulty); }
  if (type) { sql += " AND type = ?"; params.push(type); }
  if (q) { sql += " AND (content LIKE ? OR question_id LIKE ?)"; params.push("%" + q + "%", "%" + q + "%"); }
  sql += " ORDER BY question_id";
  const rows = db.prepare(sql).all(...params);
  // 考生唔可以直接由列表拎到答案：非管理員一律隱藏答案。題庫管理頁本身只限管理員用，唔受影響。
  res.json({ questions: rows.map((r) => req.user.role === "admin" ? rowToQuestion(r) : hideAnswer(rowToQuestion(r))) });
});
app.get("/api/questions/exams", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT DISTINCT exam FROM questions WHERE exam != '' ORDER BY exam").all();
  res.json({ exams: rows.map((r) => r.exam) });
});
app.get("/api/questions/template", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"exam-template.csv\"");
  res.send("\ufeff" + csvTemplate());
});
app.get("/api/questions/:id", requireAuth, requireAdmin, (req, res) => {
  const r = db.prepare("SELECT * FROM questions WHERE question_id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "搵唔到呢條題目。" });
  res.json({ question: rowToQuestion(r) });
});
app.post("/api/questions", requireAuth, requireAdmin, (req, res) => {
  const v = validateQuestionInput(req.body || {}, true);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const exists = db.prepare("SELECT 1 FROM questions WHERE question_id = ?").get(v.q.question_id);
  if (exists) return res.status(400).json({ error: "編號 " + v.q.question_id + " 已經存在，請用修改或者匯入覆蓋。" });
  saveQuestion(v.q);
  res.json({ question: v.q });
});
app.put("/api/questions/:id", requireAuth, requireAdmin, (req, res) => {
  const body = Object.assign({}, req.body || {}, { question_id: req.params.id });
  const exists = db.prepare("SELECT * FROM questions WHERE question_id = ?").get(req.params.id);
  if (!exists) return res.status(404).json({ error: "搵唔到呢條題目。" });
  // 修改請求如果冇帶 media 欄位（例如舊版前端），保留原本嘅媒體，唔好無啦啦清走。
  if (body.media === undefined) body.media = parseMedia(exists.media);
  const v = validateQuestionInput(body, false);
  if (!v.ok) return res.status(400).json({ error: v.error });
  saveQuestion(v.q);
  res.json({ question: v.q });
});
app.delete("/api/questions/:id", requireAuth, requireAdmin, (req, res) => {
  // 刪題目一併清理佢嘅答題紀錄、收藏同相關留言，唔留孤兒紀錄
  withTx(() => {
    db.prepare("DELETE FROM questions WHERE question_id = ?").run(req.params.id);
    db.prepare("DELETE FROM answer_records WHERE question_id = ?").run(req.params.id);
    db.prepare("DELETE FROM favorites WHERE question_id = ?").run(req.params.id);
    db.prepare("DELETE FROM comments WHERE question_id = ?").run(req.params.id);
  });
  res.json({ ok: true });
});

// ---------- 題庫批量管理（管理員） ----------
app.post("/api/questions/batch-delete", requireAuth, requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? Array.from(new Set(req.body.ids.map(String).map((s) => s.trim()).filter(Boolean))) : [];
  if (ids.length === 0) return res.status(400).json({ error: "請先揀要刪除嘅題目。" });
  if (ids.length > 500) return res.status(400).json({ error: "一次最多刪除 500 題。" });
  const out = withTx(() => {
    let deleted = 0, answersRemoved = 0, favoritesRemoved = 0, commentsRemoved = 0;
    const delQ = db.prepare("DELETE FROM questions WHERE question_id = ?");
    const delA = db.prepare("DELETE FROM answer_records WHERE question_id = ?");
    const delF = db.prepare("DELETE FROM favorites WHERE question_id = ?");
    const delC = db.prepare("DELETE FROM comments WHERE question_id = ?");
    for (const id of ids) {
      if (delQ.run(id).changes) deleted++;
      answersRemoved += delA.run(id).changes;
      favoritesRemoved += delF.run(id).changes;
      commentsRemoved += delC.run(id).changes;
    }
    return { deleted, answersRemoved, favoritesRemoved, commentsRemoved };
  });
  res.json(Object.assign({ ok: true }, out));
});
app.post("/api/questions/batch-update", requireAuth, requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? Array.from(new Set(req.body.ids.map(String).map((s) => s.trim()).filter(Boolean))) : [];
  if (ids.length === 0) return res.status(400).json({ error: "請先揀要修改嘅題目。" });
  if (ids.length > 500) return res.status(400).json({ error: "一次最多修改 500 題。" });
  const exam = req.body.exam != null && String(req.body.exam) !== "" ? String(req.body.exam).trim() : null;
  const difficulty = req.body.difficulty != null && String(req.body.difficulty) !== "" ? String(req.body.difficulty).trim() : null;
  if (exam != null && exam.length > 50) return res.status(400).json({ error: "考試名稱唔可以超過 50 個字。" });
  if (difficulty != null && !["簡單", "中等", "困難"].includes(difficulty)) return res.status(400).json({ error: "難度只可以係簡單、中等、困難。" });
  if (exam == null && difficulty == null) return res.status(400).json({ error: "請揀要改嘅分類或者難度。" });
  const sets = [];
  const params = [];
  if (exam != null) { sets.push("exam = ?"); params.push(exam); }
  if (difficulty != null) { sets.push("difficulty = ?"); params.push(difficulty); }
  const out = withTx(() => {
    const stmt = db.prepare("UPDATE questions SET " + sets.join(", ") + " WHERE question_id = ?");
    let updated = 0;
    for (const id of ids) {
      if (stmt.run(...params, id).changes) updated++;
    }
    return { updated };
  });
  res.json(Object.assign({ ok: true }, out));
});

// ---------- CSV 批次匯入 ----------
app.post("/api/questions/import", requireAuth, requireAdmin, (req, res) => {
  const csv = String(req.body.csv || "");
  const mode = req.body.mode === "overwrite" ? "overwrite" : "skip";
  if (!csv.trim()) return res.status(400).json({ error: "請貼上或者上載 CSV 內容。" });
  const rows = parseCsv(csv);
  if (rows.length < 2) return res.status(400).json({ error: "CSV 入面冇資料行，請檢查檔案。" });
  const header = rows[0].map((h) => String(h).trim().replace(/^\ufeff/, ""));
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const examCol = idx.exam != null ? idx.exam : (idx.chapter != null ? idx.chapter : (idx["章節"] != null ? idx["章節"] : null));
  const need = ["question_id", "type", "content", "answer"];
  for (const c of need) {
    if (idx[c] == null) return res.status(400).json({ error: "CSV 缺少欄位：" + c + "，請用範本格式。" });
  }
  const get = (r, name) => { const i = idx[name]; return i == null ? "" : String(r[i] == null ? "" : r[i]); };
  let imported = 0, skipped = 0, overwritten = 0;
  const errors = [];
  const seenInFile = new Set();
  for (let i = 1; i < rows.length; i++) {
    const lineNo = i + 1;
    const r = rows[i];
    if (r.every((c) => String(c).trim() === "")) continue;
    const raw = {
      question_id: get(r, "question_id").trim(),
      type: get(r, "type").trim(),
      content: get(r, "content").trim(),
      options: get(r, "options"),
      answer: get(r, "answer").trim(),
      explanation: get(r, "explanation").trim(),
      exam: examCol != null ? String(r[examCol] == null ? "" : r[examCol]).trim() : "",
      difficulty: (get(r, "difficulty").trim() || "中等"),
      media: get(r, "media"),
    };
    if (!raw.question_id) { errors.push("第 " + lineNo + " 行：缺少編號 question_id。"); continue; }
    if (seenInFile.has(raw.question_id)) { errors.push("第 " + lineNo + " 行：編號 " + raw.question_id + " 喺檔案內重複咗。"); continue; }
    seenInFile.add(raw.question_id);
    // media 欄用寬鬆版解析：唔啱格式嘅連結逐條跳過、記低，其餘照入，唔好因為一條連結錯成行題目都唔入。
    const mediaNote = parseMediaListLenient(raw.media);
    raw.media = mediaNote.media;
    const v = validateQuestionInput(raw, true);
    if (!v.ok) { errors.push("第 " + lineNo + " 行（" + raw.question_id + "）：" + v.error); continue; }
    if (mediaNote.skipped.length > 0) {
      errors.push("第 " + lineNo + " 行（" + raw.question_id + "）：媒體連結唔啱，已跳過：" + mediaNote.skipped.join("、") + "。");
    }
    const exists = db.prepare("SELECT 1 FROM questions WHERE question_id = ?").get(v.q.question_id);
    if (exists && mode === "skip") { skipped++; continue; }
    if (exists && mode === "overwrite") overwritten++;
    saveQuestion(v.q);
    imported++;
  }
  res.json({ imported, skipped, overwritten, errors });
});

// ---------- 刷題 ----------
app.post("/api/practice/draw", requireAuth, (req, res) => {
  const b = req.body || {};
  const count = Math.max(1, Math.min(50, Number(b.count) || 10));
  const excludeIds = Array.isArray(b.excludeIds) ? b.excludeIds : [];
  let pool;
  if (b.wrongOnly) {
    const rows = db.prepare("SELECT DISTINCT question_id FROM answer_records WHERE user_id = ? AND is_correct = 0").all(req.user.user_id);
    const ids = rows.map((r) => r.question_id);
    if (ids.length === 0) return res.json({ questions: [], total: 0 });
    const ph = ids.map(() => "?").join(",");
    pool = db.prepare("SELECT * FROM questions WHERE question_id IN (" + ph + ")").all(...ids);
  } else {
    let sql = "SELECT * FROM questions WHERE 1=1";
    const params = [];
    if (b.exam) { sql += " AND exam = ?"; params.push(b.exam); }
    if (b.difficulty) { sql += " AND difficulty = ?"; params.push(b.difficulty); }
    if (b.type) { sql += " AND type = ?"; params.push(b.type); }
    pool = db.prepare(sql).all(...params);
  }
  const filtered = pool.filter((q) => !excludeIds.includes(q.question_id));
  for (let i = filtered.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = filtered[i]; filtered[i] = filtered[j]; filtered[j] = t; }
  const picked = filtered.slice(0, count);
  res.json({ questions: picked.map((r) => hideAnswer(rowToQuestion(r))), total: filtered.length });
});
app.post("/api/practice/answer", requireAuth, (req, res) => {
  const b = req.body || {};
  const r = db.prepare("SELECT * FROM questions WHERE question_id = ?").get(b.question_id);
  if (!r) return res.status(404).json({ error: "搵唔到呢條題目。" });
  const q = rowToQuestion(r);
  const userAnswer = String(b.user_answer == null ? "" : b.user_answer);
  if (q.type === "簡答") {
    if (b.self_correct === true || b.self_correct === false) {
      db.prepare("INSERT INTO answer_records (exam_id, user_id, question_id, user_answer, is_correct, answer_time) VALUES (NULL,?,?,?, ?,?)").run(req.user.user_id, q.question_id, userAnswer, b.self_correct ? 1 : 0, nowIso());
      return res.json({ correct: b.self_correct, reference: q.answer, explanation: q.explanation });
    }
    return res.json({ correct: null, reference: q.answer, explanation: q.explanation });
  }
  const correct = gradeAnswer(q, userAnswer);
  db.prepare("INSERT INTO answer_records (exam_id, user_id, question_id, user_answer, is_correct, answer_time) VALUES (NULL,?,?,?, ?,?)").run(req.user.user_id, q.question_id, userAnswer, correct ? 1 : 0, nowIso());
  res.json({ correct, answer: q.answer, explanation: q.explanation });
});

// ---------- 收藏 ----------
app.get("/api/favorites", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT q.* FROM favorites f JOIN questions q ON q.question_id = f.question_id WHERE f.user_id = ? ORDER BY f.favorite_id DESC").all(req.user.user_id);
  res.json({ questions: rows.map((r) => hideAnswer(rowToQuestion(r))) });
});
app.post("/api/favorites/:id", requireAuth, (req, res) => {
  db.prepare("INSERT OR IGNORE INTO favorites (user_id, question_id, created_at) VALUES (?,?,?)").run(req.user.user_id, req.params.id, nowIso());
  res.json({ ok: true });
});
app.delete("/api/favorites/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM favorites WHERE user_id = ? AND question_id = ?").run(req.user.user_id, req.params.id);
  res.json({ ok: true });
});

// ---------- 錯題本 ----------
app.get("/api/wrong", requireAuth, (req, res) => {
  const { exam, source } = req.query;
  // answer_records 只會有已交卷或者刷題嘅正式作答，未交卷草稿存喺 exam_progress，唔會漏入錯題本
  let sql = "SELECT DISTINCT a.question_id FROM answer_records a JOIN questions q ON q.question_id = a.question_id WHERE a.user_id = ? AND a.is_correct = 0";
  const params = [req.user.user_id];
  if (exam) { sql += " AND q.exam = ?"; params.push(exam); }
  if (source && source !== "all") {
    if (source === "practice") { sql += " AND a.exam_id IS NULL"; }
    else if (String(source).startsWith("exam:")) { sql += " AND a.exam_id = ?"; params.push(Number(String(source).slice(5))); }
  }
  const ids = db.prepare(sql).all(...params).map((r) => r.question_id);
  if (ids.length === 0) return res.json({ questions: [], sources: [] });
  const ph = ids.map(() => "?").join(",");
  const qs = db.prepare("SELECT * FROM questions WHERE question_id IN (" + ph + ")").all(...ids);
  const srcRows = db.prepare("SELECT a.question_id, a.exam_id, e.title FROM answer_records a LEFT JOIN exam_records e ON e.exam_id = a.exam_id WHERE a.user_id = ? AND a.is_correct = 0").all(req.user.user_id);
  const byQ = {};
  for (const s of srcRows) {
    if (!byQ[s.question_id]) byQ[s.question_id] = { from_practice: false, sources: [] };
    if (s.exam_id == null) byQ[s.question_id].from_practice = true;
    else if (s.title && !byQ[s.question_id].sources.some((x) => x.exam_id === s.exam_id)) byQ[s.question_id].sources.push({ exam_id: s.exam_id, title: s.title });
  }
  const sources = [{ id: "all", title: "全部來源" }, { id: "practice", title: "自由刷題" }];
  const exams = db.prepare("SELECT exam_id, title FROM exam_records WHERE user_id = ? AND status = '已完成' ORDER BY exam_id DESC").all(req.user.user_id);
  for (const e of exams) sources.push({ id: "exam:" + e.exam_id, title: e.title });
  res.json({ questions: qs.map((r) => { const q = hideAnswer(rowToQuestion(r)); q.wrong_source = byQ[q.question_id] || { from_practice: false, sources: [] }; return q; }), sources });
});

// ---------- 模擬考 ----------
function examQuestionsFor(record) {
  const ids = safeJson(record.question_list, []);
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare("SELECT * FROM questions WHERE question_id IN (" + ph + ")").all(...ids);
  const byId = {};
  for (const r of rows) byId[r.question_id] = r;
  return ids.map((id) => byId[id]).filter(Boolean).map((r) => hideAnswer(rowToQuestion(r)));
}
// ---------- 模擬考組卷篩選（POST /api/exams 同 GET /api/exams/pool 共用） ----------
const EXAM_SOURCES = ["all", "unanswered", "answered", "wrong"];
function parseList(v) {
  if (Array.isArray(v)) return Array.from(new Set(v.map((x) => String(x).trim()).filter(Boolean)));
  if (typeof v === "string") return Array.from(new Set(v.split(",").map((s) => s.trim()).filter(Boolean)));
  return [];
}
function parseExamFilters(b) {
  const exams = parseList(b.exams);
  if (exams.length === 0 && typeof b.exam === "string" && b.exam.trim()) exams.push(b.exam.trim());
  const difficulties = parseList(b.difficulties);
  if (difficulties.length === 0 && typeof b.difficulty === "string" && b.difficulty.trim()) difficulties.push(b.difficulty.trim());
  const source = EXAM_SOURCES.includes(String(b.source || "")) ? String(b.source) : "all";
  return { exams, difficulties, source };
}
function poolQuery(userId, f) {
  let sql = "SELECT * FROM questions WHERE type != '簡答'";
  const params = [];
  if (f.exams.length > 0) { sql += " AND exam IN (" + f.exams.map(() => "?").join(",") + ")"; params.push(...f.exams); }
  if (f.difficulties.length > 0) { sql += " AND difficulty IN (" + f.difficulties.map(() => "?").join(",") + ")"; params.push(...f.difficulties); }
  if (f.source === "wrong") sql += " AND EXISTS (SELECT 1 FROM answer_records a WHERE a.question_id = questions.question_id AND a.user_id = ? AND a.is_correct = 0)";
  else if (f.source === "answered") sql += " AND EXISTS (SELECT 1 FROM answer_records a WHERE a.question_id = questions.question_id AND a.user_id = ?)";
  else if (f.source === "unanswered") sql += " AND NOT EXISTS (SELECT 1 FROM answer_records a WHERE a.question_id = questions.question_id AND a.user_id = ?)";
  if (f.source !== "all") params.push(userId);
  return { sql, params };
}
function poolEmptyMessage(f) {
  if (f.source === "wrong") return "錯題池暫時係空，請先做多啲題。";
  if (f.source === "unanswered") return "未做過嘅題暫時係空，呢個範圍嘅題你已經做晒。";
  if (f.source === "answered") return "做過嘅題暫時係空，請先做多啲題。";
  return "呢個考試暫時冇可組卷嘅題目，請先新增題目或者匯入題庫。";
}
// 按規則隨機抽題：每條規則係一個考試加題數，唔同規則之間唔重複，排除簡答題；
// 某條規則題池唔夠數就用晒並記低 note。模板開卷同按考試組卷共用。
function sampleByRules(userId, rules) {
  const notes = [];
  const picked = [];
  for (const rule of rules) {
    const rf = { exams: [String(rule.exam || "")], difficulties: Array.isArray(rule.difficulties) ? rule.difficulties : [], source: EXAM_SOURCES.includes(String(rule.source || "")) ? String(rule.source) : "all" };
    const { sql, params } = poolQuery(userId, rf);
    const pool = db.prepare(sql).all(...params).filter((r) => !picked.includes(r.question_id));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
    const want = Math.max(1, Math.min(100, Number(rule.count) || 0));
    const take = Math.min(want, pool.length);
    picked.push(...pool.slice(0, take).map((r) => r.question_id));
    if (take < want) notes.push(rf.exams[0] + " 得 " + pool.length + " 題，已用晒（想要 " + want + " 題）");
  }
  return { picked, notes };
}
app.post("/api/exams", requireAuth, (req, res) => {
  const b = req.body || {};
  const f = parseExamFilters(b);
  const title = String(b.title || "").trim();
  const count = Math.max(1, Math.min(100, Number(b.count) || 10));
  let ids = [];
  let note = null;
  let defaultTitle = (f.exams.length > 0 ? f.exams.join("、") : "綜合") + " 模擬卷";
  if (b.template_id != null && String(b.template_id) !== "") {
    // 模板模式：按模板每條規則隨機抽題，唔同規則之間唔重複，排除簡答題。
    const tid = Number(b.template_id);
    if (!Number.isInteger(tid)) return res.status(400).json({ error: "模板編號唔啱。" });
    const t = db.prepare("SELECT * FROM paper_templates WHERE template_id = ?").get(tid);
    if (!t) return res.status(404).json({ error: "搵唔到呢個模板。" });
    const rules = safeJson(t.config, []);
    if (!Array.isArray(rules) || rules.length === 0) return res.status(400).json({ error: "呢個模板冇有效規則。" });
    const tplSample = sampleByRules(req.user.user_id, rules);
    if (tplSample.picked.length === 0) return res.status(400).json({ error: "呢個模板加埋 0 題，請檢查模板規則或者先匯入題目。" });
    ids = tplSample.picked;
    if (tplSample.notes.length) note = tplSample.notes.join("；");
    defaultTitle = t.title + " 模擬卷";
  } else if (Array.isArray(b.rules)) {
    // 按考試組卷（即場組合）：每條規則係一個考試加題數，同模板一樣隨機抽題。
    if (b.rules.length === 0) return res.status(400).json({ error: "請至少剔選一個考試。" });
    const v = validateTemplateConfig(b.rules);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const rs = sampleByRules(req.user.user_id, v.rules);
    if (rs.picked.length === 0) return res.status(400).json({ error: "呢組規則加埋 0 題，請檢查考試或者先匯入題目。" });
    ids = rs.picked;
    if (rs.notes.length) note = rs.notes.join("；");
    defaultTitle = v.rules.map((r) => r.exam).join("、") + " 模擬卷";
  } else if (b.question_ids !== undefined) {
    // 手動模式：已選題目先驗證、去重、踢走簡答題，全部入卷；唔夠目標題數就由同一篩選隨機補齊。
    if (!Array.isArray(b.question_ids) || b.question_ids.length === 0) return res.status(400).json({ error: "手動組卷請先挑選至少一條題目。" });
    const wanted = Array.from(new Set(b.question_ids.map((x) => String(x).trim()).filter(Boolean)));
    if (wanted.length === 0) return res.status(400).json({ error: "手動組卷請先挑選至少一條題目。" });
    const rows = db.prepare("SELECT * FROM questions WHERE question_id IN (" + wanted.map(() => "?").join(",") + ")").all(...wanted);
    const byId = new Map(rows.map((r) => [r.question_id, r]));
    const missing = wanted.filter((id) => !byId.has(id));
    const shortIds = wanted.filter((id) => byId.has(id) && byId.get(id).type === "簡答");
    let picked = wanted.filter((id) => byId.has(id) && byId.get(id).type !== "簡答");
    const notes = [];
    if (missing.length) notes.push("搵唔到編號：" + missing.join("、") + "，已忽略");
    if (shortIds.length) notes.push("簡答題唔入模擬考，已踢走：" + shortIds.join("、"));
    if (picked.length === 0) return res.status(400).json({ error: "已選嘅題目全部無效（編號唔存在或者係簡答題）。" + (notes.length ? "（" + notes.join("；") + "）" : "") });
    if (count > picked.length) {
      const { sql, params } = poolQuery(req.user.user_id, f);
      const pool = db.prepare(sql).all(...params).filter((r) => !picked.includes(r.question_id));
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
      const fill = pool.slice(0, count - picked.length).map((r) => r.question_id);
      notes.push("已選 " + picked.length + " 題，隨機補齊 " + fill.length + " 題");
      picked = picked.concat(fill);
    } else {
      notes.push("已選 " + picked.length + " 題，目標題數 " + count + " 題，用晒已選題目");
    }
    ids = picked;
    if (notes.length) note = notes.join("；");
  } else {
    const { sql, params } = poolQuery(req.user.user_id, f);
    const pool = db.prepare(sql).all(...params);
    if (pool.length === 0) return res.status(400).json({ error: poolEmptyMessage(f) });
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
    if (pool.length < count) note = "符合條件得 " + pool.length + " 題，已用晒";
    ids = pool.slice(0, count).map((r) => r.question_id);
  }
  const finalTitle = title || defaultTitle;
  const info = db.prepare("INSERT INTO exam_records (user_id, title, question_list, score, total_questions, start_time, status) VALUES (?,?,?,?,?,?,?)").run(req.user.user_id, finalTitle, JSON.stringify(ids), null, ids.length, nowIso(), "進行中");
  res.json(Object.assign({ exam_id: info.lastInsertRowid, title: finalTitle, question_ids: ids, total_questions: ids.length }, note ? { note } : {}));
});
app.get("/api/exams", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM exam_records WHERE user_id = ? ORDER BY exam_id DESC").all(req.user.user_id);
  res.json({ exams: rows.map((r) => ({ exam_id: r.exam_id, title: r.title, question_list: safeJson(r.question_list, []), score: r.score, total_questions: r.total_questions, start_time: r.start_time, end_time: r.end_time, duration_sec: r.duration_sec, status: r.status })) });
});
// 題池數查詢：淨係回傳題數，唔回傳題目內容同答案，唔可以經呢個接口拎到答案。
// 注意：一定要放喺 /api/exams/:id 前面，否則 "pool" 會被當成考卷編號。
app.get("/api/exams/pool", requireAuth, (req, res) => {
  const f = parseExamFilters(req.query || {});
  const { sql, params } = poolQuery(req.user.user_id, f);
  const pool = db.prepare(sql).all(...params);
  res.json({ count: pool.length });
});

// ---------- 手動挑題列表 ----------
// 用返組卷篩選（多考試、多難度、來源）加關鍵字，淨係回傳挑題需要嘅欄位，
// 絕對唔含答案同解析；簡答題本身已經唔喺 poolQuery 入面，唔會出現喺度。
// 同樣要放喺 /api/exams/:id 前面。
app.get("/api/exams/pick", requireAuth, (req, res) => {
  const f = parseExamFilters(req.query || {});
  const q = String((req.query || {}).q || "").trim();
  const { sql, params } = poolQuery(req.user.user_id, f);
  let finalSql = sql;
  const finalParams = params.slice();
  if (q) { finalSql += " AND (content LIKE ? OR question_id LIKE ?)"; finalParams.push("%" + q + "%", "%" + q + "%"); }
  finalSql += " ORDER BY question_id";
  const all = db.prepare(finalSql).all(...finalParams);
  const shown = all.slice(0, 100).map((r) => ({ question_id: r.question_id, type: r.type, content: r.content, options: safeJson(r.options, []), exam: r.exam, difficulty: r.difficulty }));
  res.json({ total: all.length, questions: shown });
});

// ---------- 組卷模板 ----------
// config 係一組規則：[{exam, count, difficulties?, source?}]，difficulties 唔填即全部難度，source 唔填即 all。
function validateTemplateConfig(config) {
  if (!Array.isArray(config) || config.length === 0) return { ok: false, error: "模板至少要有一條規則。" };
  if (config.length > 20) return { ok: false, error: "模板最多 20 條規則。" };
  const rules = [];
  for (const r of config) {
    if (!r || typeof r !== "object") return { ok: false, error: "規則格式唔啱。" };
    const exam = String(r.exam || "").trim();
    if (!exam) return { ok: false, error: "每條規則都要填考試。" };
    if (exam.length > 50) return { ok: false, error: "考試名稱唔可以超過 50 個字。" };
    const count = Number(r.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) return { ok: false, error: "每條規則題數要係 1 至 100。" };
    const difficulties = Array.isArray(r.difficulties) ? r.difficulties.map((x) => String(x)).filter((x) => ["簡單", "中等", "困難"].includes(x)) : [];
    const source = EXAM_SOURCES.includes(String(r.source || "")) ? String(r.source) : "all";
    rules.push({ exam, count, difficulties, source });
  }
  return { ok: true, rules };
}
function templateSummary(rules) {
  return (Array.isArray(rules) ? rules : []).map((r) => r.exam + " " + r.count + " 題").join("、");
}
function publicTemplate(t) {
  const rules = safeJson(t.config, []);
  return { template_id: t.template_id, title: t.title, config: rules, summary: templateSummary(rules), created_by: t.created_by, created_by_name: t.created_by_name || "", created_at: t.created_at };
}
function getTemplateRow(id) {
  return db.prepare("SELECT t.*, u.username AS created_by_name FROM paper_templates t LEFT JOIN users u ON u.user_id = t.created_by WHERE t.template_id = ?").get(id);
}
// 模板係共用嘅：任何登入用戶都睇到、開卷用到；新增、修改、刪除只限管理員。
app.get("/api/templates", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT t.*, u.username AS created_by_name FROM paper_templates t LEFT JOIN users u ON u.user_id = t.created_by ORDER BY t.template_id").all();
  res.json({ templates: rows.map(publicTemplate) });
});
app.post("/api/templates", requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || "").trim();
  if (!title) return res.status(400).json({ error: "請填寫模板標題。" });
  if (title.length > 100) return res.status(400).json({ error: "標題唔可以超過 100 個字。" });
  const v = validateTemplateConfig(b.config);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const info = db.prepare("INSERT INTO paper_templates (title, config, created_by, created_at) VALUES (?,?,?,?)").run(title, JSON.stringify(v.rules), req.user.user_id, nowIso());
  res.json({ template: publicTemplate(getTemplateRow(info.lastInsertRowid)) });
});
app.put("/api/templates/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "模板編號唔啱。" });
  const old = getTemplateRow(id);
  if (!old) return res.status(404).json({ error: "搵唔到呢個模板。" });
  const b = req.body || {};
  const title = String(b.title || "").trim();
  if (!title) return res.status(400).json({ error: "請填寫模板標題。" });
  if (title.length > 100) return res.status(400).json({ error: "標題唔可以超過 100 個字。" });
  const v = validateTemplateConfig(b.config);
  if (!v.ok) return res.status(400).json({ error: v.error });
  db.prepare("UPDATE paper_templates SET title = ?, config = ? WHERE template_id = ?").run(title, JSON.stringify(v.rules), id);
  res.json({ template: publicTemplate(getTemplateRow(id)) });
});
app.delete("/api/templates/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "模板編號唔啱。" });
  const old = getTemplateRow(id);
  if (!old) return res.status(404).json({ error: "搵唔到呢個模板。" });
  db.prepare("DELETE FROM paper_templates WHERE template_id = ?").run(id);
  res.json({ ok: true });
});
app.get("/api/exams/:id", requireAuth, (req, res) => {
  const rec = db.prepare("SELECT * FROM exam_records WHERE exam_id = ? AND user_id = ?").get(req.params.id, req.user.user_id);
  if (!rec) return res.status(404).json({ error: "搵唔到呢份考卷。" });
  const prog = db.prepare("SELECT * FROM exam_progress WHERE exam_id = ?").get(req.params.id);
  const answers = prog ? safeJson(prog.answers, {}) : {};
  const marked = prog ? safeJson(prog.marked, []) : [];
  const questions = examQuestionsFor(rec);
  const firstUnanswered = questions.findIndex((q) => answers[q.question_id] == null || answers[q.question_id] === "");
  res.json({ exam: { exam_id: rec.exam_id, title: rec.title, score: rec.score, total_questions: rec.total_questions, start_time: rec.start_time, end_time: rec.end_time, status: rec.status }, questions, answers, marked, firstUnanswered });
});
app.post("/api/exams/:id/progress", requireAuth, (req, res) => {
  const rec = db.prepare("SELECT * FROM exam_records WHERE exam_id = ? AND user_id = ?").get(req.params.id, req.user.user_id);
  if (!rec) return res.status(404).json({ error: "搵唔到呢份考卷。" });
  if (rec.status !== "進行中") return res.status(400).json({ error: "呢份卷已經交咗，唔可以再改。" });
  const answers = req.body.answers && typeof req.body.answers === "object" ? req.body.answers : {};
  const marked = Array.isArray(req.body.marked) ? req.body.marked : [];
  db.prepare("INSERT INTO exam_progress (exam_id, answers, marked, updated_at) VALUES (?,?,?,?) ON CONFLICT(exam_id) DO UPDATE SET answers=excluded.answers, marked=excluded.marked, updated_at=excluded.updated_at").run(req.params.id, JSON.stringify(answers), JSON.stringify(marked), nowIso());
  res.json({ ok: true, saved_at: nowIso() });
});
app.post("/api/exams/:id/submit", requireAuth, (req, res) => {
  const rec = db.prepare("SELECT * FROM exam_records WHERE exam_id = ? AND user_id = ?").get(req.params.id, req.user.user_id);
  if (!rec) return res.status(404).json({ error: "搵唔到呢份考卷。" });
  if (rec.status === "已完成") return res.json({ ok: true, score: rec.score, total: rec.total_questions });
  const prog = db.prepare("SELECT * FROM exam_progress WHERE exam_id = ?").get(req.params.id);
  const answers = prog ? safeJson(prog.answers, {}) : {};
  const ids = safeJson(rec.question_list, []);
  let score = 0;
  const now = nowIso();
  const start = new Date(rec.start_time).getTime();
  const duration = Math.max(0, Math.round((new Date(now).getTime() - start) / 1000));
  const ins = db.prepare("INSERT INTO answer_records (exam_id, user_id, question_id, user_answer, is_correct, answer_time) VALUES (?,?,?,?,?,?)");
  for (const qid of ids) {
    const r = db.prepare("SELECT * FROM questions WHERE question_id = ?").get(qid);
    if (!r) continue;
    const q = rowToQuestion(r);
    const ua = String(answers[qid] == null ? "" : answers[qid]);
    const correct = gradeAnswer(q, ua);
    if (correct) score++;
    ins.run(req.params.id, req.user.user_id, qid, ua, correct ? 1 : 0, now);
  }
  db.prepare("UPDATE exam_records SET score = ?, end_time = ?, duration_sec = ?, status = '已完成' WHERE exam_id = ?").run(score, now, duration, req.params.id);
  db.prepare("DELETE FROM exam_progress WHERE exam_id = ?").run(req.params.id);
  res.json({ ok: true, score, total: ids.length, duration_sec: duration });
});
app.get("/api/exams/:id/report", requireAuth, (req, res) => {
  const rec = db.prepare("SELECT * FROM exam_records WHERE exam_id = ? AND user_id = ?").get(req.params.id, req.user.user_id);
  if (!rec) return res.status(404).json({ error: "搵唔到呢份考卷。" });
  const ans = db.prepare("SELECT * FROM answer_records WHERE exam_id = ? AND user_id = ?").all(req.params.id, req.user.user_id);
  const byQ = {};
  for (const a of ans) byQ[a.question_id] = a;
  const ids = safeJson(rec.question_list, []);
  const items = ids.map((qid) => {
    const r = db.prepare("SELECT * FROM questions WHERE question_id = ?").get(qid);
    const a = byQ[qid];
    // 題目已經喺題庫刪除：唔好成項消失，要顯示「題目已刪除」，分數同總題數維持不變
    if (!r) return { deleted: true, question_id: qid, user_answer: a ? a.user_answer : "", is_correct: a ? !!a.is_correct : false };
    const q = rowToQuestion(r);
    return { question: q, user_answer: a ? a.user_answer : "", is_correct: a ? !!a.is_correct : false };
  });
  res.json({ exam: { exam_id: rec.exam_id, title: rec.title, score: rec.score, total_questions: rec.total_questions, duration_sec: rec.duration_sec, start_time: rec.start_time, end_time: rec.end_time }, items });
});
app.delete("/api/exams/:id", requireAuth, (req, res) => {
  const rec = db.prepare("SELECT * FROM exam_records WHERE exam_id = ? AND user_id = ?").get(req.params.id, req.user.user_id);
  if (!rec) return res.status(404).json({ error: "搵唔到呢份考卷。" });
  db.prepare("DELETE FROM answer_records WHERE exam_id = ? AND user_id = ?").run(req.params.id, req.user.user_id);
  db.prepare("DELETE FROM exam_progress WHERE exam_id = ?").run(req.params.id);
  db.prepare("DELETE FROM exam_records WHERE exam_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- 留言 ----------
app.get("/api/comments", requireAuth, (req, res) => {
  const qid = req.query.question_id;
  let rows;
  if (qid) rows = db.prepare("SELECT c.*, u.username FROM comments c JOIN users u ON u.user_id = c.user_id WHERE c.is_deleted = 0 AND c.question_id = ? ORDER BY c.comment_id DESC").all(qid);
  else rows = db.prepare("SELECT c.*, u.username FROM comments c JOIN users u ON u.user_id = c.user_id WHERE c.is_deleted = 0 AND (c.question_id IS NULL OR c.question_id = '') ORDER BY c.comment_id DESC").all();
  res.json({ comments: rows.map((r) => ({ comment_id: r.comment_id, user_id: r.user_id, username: r.username, question_id: r.question_id, content: r.content, created_at: r.created_at })) });
});
app.get("/api/comments/question/:id", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT c.*, u.username FROM comments c JOIN users u ON u.user_id = c.user_id WHERE c.is_deleted = 0 AND c.question_id = ? ORDER BY c.comment_id DESC").all(req.params.id);
  res.json({ comments: rows.map((r) => ({ comment_id: r.comment_id, user_id: r.user_id, username: r.username, question_id: r.question_id, content: r.content, created_at: r.created_at })) });
});
app.post("/api/comments", requireAuth, (req, res) => {
  const content = String(req.body.content || "").trim();
  if (!content) return res.status(400).json({ error: "請填寫留言內容。" });
  const qid = req.body.question_id ? String(req.body.question_id) : null;
  const info = db.prepare("INSERT INTO comments (user_id, question_id, content, created_at, is_deleted) VALUES (?,?,?,?,0)").run(req.user.user_id, qid, content, nowIso());
  res.json({ comment_id: info.lastInsertRowid });
});
app.delete("/api/comments/:id", requireAuth, (req, res) => {
  const c = db.prepare("SELECT * FROM comments WHERE comment_id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "搵唔到呢則留言。" });
  if (req.user.role !== "admin" && c.user_id !== req.user.user_id) return res.status(403).json({ error: "只有管理員或者留言本人先可以刪除。" });
  db.prepare("UPDATE comments SET is_deleted = 1 WHERE comment_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- 統計 ----------
app.get("/api/stats/me", requireAuth, (req, res) => {
  const total = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(is_correct),0) AS c FROM answer_records WHERE user_id = ?").get(req.user.user_id);
  const wrong = db.prepare("SELECT COUNT(DISTINCT question_id) AS n FROM answer_records WHERE user_id = ? AND is_correct = 0").get(req.user.user_id).n;
  const done = db.prepare("SELECT COUNT(*) AS n FROM exam_records WHERE user_id = ? AND status = '已完成'").get(req.user.user_id).n;
  const perExam = db.prepare("SELECT q.exam AS exam, COUNT(*) AS total, COALESCE(SUM(a.is_correct),0) AS correct FROM answer_records a JOIN questions q ON q.question_id = a.question_id WHERE a.user_id = ? GROUP BY q.exam ORDER BY q.exam").all(req.user.user_id);
  const trend = db.prepare("SELECT exam_id, title, score, total_questions, end_time FROM exam_records WHERE user_id = ? AND status = '已完成' ORDER BY end_time").all(req.user.user_id);
  res.json({ total: total.n, correct: total.c, accuracy: total.n ? Math.round((total.c / total.n) * 100) : 0, wrong, examsDone: done, perExam, trend });
});
app.get("/api/stats/admin", requireAuth, requireAdmin, (req, res) => {
  const qTotal = db.prepare("SELECT COUNT(*) AS n FROM questions").get().n;
  const uTotal = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const cTotal = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE is_deleted = 0").get().n;
  const byType = db.prepare("SELECT type, COUNT(*) AS n FROM questions GROUP BY type ORDER BY type").all();
  const byDiff = db.prepare("SELECT difficulty, COUNT(*) AS n FROM questions GROUP BY difficulty ORDER BY difficulty").all();
  const byExam = db.prepare("SELECT exam, COUNT(*) AS n FROM questions GROUP BY exam ORDER BY exam").all();
  res.json({ questions: qTotal, users: uTotal, comments: cTotal, byType, byDifficulty: byDiff, byExam });
});

// ---------- 學生表現分析（管理員） ----------
// 全部用 SQL 聚合現有表，唔加表、唔改欄位。
// 註：answer_records.is_correct 欄位係 INTEGER NOT NULL DEFAULT 0，唔會有 NULL；
// 簡答題喺刷題係學生自評（self_correct ? 1 : 0），模擬考組卷本身唔包簡答。
// 為穩陣起見，聚合時仍加 is_correct IS NOT NULL 條件。
// 可選 ?user_id=N：只回傳該學生詳情（各考試正確率、最近 5 份模擬考、錯得最多 5 題）。
app.get("/api/admin/analytics", requireAuth, requireAdmin, (req, res) => {
  const uid = req.query.user_id ? Number(req.query.user_id) : null;
  if (uid != null && !Number.isNaN(uid)) {
    const u = db.prepare("SELECT user_id, username, role, created_at FROM users WHERE user_id = ?").get(uid);
    if (!u) return res.status(404).json({ error: "搵唔到呢個帳號。" });
    const perExam = db.prepare("SELECT q.exam AS exam, COUNT(*) AS total, COALESCE(SUM(a.is_correct),0) AS correct FROM answer_records a JOIN questions q ON q.question_id = a.question_id WHERE a.user_id = ? AND a.is_correct IS NOT NULL GROUP BY q.exam ORDER BY q.exam").all(uid)
      .map((x) => ({ exam: x.exam, total: x.total, correct: x.correct, accuracy: x.total ? Math.round((x.correct / x.total) * 100) : null }));
    const recent = db.prepare("SELECT exam_id, title, score, total_questions, end_time FROM exam_records WHERE user_id = ? AND status = '已完成' ORDER BY end_time DESC LIMIT 5").all(uid);
    const topMissed = db.prepare("SELECT q.question_id AS question_id, q.content AS content, q.exam AS exam, q.type AS type, COUNT(*) AS total, SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) AS wrong FROM answer_records a JOIN questions q ON q.question_id = a.question_id WHERE a.user_id = ? AND a.is_correct IS NOT NULL GROUP BY q.question_id HAVING SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) > 0 ORDER BY wrong DESC, total DESC LIMIT 5").all(uid)
      .map((x) => ({ question_id: x.question_id, content: x.content, exam: x.exam, type: x.type, total: x.total, wrong: x.wrong }));
    return res.json({ studentDetail: { user_id: u.user_id, username: u.username, role: u.role, created_at: u.created_at, perExam, recentExams: recent, topMissed } });
  }

  const users = db.prepare("SELECT user_id, username, role, created_at FROM users ORDER BY user_id").all();
  const ansByUser = new Map(db.prepare("SELECT user_id, COUNT(*) AS n, COALESCE(SUM(is_correct),0) AS c FROM answer_records WHERE is_correct IS NOT NULL GROUP BY user_id").all().map((r) => [r.user_id, r]));
  const exByUser = new Map(db.prepare("SELECT user_id, COUNT(*) AS done, AVG(score * 1.0 / total_questions) * 100 AS avgPct FROM exam_records WHERE status = '已完成' AND total_questions > 0 GROUP BY user_id").all().map((r) => [r.user_id, r]));
  const lastByUser = new Map(db.prepare("SELECT user_id, MAX(answer_time) AS t FROM answer_records GROUP BY user_id").all().map((r) => [r.user_id, r.t]));
  const perUserExam = db.prepare("SELECT a.user_id AS user_id, q.exam AS exam, COUNT(*) AS total, COALESCE(SUM(a.is_correct),0) AS correct FROM answer_records a JOIN questions q ON q.question_id = a.question_id WHERE a.is_correct IS NOT NULL GROUP BY a.user_id, q.exam").all();
  const weakestByUser = new Map();
  for (const r of perUserExam) {
    if (r.total < 3) continue;
    const acc = Math.round((r.correct / r.total) * 100);
    const cur = weakestByUser.get(r.user_id);
    if (!cur || acc < cur.accuracy || (acc === cur.accuracy && r.total > cur.total)) weakestByUser.set(r.user_id, { exam: r.exam, accuracy: acc, total: r.total });
  }
  const perStudent = users.map((u) => {
    const a = ansByUser.get(u.user_id) || { n: 0, c: 0 };
    const e = exByUser.get(u.user_id) || { done: 0, avgPct: null };
    return {
      user_id: u.user_id, username: u.username, role: u.role, created_at: u.created_at,
      answers: a.n, correct: a.c, accuracy: a.n ? Math.round((a.c / a.n) * 100) : null,
      examsDone: e.done, avgScore: e.avgPct == null ? null : Math.round(e.avgPct),
      lastActive: lastByUser.get(u.user_id) || u.created_at,
      weakestExam: weakestByUser.get(u.user_id) || null,
    };
  });

  function groupAccuracy(groupCol) {
    return db.prepare("SELECT q." + groupCol + " AS k, COUNT(*) AS total, COALESCE(SUM(a.is_correct),0) AS correct FROM answer_records a JOIN questions q ON q.question_id = a.question_id WHERE a.is_correct IS NOT NULL GROUP BY q." + groupCol + " ORDER BY k").all()
      .map((x) => ({ label: x.k, total: x.total, correct: x.correct, accuracy: x.total ? Math.round((x.correct / x.total) * 100) : null }))
      .sort((x, y) => (x.accuracy == null ? 101 : x.accuracy) - (y.accuracy == null ? 101 : y.accuracy));
  }
  const weakByExam = groupAccuracy("exam");
  const weakByType = groupAccuracy("type");
  const weakByDifficulty = groupAccuracy("difficulty");

  const mostMissed = db.prepare("SELECT q.question_id AS question_id, q.content AS content, q.exam AS exam, q.type AS type, q.difficulty AS difficulty, COUNT(*) AS total, SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) AS wrong FROM answer_records a JOIN questions q ON q.question_id = a.question_id WHERE a.is_correct IS NOT NULL GROUP BY q.question_id HAVING SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) > 0 ORDER BY wrong * 1.0 / total DESC, wrong DESC LIMIT 20").all()
    .map((x) => ({ question_id: x.question_id, content: x.content, exam: x.exam, type: x.type, difficulty: x.difficulty, total: x.total, wrong: x.wrong, missRate: x.total ? Math.round((x.wrong / x.total) * 100) : 0 }));

  const recentExams = db.prepare("SELECT e.exam_id AS exam_id, e.title AS title, e.score AS score, e.total_questions AS total_questions, e.end_time AS end_time, u.username AS username FROM exam_records e JOIN users u ON u.user_id = e.user_id WHERE e.status = '已完成' ORDER BY e.end_time DESC LIMIT 10").all();

  res.json({ perStudent, weakByExam, weakByType, weakByDifficulty, mostMissed, recentExams });
});

// ---------- 匯出備份同還原（管理員） ----------
function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function sendCsvDownload(res, filename, csvText) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="' + filename + '"');
  res.send("\ufeff" + csvText);
}
// 匯出題目 CSV：格式同匯入範本一樣，支援同題庫列表一樣嘅篩選
app.get("/api/admin/export/questions", requireAuth, requireAdmin, (req, res) => {
  const { exam, difficulty, type, q } = req.query;
  let sql = "SELECT * FROM questions WHERE 1=1";
  const params = [];
  if (exam) { sql += " AND exam = ?"; params.push(exam); }
  if (difficulty) { sql += " AND difficulty = ?"; params.push(difficulty); }
  if (type) { sql += " AND type = ?"; params.push(type); }
  if (q) { sql += " AND (content LIKE ? OR question_id LIKE ?)"; params.push("%" + q + "%", "%" + q + "%"); }
  sql += " ORDER BY question_id";
  const rows = db.prepare(sql).all(...params);
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push([r.question_id, r.type, r.content, safeJson(r.options, []).join("|"), r.answer, r.explanation, r.exam, r.difficulty, mediaCellForCsv(r.media)].map(csvEscape).join(","));
  }
  sendCsvDownload(res, "questions-" + dateStamp() + ".csv", lines.join("\n"));
});
// 匯出學生帳號 CSV：絕對唔包含密碼雜湊
app.get("/api/admin/export/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare("SELECT user_id, username, role, created_at FROM users ORDER BY user_id").all();
  const lines = [["username", "role", "created_at", "answers", "accuracy"].join(",")];
  for (const u of users) {
    const t = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(is_correct),0) AS c FROM answer_records WHERE user_id = ?").get(u.user_id);
    const acc = t.n ? Math.round((t.c / t.n) * 100) : 0;
    lines.push([u.username, u.role, u.created_at, t.n, acc + "%"].map(csvEscape).join(","));
  }
  sendCsvDownload(res, "users-" + dateStamp() + ".csv", lines.join("\n"));
});
// 成站備份 JSON：包晒全部表。users 包含 password_hash，先至還原到帳號密碼不變，
// 所以呢個檔案係敏感資料，唔可以公開分享，要妥善保存。
app.get("/api/admin/backup", requireAuth, requireAdmin, (req, res) => {
  const backup = {
    app: "exam-system-standalone",
    version: 1,
    exported_at: nowIso(),
    questions: db.prepare("SELECT * FROM questions ORDER BY question_id").all(),
    users: db.prepare("SELECT * FROM users ORDER BY user_id").all(),
    exam_records: db.prepare("SELECT * FROM exam_records ORDER BY exam_id").all(),
    answer_records: db.prepare("SELECT * FROM answer_records ORDER BY record_id").all(),
    comments: db.prepare("SELECT * FROM comments ORDER BY comment_id").all(),
    favorites: db.prepare("SELECT * FROM favorites ORDER BY favorite_id").all(),
    sessions: db.prepare("SELECT * FROM sessions ORDER BY created_at").all(),
    exam_progress: db.prepare("SELECT * FROM exam_progress ORDER BY exam_id").all(),
  };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="exam-backup-' + dateStamp() + '.json"');
  res.send(JSON.stringify(backup, null, 2));
});
// 還原備份 JSON：合併方式（upsert），唔會清空現有資料；
// 任何一步出錯成個交易 rollback，唔會還原一半。
app.post("/api/admin/restore", requireAuth, requireAdmin, (req, res) => {
  const b = req.body && req.body.backup ? req.body.backup : req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) return res.status(400).json({ error: "備份檔案格式唔啱，請上載由呢個系統匯出嘅備份 JSON。" });
  const tables = ["questions", "users", "exam_records", "answer_records", "comments", "favorites", "sessions", "exam_progress"];
  for (const t of tables) {
    if (b[t] != null && !Array.isArray(b[t])) return res.status(400).json({ error: "備份檔案入面 " + t + " 唔係列表格式。" });
  }
  const result = {};
  const count = (name) => { if (!result[name]) result[name] = { inserted: 0, updated: 0, skipped: 0 }; return result[name]; };
  try {
    withTx(() => {
      // 題目：按 question_id upsert
      for (const q of b.questions || []) {
        const c = count("questions");
        if (!q || typeof q !== "object" || !q.question_id || !q.type || !q.content || q.answer == null) { c.skipped++; continue; }
        const exists = db.prepare("SELECT 1 FROM questions WHERE question_id = ?").get(q.question_id);
        db.prepare("INSERT INTO questions (question_id,type,content,options,answer,explanation,exam,difficulty,media,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(question_id) DO UPDATE SET type=excluded.type, content=excluded.content, options=excluded.options, answer=excluded.answer, explanation=excluded.explanation, exam=excluded.exam, difficulty=excluded.difficulty, media=excluded.media")
          .run(q.question_id, q.type, q.content, typeof q.options === "string" ? q.options : JSON.stringify(q.options || []), q.answer, q.explanation || "", q.exam || "", q.difficulty || "中等", mediaJson(q.media), q.created_at || nowIso());
        if (exists) c.updated++; else c.inserted++;
      }
      // 帳號：先按 user_id，再按 username；保留原有 user_id，先至唔會斷咗成績紀錄嘅關聯
      for (const u of b.users || []) {
        const c = count("users");
        if (!u || typeof u !== "object" || !u.username || !u.password_hash) { c.skipped++; continue; }
        const role = u.role === "admin" ? "admin" : "user";
        const byId = u.user_id != null ? db.prepare("SELECT * FROM users WHERE user_id = ?").get(u.user_id) : null;
        const byName = db.prepare("SELECT * FROM users WHERE username = ?").get(u.username);
        if (byId) {
          if (byName && byName.user_id !== byId.user_id) { c.skipped++; continue; }
          db.prepare("UPDATE users SET username = ?, password_hash = ?, role = ?, created_at = ? WHERE user_id = ?").run(u.username, u.password_hash, role, u.created_at || nowIso(), u.user_id);
          c.updated++;
        } else if (byName) {
          db.prepare("UPDATE users SET password_hash = ?, role = ?, created_at = ? WHERE user_id = ?").run(u.password_hash, role, u.created_at || byName.created_at, byName.user_id);
          c.updated++;
        } else if (u.user_id != null) {
          db.prepare("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)").run(u.user_id, u.username, u.password_hash, role, u.created_at || nowIso());
          c.inserted++;
        } else {
          db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)").run(u.username, u.password_hash, role, u.created_at || nowIso());
          c.inserted++;
        }
      }
      // 考卷紀錄：按 exam_id upsert
      for (const e of b.exam_records || []) {
        const c = count("exam_records");
        if (!e || typeof e !== "object" || e.exam_id == null || e.user_id == null || !e.title) { c.skipped++; continue; }
        const exists = db.prepare("SELECT 1 FROM exam_records WHERE exam_id = ?").get(e.exam_id);
        db.prepare("INSERT INTO exam_records (exam_id,user_id,title,question_list,score,total_questions,start_time,end_time,duration_sec,status) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(exam_id) DO UPDATE SET user_id=excluded.user_id, title=excluded.title, question_list=excluded.question_list, score=excluded.score, total_questions=excluded.total_questions, start_time=excluded.start_time, end_time=excluded.end_time, duration_sec=excluded.duration_sec, status=excluded.status")
          .run(e.exam_id, e.user_id, e.title, typeof e.question_list === "string" ? e.question_list : JSON.stringify(e.question_list || []), e.score == null ? null : e.score, e.total_questions || 0, e.start_time || nowIso(), e.end_time || null, e.duration_sec == null ? null : e.duration_sec, e.status || "已完成");
        if (exists) c.updated++; else c.inserted++;
      }
      // 答題紀錄：按 record_id upsert
      for (const a of b.answer_records || []) {
        const c = count("answer_records");
        if (!a || typeof a !== "object" || a.record_id == null || a.user_id == null || !a.question_id) { c.skipped++; continue; }
        const exists = db.prepare("SELECT 1 FROM answer_records WHERE record_id = ?").get(a.record_id);
        db.prepare("INSERT INTO answer_records (record_id,exam_id,user_id,question_id,user_answer,is_correct,answer_time) VALUES (?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET exam_id=excluded.exam_id, user_id=excluded.user_id, question_id=excluded.question_id, user_answer=excluded.user_answer, is_correct=excluded.is_correct, answer_time=excluded.answer_time")
          .run(a.record_id, a.exam_id == null ? null : a.exam_id, a.user_id, a.question_id, a.user_answer == null ? "" : a.user_answer, a.is_correct ? 1 : 0, a.answer_time || nowIso());
        if (exists) c.updated++; else c.inserted++;
      }
      // 留言：按 comment_id upsert
      for (const cm of b.comments || []) {
        const c = count("comments");
        if (!cm || typeof cm !== "object" || cm.comment_id == null || cm.user_id == null || cm.content == null) { c.skipped++; continue; }
        const exists = db.prepare("SELECT 1 FROM comments WHERE comment_id = ?").get(cm.comment_id);
        db.prepare("INSERT INTO comments (comment_id,user_id,question_id,content,created_at,is_deleted) VALUES (?,?,?,?,?,?) ON CONFLICT(comment_id) DO UPDATE SET user_id=excluded.user_id, question_id=excluded.question_id, content=excluded.content, created_at=excluded.created_at, is_deleted=excluded.is_deleted")
          .run(cm.comment_id, cm.user_id, cm.question_id == null ? null : cm.question_id, cm.content, cm.created_at || nowIso(), cm.is_deleted ? 1 : 0);
        if (exists) c.updated++; else c.inserted++;
      }
      // 收藏：按 favorite_id upsert（同一人同一題只可以收藏一次，衝突就跳過）
      for (const f of b.favorites || []) {
        const c = count("favorites");
        if (!f || typeof f !== "object" || f.user_id == null || !f.question_id) { c.skipped++; continue; }
        if (f.favorite_id != null) {
          const exists = db.prepare("SELECT 1 FROM favorites WHERE favorite_id = ?").get(f.favorite_id);
          if (exists) {
            db.prepare("UPDATE favorites SET user_id = ?, question_id = ?, created_at = ? WHERE favorite_id = ?").run(f.user_id, f.question_id, f.created_at || nowIso(), f.favorite_id);
            c.updated++;
          } else {
            const r = db.prepare("INSERT OR IGNORE INTO favorites (favorite_id,user_id,question_id,created_at) VALUES (?,?,?,?)").run(f.favorite_id, f.user_id, f.question_id, f.created_at || nowIso());
            if (r.changes) c.inserted++; else c.skipped++;
          }
        } else {
          const r = db.prepare("INSERT OR IGNORE INTO favorites (user_id,question_id,created_at) VALUES (?,?,?)").run(f.user_id, f.question_id, f.created_at || nowIso());
          if (r.changes) c.inserted++; else c.skipped++;
        }
      }
      // 登入狀態：按 session_id upsert；已經過期（30 日）嘅就跳過唔還原
      for (const s of b.sessions || []) {
        const c = count("sessions");
        if (!s || typeof s !== "object" || !s.session_id || s.user_id == null) { c.skipped++; continue; }
        const created = new Date(s.created_at || "").getTime();
        if (!isNaN(created) && Date.now() - created > SESSION_MAX_AGE_MS) { c.skipped++; continue; }
        const exists = db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(s.session_id);
        db.prepare("INSERT INTO sessions (session_id,user_id,created_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET user_id=excluded.user_id, created_at=excluded.created_at").run(s.session_id, s.user_id, s.created_at || nowIso());
        if (exists) c.updated++; else c.inserted++;
      }
      // 模擬考草稿：按 exam_id upsert
      for (const p of b.exam_progress || []) {
        const c = count("exam_progress");
        if (!p || typeof p !== "object" || p.exam_id == null) { c.skipped++; continue; }
        const exists = db.prepare("SELECT 1 FROM exam_progress WHERE exam_id = ?").get(p.exam_id);
        db.prepare("INSERT INTO exam_progress (exam_id,answers,marked,updated_at) VALUES (?,?,?,?) ON CONFLICT(exam_id) DO UPDATE SET answers=excluded.answers, marked=excluded.marked, updated_at=excluded.updated_at")
          .run(p.exam_id, typeof p.answers === "string" ? p.answers : JSON.stringify(p.answers || {}), typeof p.marked === "string" ? p.marked : JSON.stringify(p.marked || []), p.updated_at || nowIso());
        if (exists) c.updated++; else c.inserted++;
      }
    });
  } catch (e) {
    return res.status(400).json({ error: "還原失敗，已經全部取消，現有資料冇郁過：" + e.message });
  }
  res.json({ ok: true, result });
});

// ---------- 兜底 ----------
app.use((req, res) => {
  if (String(req.path || "").startsWith("/api/")) return res.status(404).json({ error: "搵唔到呢個接口。" });
  res.sendFile(path.join(ROOT, "public", "index.html"));
});
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "伺服器出錯，請稍後再試。" });
});

app.listen(PORT, () => {
  console.log("考試系統獨立版已啟動：http://localhost:" + PORT);
  console.log("首次開啟請先建立管理員帳號，之後考生可以自行註冊。");
});

