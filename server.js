// 考試系統 — 獨立版伺服器
// Node.js + Express + SQLite（Node 內置 node:sqlite，唔使裝原生模組）
// 啟動：npm install 之後 npm start，預設 http://localhost:3000
// 首次開啟先建立管理員帳號，之後考生自行註冊。登入狀態存資料庫 sessions 表。
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

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

fs.mkdirSync(DATA_DIR, { recursive: true });

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
`);

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
  return { question_id: r.question_id, type: r.type, content: r.content, options: safeJson(r.options, []), answer: r.answer, explanation: r.explanation, exam: r.exam, difficulty: r.difficulty, created_at: r.created_at };
}
function hideAnswer(q) {
  if (!q) return null;
  const c = Object.assign({}, q);
  delete c.answer;
  return c;
}

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
const CSV_HEADERS = ["question_id", "type", "content", "options", "answer", "explanation", "exam", "difficulty"];
function csvTemplate() {
  const rows = [
    ["DEMO-001", "單選", "避碰規則：兩船對遇時，邊一邊應該讓路？", "左舷讓路|右舷讓路|直航船讓路|兩船同時轉向", "A", "對遇局面，兩船都應該向右轉，互相從左舷通過。", "VTS", "簡單"],
    ["DEMO-002", "多選", "以下邊啲屬於 VTS 服務範圍？", "船舶交通組織|助航服務|危險品監控|天氣預報", "ABC", "VTS 提供交通組織、助航同危險品監控，天氣預報唔係 VTS 本身服務。", "VTS", "中等"],
    ["DEMO-003", "判斷", "追越船必須讓路給被追越船。", "正確|錯誤", "正確", "追越船係讓路船，必須避讓被追越船。", "VTS", "簡單"],
    ["DEMO-004", "簡答", "請簡述 VHF 第 16 頻道嘅用途。", "", "第 16 頻道係國際遇險、緊急同呼叫頻道，用於遇險求救同建立聯絡，聯絡好之後要轉去工作頻道通話，唔好長期佔用。", "第 16 頻道係國際遇險、緊急同呼叫頻道，用於遇險求救同建立聯絡，聯絡好之後要轉去工作頻道通話，唔好長期佔用。", "VTS", "中等"],
  ];
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  return lines.join("\n");
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
  if (type !== "簡答") {
    const v = validateAnswer(type, options, answer);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, q: { question_id: qid, type, content, options, answer: v.normalized, explanation, exam, difficulty } };
  }
  return { ok: true, q: { question_id: qid, type, content, options, answer, explanation, exam, difficulty } };
}
function saveQuestion(q) {
  const now = nowIso();
  db.prepare("INSERT INTO questions (question_id,type,content,options,answer,explanation,exam,difficulty,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(question_id) DO UPDATE SET type=excluded.type, content=excluded.content, options=excluded.options, answer=excluded.answer, explanation=excluded.explanation, exam=excluded.exam, difficulty=excluded.difficulty").run(q.question_id, q.type, q.content, JSON.stringify(q.options), q.answer, q.explanation, q.exam, q.difficulty, now);
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, "public")));

// ---------- 認證 ----------
function getSessionUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : (req.headers["x-session"] || "");
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(token);
  if (!s) return null;
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
  if (password.length < 4) return res.status(400).json({ error: "密碼至少要 4 個字。" });
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
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!u || !verifyPassword(password, u.password_hash)) return res.status(401).json({ error: "帳號或者密碼唔啱。" });
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
  if (newPw.length < 4) return res.status(400).json({ error: "新密碼至少要 4 個字。" });
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
  res.json({ questions: rows.map(rowToQuestion) });
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
app.get("/api/questions/:id", requireAuth, (req, res) => {
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
  const v = validateQuestionInput(body, false);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const exists = db.prepare("SELECT 1 FROM questions WHERE question_id = ?").get(req.params.id);
  if (!exists) return res.status(404).json({ error: "搵唔到呢條題目。" });
  saveQuestion(v.q);
  res.json({ question: v.q });
});
app.delete("/api/questions/:id", requireAuth, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM questions WHERE question_id = ?").run(req.params.id);
  db.prepare("DELETE FROM favorites WHERE question_id = ?").run(req.params.id);
  res.json({ ok: true });
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
    };
    if (!raw.question_id) { errors.push("第 " + lineNo + " 行：缺少編號 question_id。"); continue; }
    if (seenInFile.has(raw.question_id)) { errors.push("第 " + lineNo + " 行：編號 " + raw.question_id + " 喺檔案內重複咗。"); continue; }
    seenInFile.add(raw.question_id);
    const v = validateQuestionInput(raw, true);
    if (!v.ok) { errors.push("第 " + lineNo + " 行（" + raw.question_id + "）：" + v.error); continue; }
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
app.post("/api/exams", requireAuth, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || "").trim() || ((b.exam || "模擬考") + " 模擬卷");
  const count = Math.max(1, Math.min(100, Number(b.count) || 10));
  let ids = [];
  if (Array.isArray(b.question_ids) && b.question_ids.length > 0) {
    ids = b.question_ids.map(String);
  } else {
    let sql = "SELECT * FROM questions WHERE type != '簡答'";
    const params = [];
    if (b.exam) { sql += " AND exam = ?"; params.push(b.exam); }
    const pool = db.prepare(sql).all(...params);
    if (pool.length === 0) return res.status(400).json({ error: "呢個考試暫時冇可組卷嘅題目，請先新增題目或者匯入題庫。" });
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    ids = pool.slice(0, count).map((r) => r.question_id);
  }
  const info = db.prepare("INSERT INTO exam_records (user_id, title, question_list, score, total_questions, start_time, status) VALUES (?,?,?,?,?,?,?)").run(req.user.user_id, title, JSON.stringify(ids), null, ids.length, nowIso(), "進行中");
  res.json({ exam_id: info.lastInsertRowid, title, question_ids: ids, total_questions: ids.length });
});
app.get("/api/exams", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM exam_records WHERE user_id = ? ORDER BY exam_id DESC").all(req.user.user_id);
  res.json({ exams: rows.map((r) => ({ exam_id: r.exam_id, title: r.title, question_list: safeJson(r.question_list, []), score: r.score, total_questions: r.total_questions, start_time: r.start_time, end_time: r.end_time, duration_sec: r.duration_sec, status: r.status })) });
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
    if (!r) return null;
    const q = rowToQuestion(r);
    const a = byQ[qid];
    return { question: q, user_answer: a ? a.user_answer : "", is_correct: a ? !!a.is_correct : false };
  }).filter(Boolean);
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
