// 考試系統 — 獨立版前端（原生 JS，唔使 build）
// 登入狀態同主題嘅儲存存取全部經安全封裝，瀏覽器封鎖儲存都唔會白屏。
"use strict";

// ---------- 安全儲存：try/catch 加記憶體後備 ----------
const memStore = {};
const storage = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { memStore[k] = v; } },
  remove(k) { try { window.localStorage.removeItem(k); } catch (e) { delete memStore[k]; } },
};
function clearLocalState() {
  try { window.localStorage.removeItem("exam_token"); window.localStorage.removeItem("exam_user"); window.localStorage.removeItem("exam_theme"); } catch (e) {}
  delete memStore.exam_token; delete memStore.exam_user; delete memStore.exam_theme;
}

// ---------- 錯誤邊界 ----------
window.addEventListener("error", (ev) => { showErrorPage(String((ev && ev.error && ev.error.message) || "頁面載入時出現未知錯誤。")); });
function showErrorPage(msg) {
  const app = document.getElementById("app");
  if (!app || app.dataset.errorShown) return;
  app.dataset.errorShown = "1";
  app.innerHTML = '<div class="errbox"><h2>頁面載入出錯</h2><p class="muted">呢部裝置儲存嘅登入狀態可能已經損壞，令頁面開唔到。你嘅帳號、題目同紀錄都喺伺服器嗰邊，唔會受影響。</p><p class="muted">' + esc(msg) + '</p><p><button class="primary" id="errClear">清除登入狀態並重新載入</button></p><p><button id="errReload">重新整理成個頁面</button></p></div>';
  document.getElementById("errClear").addEventListener("click", () => {
    clearLocalState();
    delete app.dataset.errorShown;
    location.hash = "";
    render();
  });
  document.getElementById("errReload").addEventListener("click", () => { window.location.reload(); });
}

// ---------- API ----------
async function api(path, opts) {
  const o = opts || {};
  const headers = { "Content-Type": "application/json" };
  const token = storage.get("exam_token");
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(path, { method: o.method || "GET", headers, body: o.body ? JSON.stringify(o.body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(data.error || ("請求失敗（" + res.status + "）。"));
  return data;
}
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

// ---------- 下載檔案（CSV / JSON 備份用）：帶登入 token，唔經 api() 因為要拎 blob ----------
async function downloadFile(path, fallbackName) {
  const token = storage.get("exam_token");
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(path, { headers });
  if (!res.ok) {
    let msg = "下載失敗（" + res.status + "）。";
    try { const d = await res.json(); if (d.error) msg = d.error; } catch (e) {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  let name = fallbackName || "download";
  const cd = res.headers.get("Content-Disposition") || "";
  const mm = cd.match(/filename="?([^";]+)"?/);
  if (mm) name = mm[1];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- 狀態 ----------
let me = null;
try { me = JSON.parse(storage.get("exam_user") || "null"); } catch (e) { me = null; }
let view = "dashboard";
let theme = "light";
try { theme = storage.get("exam_theme") || "light"; } catch (e) { theme = "light"; }
document.documentElement.setAttribute("data-theme", theme);
function toggleTheme() {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  try { storage.set("exam_theme", theme); } catch (e) {}
  render();
}
function setMe(user, token) {
  me = user;
  if (token) storage.set("exam_token", token);
  if (user) storage.set("exam_user", JSON.stringify(user)); else storage.remove("exam_user");
}
async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (e) {}
  storage.remove("exam_token"); setMe(null); view = "dashboard"; render();
}
function showView(v) { view = v; render(); }

// ---------- 登入頁 ----------
async function renderAuth() {
  let boot = { configured: true };
  try { boot = await api("/api/bootstrap"); } catch (e) {}
  const app = document.getElementById("app");
  const first = !boot.configured;
  app.innerHTML = '<main><div class="card" style="max-width:520px;margin:40px auto"><h2>考試系統</h2>' +
    (first ? '<p class="muted">首次開啟，請先建立管理員帳號，之後考生可以自行註冊。</p>' : '<p class="muted">VTS 同 430 備考系統，請登入或者註冊。</p>') +
    '<div id="authTabs"><button id="tabLogin">登入</button> <button id="tabReg">' + (first ? '建立管理員' : '註冊') + '</button> <button id="themeBtn">🌙 深色 / 淺色</button></div>' +
    '<div id="authForm"></div><p id="authMsg" class="muted"></p></div></main>';
  document.getElementById("themeBtn").addEventListener("click", toggleTheme);
  const formEl = document.getElementById("authForm");
  function drawLogin() {
    formEl.innerHTML = '<label>帳號</label><input id="aUser" autocomplete="username"><label>密碼</label><input id="aPass" type="password" autocomplete="current-password"><button class="primary" id="aGo">登入</button>';
    document.getElementById("aGo").addEventListener("click", async () => {
      try {
        const d = await api("/api/auth/login", { method: "POST", body: { username: document.getElementById("aUser").value, password: document.getElementById("aPass").value } });
        setMe(d.user, d.token); view = "dashboard"; render();
      } catch (e) { document.getElementById("authMsg").textContent = e.message; }
    });
  }
  function drawReg() {
    formEl.innerHTML = '<label>帳號</label><input id="aUser" autocomplete="username"><label>密碼（至少 6 個字）</label><input id="aPass" type="password" autocomplete="new-password"><label>確認密碼</label><input id="aPass2" type="password" autocomplete="new-password"><button class="primary" id="aGo">' + (first ? '建立管理員並登入' : '註冊並登入') + '</button>';
    document.getElementById("aGo").addEventListener("click", async () => {
      const p1 = document.getElementById("aPass").value, p2 = document.getElementById("aPass2").value;
      if (p1 !== p2) { document.getElementById("authMsg").textContent = "兩次密碼唔一致。"; return; }
      try {
        const d = await api("/api/auth/register", { method: "POST", body: { username: document.getElementById("aUser").value, password: p1 } });
        setMe(d.user, d.token); view = "dashboard"; render();
      } catch (e) { document.getElementById("authMsg").textContent = e.message; }
    });
  }
  function setTab(which) {
    document.getElementById("tabLogin").className = which === "login" ? "primary" : "";
    document.getElementById("tabReg").className = which === "reg" ? "primary" : "";
  }
  // 首次開啟（資料庫未有任何帳號）預設顯示建立管理員，唔係登入——否則登入一定失敗，死結。
  if (first) { drawReg(); setTab("reg"); } else { drawLogin(); setTab("login"); }
  document.getElementById("tabReg").addEventListener("click", () => { drawReg(); setTab("reg"); });
  document.getElementById("tabLogin").addEventListener("click", () => { drawLogin(); setTab("login"); });
}

// ---------- 主畫面 ----------
const NAV = [["dashboard", "儀表板"], ["practice", "刷題"], ["exam", "模擬考"], ["wrong", "錯題本"], ["fav", "收藏"], ["comments", "留言板"], ["questions", "題庫管理"], ["accounts", "帳號管理"]];
async function render() {
  const app = document.getElementById("app");
  delete app.dataset.errorShown;
  if (!me) { await renderAuth(); return; }
  const admin = me.role === "admin";
  const nav = NAV.filter((n) => admin || (n[0] !== "questions" && n[0] !== "accounts"));
  app.innerHTML = '<header class="top"><div class="row"><h1>考試系統</h1><span class="who">' + esc(me.username) + ' · ' + (admin ? "管理員" : "考生") + '</span><span class="spacer"></span><button id="themeBtn">🌙</button><button id="pwBtn">改密碼</button><button id="outBtn" class="danger">登出</button></div></header>' +
    '<nav class="tabs">' + nav.map((n) => '<button data-v="' + n[0] + '" class="' + (view === n[0] ? "on" : "") + '">' + n[1] + '</button>').join("") + '</nav>' +
    '<main id="main"></main><div id="modalRoot"></div>';
  app.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.v)));
  document.getElementById("themeBtn").addEventListener("click", toggleTheme);
  document.getElementById("outBtn").addEventListener("click", logout);
  document.getElementById("pwBtn").addEventListener("click", openChangePw);
  try {
    if (view === "dashboard") await viewDashboard();
    else if (view === "practice") await viewPractice();
    else if (view === "exam") await viewExamList();
    else if (view === "wrong") await viewWrong();
    else if (view === "fav") await viewFav();
    else if (view === "comments") await viewComments();
    else if (view === "questions") await viewQuestions();
    else if (view === "accounts") await viewAccounts();
  } catch (e) {
    document.getElementById("main").innerHTML = '<div class="card"><h2>載入出錯</h2><p class="muted">' + esc(e.message) + '</p></div>';
  }
}
function mainEl() { return document.getElementById("main"); }
function openModal(html) {
  const r = document.getElementById("modalRoot");
  r.innerHTML = '<div class="modal-back" id="mb"><div class="modal">' + html + '</div></div>';
  document.getElementById("mb").addEventListener("click", (e) => { if (e.target.id === "mb") closeModal(); });
  document.addEventListener("keydown", escClose);
}
function escClose(e) { if (e.key === "Escape") closeModal(); }
function closeModal() { const r = document.getElementById("modalRoot"); if (r) r.innerHTML = ""; document.removeEventListener("keydown", escClose); }
function openChangePw() {
  openModal('<h2>改密碼</h2><label>舊密碼</label><input id="oldPw" type="password"><label>新密碼（至少 6 個字）</label><input id="newPw" type="password"><p><button class="primary" id="pwGo">儲存</button> <button id="pwCancel">取消</button></p><p id="pwMsg" class="muted"></p>');
  document.getElementById("pwCancel").addEventListener("click", closeModal);
  document.getElementById("pwGo").addEventListener("click", async () => {
    try { await api("/api/auth/change-password", { method: "POST", body: { oldPassword: document.getElementById("oldPw").value, newPassword: document.getElementById("newPw").value } }); closeModal(); alert("密碼已改。"); }
    catch (e) { document.getElementById("pwMsg").textContent = e.message; }
  });
}
function optLetters(q) { return q.options.map((_, i) => String.fromCharCode(65 + i)); }
// 題目媒體：圖片跟題幹、選項或者解析三個位置顯示。
// 圖片闊度 100% 自適應（選項入面嘅圖會收細），影片用有控制掣嘅播放器；URL 全部經 esc() 輸出，唔會直接插 HTML。
// 媒體唔包含答案，唔影響計分。題幹媒體喺刷題、模擬考、錯題本、收藏、題庫預覽、成績報告逐題檢視都會顯示；
// 選項圖片跟住該選項一齊顯示；解析嘅影片同圖片淨係喺解析顯示嗰陣先出現（刷題答完、成績報告檢視）。
function mediaByPlace(q, place, opt) {
  const m = Array.isArray(q.media) ? q.media : [];
  return m.filter((x) => (x.place || "stem") === place && (place !== "option" || !opt || String(x.option || "").toUpperCase() === opt));
}
function mediaListHtml(items, small) {
  if (!items || items.length === 0) return "";
  return '<div class="qmedia' + (small ? " optmedia" : "") + '">' + items.map((x) => {
    const url = esc(x.url);
    if (x.type === "video") return '<video controls preload="metadata" src="' + url + '"></video>';
    return '<img src="' + url + '" alt="題目圖片" loading="lazy">';
  }).join("") + '</div>';
}
function mediaHtml(q) { return mediaListHtml(mediaByPlace(q, "stem"), false); }
function optionMediaHtml(q, letter) { return mediaListHtml(mediaByPlace(q, "option", letter), true); }
function explanationMediaHtml(q) { return mediaListHtml(mediaByPlace(q, "explanation"), false); }
function qCard(q, showAnswer) {
  return '<div class="card"><div><span class="pill">' + esc(q.exam) + '</span><span class="pill">' + esc(q.type) + '</span><span class="pill">' + esc(q.difficulty) + '</span><span class="pill">' + esc(q.question_id) + '</span></div><h3>' + esc(q.content) + '</h3>' + mediaHtml(q) +
    q.options.map((o, i) => { const L = String.fromCharCode(65 + i); return '<div>' + L + '. ' + esc(o) + optionMediaHtml(q, L) + '</div>'; }).join("") +
    (showAnswer ? '<details class="explain"><summary>解析（撳開睇）</summary><p>答案：' + esc(q.answer || "") + '</p><p>' + esc(q.explanation || "") + '</p>' + explanationMediaHtml(q) + '</details>' : "") + '</div>';
}

// ---------- 學生表現分析（管理員） ----------
let lastAnalytics = null;
let analyticsSort = "acc";
let pendingQSearch = "";
function accBarsHtml(rows, emptyMsg) {
  if (!rows || rows.length === 0) return '<p class="muted">' + emptyMsg + '</p>';
  return rows.map((x) => {
    const acc = x.accuracy == null ? 0 : x.accuracy;
    const cls = acc < 60 ? " bad" : "";
    return '<div class="bar-row"><div class="lbl"><span>' + esc(x.label) + '</span><span>' + x.correct + '/' + x.total + ' · ' + acc + '%</span></div><div class="bar' + cls + '"><div style="width:' + Math.max(2, acc) + '%"></div></div></div>';
  }).join("");
}
function missedTableHtml(rows) {
  if (!rows || rows.length === 0) return '<p class="muted">暫時未有答錯紀錄。</p>';
  return '<table><thead><tr><th>題號</th><th>題目</th><th>考試</th><th>題型</th><th>難度</th><th>答次</th><th>錯次</th><th>錯率</th><th></th></tr></thead><tbody>' + rows.map((x) => {
    const c = String(x.content || "");
    return '<tr><td>' + esc(x.question_id) + '</td><td>' + esc(c.length > 40 ? c.slice(0, 40) + "…" : c) + '</td><td>' + esc(x.exam) + '</td><td>' + esc(x.type) + '</td><td>' + esc(x.difficulty) + '</td><td>' + x.total + '</td><td>' + x.wrong + '</td><td>' + x.missRate + '%</td><td><button data-goto-q="' + esc(x.question_id) + '">去題庫</button></td></tr>';
  }).join("") + '</tbody></table>';
}
function studentTableHtml() {
  const list = (lastAnalytics ? lastAnalytics.perStudent : []).slice();
  if (list.length === 0) return '<p class="muted">暫時未有學生帳號。</p>';
  if (analyticsSort === "acc") list.sort((a, b) => {
    if (a.accuracy == null && b.accuracy == null) return b.answers - a.answers;
    if (a.accuracy == null) return 1;
    if (b.accuracy == null) return -1;
    return a.accuracy - b.accuracy || b.answers - a.answers;
  });
  else if (analyticsSort === "answers") list.sort((a, b) => b.answers - a.answers);
  else if (analyticsSort === "active") list.sort((a, b) => String(b.lastActive || "").localeCompare(String(a.lastActive || "")));
  else if (analyticsSort === "exams") list.sort((a, b) => b.examsDone - a.examsDone);
  return '<table><thead><tr><th>帳號</th><th>答題數</th><th>正確率</th><th>完成模擬考</th><th>平均分</th><th>最近活躍</th><th>最弱考試</th></tr></thead><tbody>' + list.map((s) => {
    const accCell = s.accuracy == null ? "—" : s.accuracy + "%" + (s.answers < 5 ? ' <span class="muted">（樣本少）</span>' : "");
    const avgCell = s.avgScore == null ? "—" : s.avgScore + "%";
    const weak = s.weakestExam ? esc(s.weakestExam.exam) + " " + s.weakestExam.accuracy + "%" : "—";
    const last = s.lastActive ? esc(String(s.lastActive).slice(0, 16).replace("T", " ")) : "—";
    return '<tr><td><button data-stu="' + s.user_id + '" style="padding:4px 8px">' + esc(s.username) + '</button>' + (s.role === "admin" ? ' <span class="muted">管理員</span>' : "") + '</td><td>' + s.answers + '</td><td>' + accCell + '</td><td>' + s.examsDone + '</td><td>' + avgCell + '</td><td>' + last + '</td><td>' + weak + '</td></tr>';
  }).join("") + '</tbody></table>';
}
function renderStudentTable() {
  const el = document.getElementById("stuTable");
  if (!el || !lastAnalytics) return;
  el.innerHTML = studentTableHtml();
  el.querySelectorAll("[data-stu]").forEach((b) => b.addEventListener("click", () => showStudentDetail(Number(b.dataset.stu))));
}
async function showStudentDetail(userId) {
  let s;
  try { const d = await api("/api/admin/analytics?user_id=" + encodeURIComponent(userId)); s = d.studentDetail; }
  catch (e) { openModal('<h2>載入失敗</h2><p class="muted">' + esc(e.message) + '</p><p><button id="mClose">關閉</button></p>'); document.getElementById("mClose").addEventListener("click", closeModal); return; }
  const perExamHtml = s.perExam.length === 0 ? '<p class="muted">暫時未有答題紀錄。</p>' : accBarsHtml(s.perExam.map((x) => ({ label: x.exam, total: x.total, correct: x.correct, accuracy: x.accuracy })), "");
  const examsHtml = s.recentExams.length === 0 ? '<p class="muted">暫時未完成任何模擬考。</p>' : '<table><thead><tr><th>卷名</th><th>分數</th><th>交卷時間</th></tr></thead><tbody>' + s.recentExams.map((e) => '<tr><td>' + esc(e.title) + '</td><td>' + e.score + '/' + e.total_questions + '</td><td>' + esc(String(e.end_time || "").slice(0, 16).replace("T", " ")) + '</td></tr>').join("") + '</tbody></table>';
  const missedHtml = s.topMissed.length === 0 ? '<p class="muted">暫時未有答錯紀錄。</p>' : '<table><thead><tr><th>題號</th><th>題目</th><th>考試</th><th>答次</th><th>錯次</th></tr></thead><tbody>' + s.topMissed.map((x) => '<tr><td>' + esc(x.question_id) + '</td><td>' + esc(String(x.content || "").slice(0, 40)) + '</td><td>' + esc(x.exam) + '</td><td>' + x.total + '</td><td>' + x.wrong + '</td></tr>').join("") + '</tbody></table>';
  openModal('<h2>' + esc(s.username) + ' · 學生詳情</h2><h3>各考試正確率</h3>' + perExamHtml + '<h3>最近 5 份模擬考</h3>' + examsHtml + '<h3>錯得最多嘅 5 題</h3>' + missedHtml + '<p><button id="mClose">關閉</button></p>');
  document.getElementById("mClose").addEventListener("click", closeModal);
}
async function renderAnalyticsCard() {
  const el = document.getElementById("analyticsCard");
  if (!el) return;
  let d;
  try { d = await api("/api/admin/analytics"); }
  catch (e) { el.innerHTML = '<div class="card"><h2>學生表現分析（管理員）</h2><p class="muted">載入失敗：' + esc(e.message) + '</p></div>'; return; }
  lastAnalytics = d;
  const hasData = d.mostMissed.length > 0 || d.perStudent.some((s) => s.answers > 0);
  el.innerHTML = '<div class="card"><h2>學生表現分析（管理員）</h2>' +
    '<p class="muted">數字按全部作答紀錄計；最弱考試要答過 ≥3 題先計；答題少過 5 題嘅正確率會標「樣本少」。撳學生帳號名可以睇佢嘅詳情。</p>' +
    (hasData ? "" : '<p class="muted">暫時未有作答紀錄。</p>') +
    '<h3>全站弱項（正確率由低至高）</h3>' +
    '<h3 style="font-size:15px">按考試</h3>' + accBarsHtml(d.weakByExam, "暫時未有作答紀錄。") +
    '<h3 style="font-size:15px">按題型</h3>' + accBarsHtml(d.weakByType, "暫時未有作答紀錄。") +
    '<h3 style="font-size:15px">按難度</h3>' + accBarsHtml(d.weakByDifficulty, "暫時未有作答紀錄。") +
    '<h3>必錯題目榜（頭 10 名）</h3>' + missedTableHtml(d.mostMissed.slice(0, 10)) +
    '<h3>學生一覽</h3><p><label>排序</label><select id="stuSort" style="max-width:280px"><option value="acc">正確率由低至高</option><option value="answers">答題數由多至少</option><option value="active">最近活躍（新至舊）</option><option value="exams">完成模擬考份數</option></select></p><div id="stuTable"></div>' +
    '<h3>最近完成嘅模擬考</h3>' + (d.recentExams.length === 0 ? '<p class="muted">暫時未完成任何模擬考。</p>' : '<table><thead><tr><th>學生</th><th>卷名</th><th>分數</th><th>交卷時間</th></tr></thead><tbody>' + d.recentExams.map((e) => '<tr><td>' + esc(e.username) + '</td><td>' + esc(e.title) + '</td><td>' + e.score + '/' + e.total_questions + '</td><td>' + esc(String(e.end_time || "").slice(0, 16).replace("T", " ")) + '</td></tr>').join("") + '</tbody></table>') +
    '</div>';
  document.getElementById("stuSort").addEventListener("change", (e) => { analyticsSort = e.target.value; renderStudentTable(); });
  renderStudentTable();
  el.querySelectorAll("[data-goto-q]").forEach((b) => b.addEventListener("click", () => { pendingQSearch = b.dataset.gotoQ; showView("questions"); }));
}

// ---------- 儀表板 ----------
let lastRestoreResult = null;
function restoreRowsHtml() {
  if (!lastRestoreResult) return "";
  return Object.keys(lastRestoreResult).map((t) => { const r = lastRestoreResult[t]; return "<p>• " + esc(t) + "：新增 " + r.inserted + " 行，更新 " + r.updated + " 行，跳過 " + r.skipped + " 行</p>"; }).join("");
}
async function viewDashboard() {
  const m = mainEl();
  const stats = await api("/api/stats/me");
  let adminHtml = "";
  if (me.role === "admin") {
    const a = await api("/api/stats/admin");
    const maxN = Math.max(1, ...a.byExam.map((x) => x.n));
    adminHtml = '<div class="card"><h2>題庫總覽（管理員）</h2><div class="grid4">' +
      '<div class="stat"><div class="k">題目總數</div><div class="v">' + a.questions + '</div></div>' +
      '<div class="stat"><div class="k">註冊帳號</div><div class="v">' + a.users + '</div></div>' +
      '<div class="stat"><div class="k">留言總數</div><div class="v">' + a.comments + '</div></div></div>' +
      '<h3>題型分佈：' + a.byType.map((x) => esc(x.type) + " " + x.n).join("、") + '</h3>' +
      '<h3>難度分佈：' + a.byDifficulty.map((x) => esc(x.difficulty) + " " + x.n).join("、") + '</h3>' +
      '<h3>各考試題目分佈</h3>' + (a.byExam.length === 0 ? '<p class="muted">題庫暫時係空。</p>' : a.byExam.map((x) => '<div class="bar-row"><div class="lbl"><span>' + esc(x.exam) + '</span><span>' + x.n + ' 題</span></div><div class="bar blue"><div style="width:' + Math.max(4, Math.round((x.n / maxN) * 100)) + '%"></div></div></div>').join("")) + '</div>' +
      '<div id="analyticsCard"></div>' +
      '<div class="card"><h2>備份與匯出（管理員）</h2><p class="muted">版本 1.2.0（2026-11-21）</p>' +
      '<p><button id="bkQ">⬇ 匯出題目 CSV（全部）</button> <button id="bkU">⬇ 匯出學生帳號 CSV</button> <button id="bkAll" class="primary">⬇ 下載成站備份 JSON</button></p>' +
      '<p class="muted">題目 CSV 格式同匯入範本一樣，可以直接用嚟備份或者搬去另一部機。學生帳號 CSV 唔包含密碼雜湊。成站備份 JSON 包晒題目、帳號、成績、答題紀錄、留言、收藏、登入狀態、模擬考草稿同組卷模板。備份 JSON 唔包上傳咗嘅圖片／影片檔案本身，要另外經 SFTP 下載 data/uploads/ 一齊備份。</p>' +
      '<p class="muted">⚠️ 備份檔包含密碼雜湊，唔好公開分享，妥善保存。遺失咗人哋攞到就可以離線慢慢試密碼。</p>' +
      '<p><label>還原備份 JSON</label><input type="file" id="rsFile" accept=".json,application/json"><button id="rsGo">還原備份</button></p>' +
      '<p class="muted">還原用合併方式：按編號 / 帳號逐行新增或者更新，唔會清空現有資料；失敗會成個取消，唔會還原一半。還原前建議先下載一份最新備份。</p>' +
      '<p id="bkMsg" class="muted">' + (lastRestoreResult ? "上次還原完成，數字如下。" : "") + '</p><div id="bkResult">' + restoreRowsHtml() + '</div></div>';
  }
  const trend = stats.trend.map((t) => esc(t.title) + "：" + t.score + "/" + t.total_questions).join("、") || "暫時未完成任何模擬考。";
  // 繼續考試放最頂：儀表板第一節
  let myExams = [];
  try { myExams = (await api("/api/exams")).exams; } catch (e) { myExams = []; }
  const inProg = myExams.filter((e) => e.status !== "已完成");
  const continueHtml = '<div class="card"><h2>繼續考試</h2>' + (inProg.length === 0 ? '<p class="muted">暫時冇進行中嘅模擬考。</p>' : inProg.map((e) => '<p><b>' + esc(e.title) + '</b> · ' + e.total_questions + ' 題 <button class="primary" data-open="' + e.exam_id + '">繼續作答</button></p>').join("")) + '</div>';
  m.innerHTML = '<h2>我嘅學習概況</h2>' + continueHtml + '<div class="grid4">' +
    '<div class="stat"><div class="k">累計答題</div><div class="v">' + stats.total + '</div></div>' +
    '<div class="stat"><div class="k">整體正確率</div><div class="v">' + stats.accuracy + '%</div><div class="muted">答對 ' + stats.correct + ' 題</div></div>' +
    '<div class="stat"><div class="k">錯題本</div><div class="v">' + stats.wrong + ' 題</div><div class="muted">曾經答錯嘅題目</div></div>' +
    '<div class="stat"><div class="k">已完成模擬考</div><div class="v">' + stats.examsDone + ' 份</div></div></div>' +
    '<div class="card"><p><button class="primary" id="goP">開始刷題</button> <button id="goE">開新模擬考</button> <button id="goW">去錯題本</button></p>' +
    '<h3>各考試正確率</h3>' + (stats.perExam.length === 0 ? '<p class="muted">暫時未有答題紀錄。</p>' : stats.perExam.map((x) => { const acc = x.total ? Math.round((x.correct / x.total) * 100) : 0; return '<div class="bar-row"><div class="lbl"><span>' + esc(x.exam) + '</span><span>' + x.correct + '/' + x.total + ' · ' + acc + '%</span></div><div class="bar"><div style="width:' + acc + '%"></div></div></div>'; }).join("")) +
    '<h3>歷次模擬考分數趨勢</h3><p class="muted">' + trend + '</p></div>' + adminHtml;
  m.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openExam(Number(b.dataset.open))));
  document.getElementById("goP").addEventListener("click", () => showView("practice"));
  document.getElementById("goE").addEventListener("click", () => showView("exam"));
  document.getElementById("goW").addEventListener("click", () => showView("wrong"));
  // 備份與匯出（管理員先見到）
  const bkQ = document.getElementById("bkQ");
  if (bkQ) {
    bkQ.addEventListener("click", async () => { try { await downloadFile("/api/admin/export/questions", "questions.csv"); } catch (e) { document.getElementById("bkMsg").textContent = e.message; } });
    document.getElementById("bkU").addEventListener("click", async () => { try { await downloadFile("/api/admin/export/users", "users.csv"); } catch (e) { document.getElementById("bkMsg").textContent = e.message; } });
    document.getElementById("bkAll").addEventListener("click", async () => { try { await downloadFile("/api/admin/backup", "exam-backup.json"); } catch (e) { document.getElementById("bkMsg").textContent = e.message; } });
    document.getElementById("rsGo").addEventListener("click", async () => {
      const f = document.getElementById("rsFile").files[0];
      if (!f) { document.getElementById("bkMsg").textContent = "請先揀一個備份 JSON 檔案。"; return; }
      let backup;
      try { backup = JSON.parse(await f.text()); } catch (e) { document.getElementById("bkMsg").textContent = "檔案唔係有效嘅 JSON 格式。"; return; }
      if (!confirm("確定還原呢個備份？會用合併方式寫入，唔會清空現有資料。建議還原前先下載一份最新備份。")) return;
      try {
        const d = await api("/api/admin/restore", { method: "POST", body: { backup } });
        lastRestoreResult = d.result;
        showView("dashboard");
      } catch (e) { document.getElementById("bkMsg").textContent = e.message; }
    });
  }
  // 學生表現分析（管理員先見到）
  if (me.role === "admin") renderAnalyticsCard();
}

// ---------- 刷題 ----------
let practiceState = { list: [], idx: 0, drawn: [], answered: false, last: null, favs: new Set() };
async function viewPractice() {
  const m = mainEl();
  let exams = [];
  try { exams = (await api("/api/questions/exams")).exams; } catch (e) {}
  m.innerHTML = '<div class="card"><h2>刷題模式</h2><div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<select id="pExam" style="flex:1;min-width:120px"><option value="">全部考試</option>' + exams.map((e) => '<option>' + esc(e) + '</option>').join("") + '</select>' +
    '<select id="pDiff" style="flex:1;min-width:110px"><option value="">全部難度</option><option>簡單</option><option>中等</option><option>困難</option></select>' +
    '<select id="pType" style="flex:1;min-width:110px"><option value="">全部題型</option><option>單選</option><option>多選</option><option>判斷</option><option>簡答</option></select>' +
    '<select id="pCount" style="width:90px"><option value="10">10 題</option><option value="5">5 題</option><option value="20">20 題</option></select></div>' +
    '<p><button class="primary" id="pDraw">隨機抽題</button> <span id="pMsg" class="muted"></span></p></div><div id="pArea"></div>';
  document.getElementById("pDraw").addEventListener("click", async () => {
    try {
      const d = await api("/api/practice/draw", { method: "POST", body: { exam: document.getElementById("pExam").value, difficulty: document.getElementById("pDiff").value, type: document.getElementById("pType").value, count: Number(document.getElementById("pCount").value), excludeIds: [] } });
      if (d.questions.length === 0) { document.getElementById("pMsg").textContent = "呢個篩選條件暫時冇題目，請先新增題目或者匯入題庫。"; return; }
      practiceState = { list: d.questions, idx: 0, drawn: d.questions.map((q) => q.question_id), answered: false, last: null, favs: practiceState.favs };
      renderPracticeQ();
    } catch (e) { document.getElementById("pMsg").textContent = e.message; }
  });
}
function renderPracticeQ() {
  const area = document.getElementById("pArea");
  if (!area) return;
  const q = practiceState.list[practiceState.idx];
  if (!q) { area.innerHTML = '<div class="card"><p>抽完喇，撳上面再抽一批。</p></div>'; return; }
  const fav = practiceState.favs.has(q.question_id);
  area.innerHTML = '<div class="card"><div class="muted">第 ' + (practiceState.idx + 1) + ' / ' + practiceState.list.length + ' 題</div>' +
    '<div><span class="pill">' + esc(q.exam) + '</span><span class="pill">' + esc(q.type) + '</span><span class="pill">' + esc(q.difficulty) + '</span></div>' +
    '<h3>' + esc(q.content) + '</h3>' + mediaHtml(q) +
    (q.type === "簡答" ? '<textarea id="pAns" placeholder="寫低你嘅答案"></textarea>' : q.options.map((o, i) => { const L = String.fromCharCode(65 + i); if (q.type === "多選") return '<label><input type="checkbox" class="pOpt" value="' + L + '"> ' + L + '. ' + esc(o) + optionMediaHtml(q, L) + '</label>'; return '<button class="opt" data-v="' + L + '">' + L + '. ' + esc(o) + optionMediaHtml(q, L) + '</button>'; }).join("")) +
    '<p><button class="primary" id="pSubmit">交答案</button> <button id="pFav">' + (fav ? "★ 已收藏" : "☆ 收藏") + '</button> <button id="pNext">下一題</button></p><div id="pResult"></div>' +
    '<div id="pDiscuss"></div></div>';
  if (q.type !== "簡答") {
    area.querySelectorAll("button.opt").forEach((b) => b.addEventListener("click", () => {
      if (q.type === "多選") return;
      area.querySelectorAll("button.opt").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
    }));
  }
  document.getElementById("pFav").addEventListener("click", async () => {
    try {
      if (fav) { await api("/api/favorites/" + encodeURIComponent(q.question_id), { method: "DELETE" }); practiceState.favs.delete(q.question_id); }
      else { await api("/api/favorites/" + encodeURIComponent(q.question_id), { method: "POST" }); practiceState.favs.add(q.question_id); }
      renderPracticeQ();
    } catch (e) { alert(e.message); }
  });
  document.getElementById("pNext").addEventListener("click", () => { practiceState.idx++; practiceState.answered = false; renderPracticeQ(); });
  document.getElementById("pSubmit").addEventListener("click", async () => {
    if (practiceState.answeredQ === q.question_id) return; // 呢題已經交過，唔重複記分
    let ua = "";
    if (q.type === "簡答") ua = document.getElementById("pAns").value;
    else if (q.type === "多選") ua = Array.from(area.querySelectorAll(".pOpt:checked")).map((x) => x.value).sort().join("");
    else { const sel = area.querySelector("button.opt.sel"); ua = sel ? sel.dataset.v : ""; }
    if (!ua) { document.getElementById("pResult").innerHTML = '<p class="muted">請先揀答案。</p>'; return; }
    try {
      const d = await api("/api/practice/answer", { method: "POST", body: { question_id: q.question_id, user_answer: ua } });
      practiceState.answeredQ = q.question_id;
      const res = document.getElementById("pResult");
      if (q.type === "簡答") {
        res.innerHTML = '<details class="explain" open><summary>參考答案</summary><p>' + esc(d.reference || "") + '</p><p>' + esc(d.explanation || "") + '</p>' + explanationMediaHtml(q) + '</details><p>你覺得自己答啱定答錯？ <button id="selfOk">我答對了</button> <button id="selfNo">我答錯了</button></p>';
        document.getElementById("selfOk").addEventListener("click", async () => { await api("/api/practice/answer", { method: "POST", body: { question_id: q.question_id, user_answer: ua, self_correct: true } }); res.innerHTML = "<p>已記錄：答對。</p>"; });
        document.getElementById("selfNo").addEventListener("click", async () => { await api("/api/practice/answer", { method: "POST", body: { question_id: q.question_id, user_answer: ua, self_correct: false } }); res.innerHTML = "<p>已記錄：答錯，已經加入錯題本。</p>"; });
      } else {
        res.innerHTML = '<p><b>' + (d.correct ? "✓ 答對" : "✗ 答錯") + '</b>，正確答案：' + esc(d.answer || "") + '</p><details class="explain"><summary>解析（撳開睇）</summary><p>' + esc(d.explanation || "") + '</p>' + explanationMediaHtml(q) + '</details>';
      }
      loadQuestionComments(q.question_id, document.getElementById("pDiscuss"));
    } catch (e) { document.getElementById("pResult").innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
  });
}

// ---------- 收藏 ----------
async function viewFav() {
  const m = mainEl();
  const d = await api("/api/favorites");
  m.innerHTML = '<h2>收藏</h2>' + (d.questions.length === 0 ? '<div class="card"><p class="muted">暫時未有收藏，刷題嗰陣撳星號收藏題目。</p></div>' : d.questions.map((q) => qCard(q, true)).join(""));
}

// ---------- 錯題本 ----------
async function viewWrong() {
  const m = mainEl();
  let exams = [];
  try { exams = (await api("/api/questions/exams")).exams; } catch (e) {}
  m.innerHTML = '<div class="card"><h2>錯題本</h2><div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<select id="wExam" style="flex:1;min-width:120px"><option value="">全部考試</option>' + exams.map((e) => '<option>' + esc(e) + '</option>').join("") + '</select>' +
    '<select id="wSrc" style="flex:1;min-width:140px"><option value="all">全部來源</option><option value="practice">自由刷題</option></select></div>' +
    '<p><button class="primary" id="wGo">篩選</button> <button id="wRedo">錯題重做</button></p></div><div id="wArea"></div>';
  async function load() {
    const ex = document.getElementById("wExam").value, src = document.getElementById("wSrc").value;
    const d = await api("/api/wrong?exam=" + encodeURIComponent(ex) + "&source=" + encodeURIComponent(src));
    const area = document.getElementById("wArea");
    const sel = document.getElementById("wSrc");
    const cur = sel.value;
    sel.innerHTML = d.sources.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.title) + '</option>').join("");
    sel.value = cur;
    if (d.questions.length === 0) { area.innerHTML = '<div class="card"><p class="muted">暫時未有錯題，答錯咗嘅題會自動入嚟。</p></div>'; return; }
    area.innerHTML = d.questions.map((q) => {
      const srcTxt = (q.wrong_source && q.wrong_source.from_practice ? "自由刷題" : "") + (q.wrong_source && q.wrong_source.sources.length ? (q.wrong_source.from_practice ? "、" : "") + q.wrong_source.sources.map((s) => esc(s.title)).join("、") : "");
      return '<div class="card"><div class="muted">來源：' + srcTxt + '</div>' + qCard(q, true).replace('<div class="card">', "").replace(/<\/div>$/, "");
    }).join("");
  }
  document.getElementById("wGo").addEventListener("click", load);
  document.getElementById("wRedo").addEventListener("click", async () => {
    const d = await api("/api/practice/draw", { method: "POST", body: { wrongOnly: true, count: 10, excludeIds: [] } });
    if (d.questions.length === 0) { alert("暫時未有錯題。"); return; }
    practiceState = { list: d.questions, idx: 0, drawn: d.questions.map((q) => q.question_id), answered: false, last: null, favs: practiceState.favs };
    showView("practice");
    setTimeout(renderPracticeQ, 50);
  });
  await load();
}

// ---------- 留言 ----------
async function loadQuestionComments(qid, el) {
  if (!el) return;
  try {
    const d = await api("/api/comments/question/" + encodeURIComponent(qid));
    el.innerHTML = '<h3>呢條題嘅討論</h3>' + (d.comments.length === 0 ? '<p class="muted">暫時未有討論。</p>' : d.comments.map((c) => '<p><b>' + esc(c.username) + '</b>：' + esc(c.content) + (me.role === "admin" || c.user_id === me.user_id ? ' <button data-c="' + c.comment_id + '" class="cDel">刪除</button>' : "") + '</p>').join("")) +
      '<textarea id="cText" placeholder="寫低你嘅討論或者補充筆記"></textarea><p><button class="primary" id="cAdd">留言</button></p>';
    document.getElementById("cAdd").addEventListener("click", async () => {
      const t = document.getElementById("cText").value.trim();
      if (!t) return;
      await api("/api/comments", { method: "POST", body: { question_id: qid, content: t } });
      loadQuestionComments(qid, el);
    });
    el.querySelectorAll(".cDel").forEach((b) => b.addEventListener("click", async () => { if (confirm("確定刪除呢則留言？")) { await api("/api/comments/" + b.dataset.c, { method: "DELETE" }); loadQuestionComments(qid, el); } }));
  } catch (e) { el.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
}
async function viewComments() {
  const m = mainEl();
  const d = await api("/api/comments");
  m.innerHTML = '<div class="card"><h2>留言板</h2><textarea id="gText" placeholder="寫低你想講嘅嘢"></textarea><p><button class="primary" id="gAdd">發表留言</button></p><div id="gList">' +
    (d.comments.length === 0 ? '<p class="muted">暫時未有留言。</p>' : d.comments.map((c) => '<p><b>' + esc(c.username) + '</b>：' + esc(c.content) + ' <span class="muted">' + esc(c.created_at.slice(0, 10)) + '</span>' + (me.role === "admin" || c.user_id === me.user_id ? ' <button data-c="' + c.comment_id + '" class="cDel">刪除</button>' : "") + '</p>').join("")) + '</div></div>';
  document.getElementById("gAdd").addEventListener("click", async () => {
    const t = document.getElementById("gText").value.trim();
    if (!t) return;
    await api("/api/comments", { method: "POST", body: { content: t } });
    showView("comments");
  });
  m.querySelectorAll(".cDel").forEach((b) => b.addEventListener("click", async () => { if (confirm("確定刪除呢則留言？")) { await api("/api/comments/" + b.dataset.c, { method: "DELETE" }); showView("comments"); } }));
}

// ---------- 模擬考 ----------
let examState = null;
async function viewExamList() {
  const m = mainEl();
  const d = await api("/api/exams");
  let exams = [];
  try { exams = (await api("/api/questions/exams")).exams; } catch (e) {}
  let templates = [];
  try { templates = (await api("/api/templates")).templates; } catch (e) { templates = []; }
  const examOpts = exams; // 只顯示題庫真正有題嘅考試，唔好硬編 VTS / 430 空殼；匯入題目之後考試會自動出現
  const diffOpts = ["簡單", "中等", "困難"];
  const sourceOpts = [["all", "全部題目"], ["unanswered", "未做過"], ["answered", "做過的"], ["wrong", "錯題"]];
  const isAdmin = me && me.role === "admin";
  let editingTemplateId = null;
  // 繼續考試放模擬考頁最頂，跟住先係我嘅考卷
  const inProgExams = d.exams.filter((e) => e.status !== "已完成");
  const continueHtml = '<div class="card"><h2>繼續考試</h2>' + (inProgExams.length === 0 ? '<p class="muted">暫時冇進行中嘅模擬考。</p>' : inProgExams.map((e) => '<p><b>' + esc(e.title) + '</b> · ' + e.total_questions + ' 題 <button class="primary" data-open="' + e.exam_id + '">繼續作答</button></p>').join("")) + '</div>';
  const myExamsHtml = '<div class="card"><h2>我嘅考卷</h2>' + (d.exams.length === 0 ? '<p class="muted">暫時未開過模擬考。</p>' : d.exams.map((e) => '<p><b>' + esc(e.title) + '</b> · ' + esc(e.status) + (e.score != null ? ' · ' + e.score + '/' + e.total_questions + ' 分' : ' · ' + e.total_questions + ' 題') + ' <button data-open="' + e.exam_id + '">' + (e.status === "已完成" ? "睇成績" : "繼續作答") + '</button> <button data-del="' + e.exam_id + '" class="danger">刪除</button></p>').join("")) + '</div>';
  m.innerHTML = continueHtml + myExamsHtml + '<div class="card"><h2>開新模擬考</h2><label>考卷名稱</label><input id="eTitle" placeholder="例如：VTS 模擬卷 01">' +
    '<label>考試（可剔多個）</label><div id="eExams">' + (examOpts.length === 0 ? '<p class="muted">題庫暫時係空，請先新增題目或者匯入題庫；匯入之後考試會自動出現。</p>' : examOpts.map((e) => '<label class="chk"><input type="checkbox" class="eExam" value="' + esc(e) + '" checked> ' + esc(e) + '</label>').join("")) + '</div>' +
    '<label>難度（可剔多個）</label><div id="eDiffs">' + diffOpts.map((d) => '<label class="chk"><input type="checkbox" class="eDiff" value="' + d + '" checked> ' + d + '</label>').join("") + '</div>' +
    '<label>題目來源（以你自己嘅作答紀錄計）</label><div id="eSources">' + sourceOpts.map((s, i) => '<label class="chk"><input type="radio" name="eSource" value="' + s[0] + '"' + (i === 0 ? " checked" : "") + '> ' + s[1] + '</label>').join("") + '</div>' +
    '<p id="ePool" class="muted">符合條件嘅題目有 … 題</p>' +
    '<label>題數 <span id="eCap" class="muted"></span></label><input id="eCount" type="number" value="10" min="1" max="100">' +
    '<p><button class="primary" id="eCreate">隨機組卷</button> <span id="eMsg" class="muted"></span></p></div>' +
    '<div class="card"><h2>按考試組卷</h2>' +
    '<p class="muted">即場組合：剔選考試，逐個考試設定要幾多題，合併成一份複合題目嘅模擬考（例如中文 5 題、英文 3 題、數學 4 題）。上面嘅難度同題目來源套用到每一個考試。唔使儲存；想儲存成固定配方，落去下面「組卷模板管理」。</p>' +
    (examOpts.length === 0 ? '<p class="muted">題庫暫時係空，請先新增題目或者匯入題庫；匯入之後考試會自動出現。</p>' : '<div id="eByExam">' + examOpts.map((e) => '<div class="by-row" data-exam="' + esc(e) + '"><label class="chk"><input type="checkbox" class="eByCheck" checked> <b>' + esc(e) + '</b></label> <span class="byPool muted">題庫有 … 題</span> <label>題數 <input type="number" class="eByCount" value="5" min="1" max="100"></label></div>').join("") + '</div>') +
    '<p id="eByExamTotal" class="muted">合共 0 題</p>' +
    '<p><button class="primary" id="eCreateByExam">出卷</button> <span id="eByExamMsg" class="muted"></span></p></div>' +
    '<div class="card"><h2>用模板開卷</h2>' +
    '<label>組卷模板</label><select id="eTpl">' + (templates.length === 0 ? '<option value="">暫時未有模板</option>' : templates.map((t) => '<option value="' + t.template_id + '">' + esc(t.title) + '（' + esc(t.summary) + '）</option>').join("")) + '</select>' +
    '<p><button class="primary" id="eCreateTpl">用模板開卷</button> <span id="eTplMsg" class="muted"></span></p>' +
    '<p class="muted">模板係管理員預先儲存嘅固定配方（例如 VTS 10 題、430 5 題），揀好之後按模板數目隨機出題，唔同考試唔會重複題目。</p></div>' +
    (isAdmin ? '<div class="card"><h2>組卷模板管理（管理員）</h2>' +
      (exams.length === 0
        ? '<p class="muted">題庫暫時係空，請先新增題目或者匯入題庫，之後先可以新增模板。</p>'
        : '<label>模板標題</label><input id="tTitle" placeholder="例如：VTS 衝刺卷">' +
          '<div id="tRules"></div>' +
          '<p><button id="tAddRule">加一條規則</button> <button id="tSave" class="primary">新增模板</button> <button id="tCancelEdit" style="display:none">取消修改</button> <span id="tMsg" class="muted"></span></p>' +
          '<p><button id="tAll1">一鍵建立：全考試各1題</button> <button id="tAll2">一鍵建立：全考試各2題</button></p>' +
          '<p class="muted">一鍵建立會按題庫現有嘅每一個考試各出 1 題（或者 2 題）建成普通模板，之後可以照樣修改或者刪除。</p>') +
      '<div id="tList"></div></div>' : '') +
    '';
  function currentFilters() {
    const examsSel = Array.from(m.querySelectorAll(".eExam:checked")).map((c) => c.value);
    const diffsSel = Array.from(m.querySelectorAll(".eDiff:checked")).map((c) => c.value);
    const srcEl = m.querySelector('input[name="eSource"]:checked');
    return { exams: examsSel, difficulties: diffsSel, source: srcEl ? srcEl.value : "all" };
  }
  async function updatePool() {
    const f = currentFilters();
    const poolEl = document.getElementById("ePool");
    const capEl = document.getElementById("eCap");
    const countEl = document.getElementById("eCount");
    if (f.exams.length === 0 || f.difficulties.length === 0) {
      poolEl.textContent = "請至少剔選一個考試同一個難度。";
      capEl.textContent = "";
      countEl.max = 100;
      return;
    }
    try {
      const d = await api("/api/exams/pool?exams=" + encodeURIComponent(f.exams.join(",")) + "&difficulties=" + encodeURIComponent(f.difficulties.join(",")) + "&source=" + encodeURIComponent(f.source));
      poolEl.textContent = "符合條件嘅題目有 " + d.count + " 題";
      capEl.textContent = "（題池上限 " + d.count + " 題）";
      countEl.max = Math.max(1, d.count);
    } catch (e) { poolEl.textContent = "題池載入失敗：" + e.message; }
  }
  // ---------- 按考試組卷 ----------
  // 每行考試嘅題庫題數，用現有 /api/exams/pool 逐個考試查，跟住而家揀緊嘅難度同題目來源即時計。
  let byExamToken = 0;
  function updateByExamTotal() {
    const el = document.getElementById("eByExamTotal");
    if (!el) return;
    const parts = [];
    let total = 0;
    m.querySelectorAll(".by-row").forEach((row) => {
      const chk = row.querySelector(".eByCheck");
      if (!chk || !chk.checked) return;
      const n = Number(row.querySelector(".eByCount").value) || 0;
      total += n;
      parts.push(row.dataset.exam + " " + n + " 題");
    });
    el.textContent = parts.length === 0 ? "合共 0 題" : ("合共 " + total + " 題（" + parts.join("、") + "）");
  }
  async function updateByExamCounts() {
    const rows = Array.from(m.querySelectorAll(".by-row"));
    if (rows.length === 0) return;
    const f = currentFilters();
    const myToken = ++byExamToken;
    if (f.difficulties.length === 0) {
      rows.forEach((row) => { const s = row.querySelector(".byPool"); if (s) s.textContent = "請至少剔選一個難度。"; });
      return;
    }
    const results = await Promise.all(rows.map(async (row) => {
      try {
        const dd = await api("/api/exams/pool?exams=" + encodeURIComponent(row.dataset.exam) + "&difficulties=" + encodeURIComponent(f.difficulties.join(",")) + "&source=" + encodeURIComponent(f.source));
        return { exam: row.dataset.exam, count: dd.count };
      } catch (e) { return { exam: row.dataset.exam, count: null }; }
    }));
    if (myToken !== byExamToken) return; // 篩選又改咗，呢批舊結果唔用
    results.forEach((r) => {
      const row = rows.find((x) => x.dataset.exam === r.exam);
      if (!row) return;
      const s = row.querySelector(".byPool");
      if (s) s.textContent = r.count == null ? "題數載入失敗" : ("題庫有 " + r.count + " 題" + (r.count === 0 ? "（呢個篩選暫時冇題）" : ""));
    });
  }
  async function createByExam() {
    const msgEl = document.getElementById("eByExamMsg");
    const f = currentFilters();
    if (f.difficulties.length === 0) { msgEl.textContent = "請至少剔選一個難度。"; return; }
    const rows = Array.from(m.querySelectorAll(".by-row"));
    const rules = [];
    for (const row of rows) {
      if (!row.querySelector(".eByCheck").checked) continue;
      const n = Number(row.querySelector(".eByCount").value);
      if (!Number.isInteger(n) || n < 1 || n > 100) { msgEl.textContent = "「" + row.dataset.exam + "」題數要係 1 至 100。"; return; }
      rules.push({ exam: row.dataset.exam, count: n, difficulties: f.difficulties, source: f.source });
    }
    if (rules.length === 0) { msgEl.textContent = "請至少剔選一個考試。"; return; }
    try {
      const r = await api("/api/exams", { method: "POST", body: { title: document.getElementById("eTitle").value, rules } });
      if (r.note) alert(r.note);
      openExam(r.exam_id);
    } catch (e) { msgEl.textContent = e.message; }
  }
  async function create() {
    try {
      const f = currentFilters();
      if (f.exams.length === 0) { document.getElementById("eMsg").textContent = "請至少剔選一個考試。"; return; }
      if (f.difficulties.length === 0) { document.getElementById("eMsg").textContent = "請至少剔選一個難度。"; return; }
      const r = await api("/api/exams", { method: "POST", body: { title: document.getElementById("eTitle").value, count: Number(document.getElementById("eCount").value) || 10, exams: f.exams, difficulties: f.difficulties, source: f.source } });
      if (r.note) alert(r.note);
      openExam(r.exam_id);
    } catch (e) { document.getElementById("eMsg").textContent = e.message; }
  }
  // ---------- 組卷模板 ----------
  function ruleRowHtml(rule) {
    const r = rule || { exam: exams[0] || "", count: 5, difficulties: [], source: "all" };
    const allDiff = !r.difficulties || r.difficulties.length === 0;
    return '<div class="t-rule"><label>考試</label><select class="tExam">' + exams.map((e) => '<option' + (e === r.exam ? " selected" : "") + '>' + esc(e) + '</option>').join("") + '</select>' +
      '<label>題數</label><input type="number" class="tCount" value="' + (r.count || 5) + '" min="1" max="100">' +
      '<label>難度（全剔即全部難度）</label><div>' + ["簡單", "中等", "困難"].map((dd) => '<label class="chk"><input type="checkbox" class="tDiff" value="' + dd + '"' + (allDiff || (r.difficulties || []).includes(dd) ? " checked" : "") + '> ' + dd + '</label>').join("") + '</div>' +
      '<label>題目來源</label><select class="tSource">' + sourceOpts.map((s) => '<option value="' + s[0] + '"' + (s[0] === (r.source || "all") ? " selected" : "") + '>' + s[1] + '</option>').join("") + '</select>' +
      '<p><button class="tDelRule">刪除呢條規則</button></p></div>';
  }
  function addRuleRow(rule) {
    const wrap = document.getElementById("tRules");
    if (!wrap) return;
    const div = document.createElement("div");
    div.innerHTML = ruleRowHtml(rule);
    div.querySelector(".tDelRule").addEventListener("click", () => {
      if (document.querySelectorAll("#tRules .t-rule").length <= 1) { document.getElementById("tMsg").textContent = "模板至少要有一條規則。"; return; }
      div.remove();
    });
    wrap.appendChild(div);
  }
  function readRules() {
    return Array.from(document.querySelectorAll("#tRules .t-rule")).map((row) => {
      const diffs = Array.from(row.querySelectorAll(".tDiff:checked")).map((c) => c.value);
      return { exam: row.querySelector(".tExam").value, count: Number(row.querySelector(".tCount").value) || 0, difficulties: diffs.length === 3 ? [] : diffs, source: row.querySelector(".tSource").value };
    });
  }
  function renderTemplateList() {
    const el = document.getElementById("tList");
    if (!el) return;
    el.innerHTML = templates.length === 0 ? '<p class="muted">暫時未有模板。</p>' : templates.map((t) => '<p><b>' + esc(t.title) + '</b> · ' + esc(t.summary) + ' · 由 ' + esc(t.created_by_name || "—") + ' 建立 · ' + esc(String(t.created_at || "").slice(0, 10)) + ' <button data-tedit="' + t.template_id + '">修改</button> <button data-tdel="' + t.template_id + '" class="danger">刪除</button></p>').join("");
    el.querySelectorAll("[data-tedit]").forEach((b) => b.addEventListener("click", () => {
      const t = templates.find((x) => x.template_id === Number(b.dataset.tedit));
      if (!t) return;
      editingTemplateId = t.template_id;
      document.getElementById("tTitle").value = t.title;
      document.getElementById("tRules").innerHTML = "";
      t.config.forEach((r) => addRuleRow(r));
      document.getElementById("tSave").textContent = "儲存修改";
      document.getElementById("tCancelEdit").style.display = "";
      document.getElementById("tTitle").scrollIntoView();
    }));
    el.querySelectorAll("[data-tdel]").forEach((b) => b.addEventListener("click", async () => {
      const t = templates.find((x) => x.template_id === Number(b.dataset.tdel));
      if (!t) return;
      if (!confirm("確定刪除模板「" + t.title + "」？")) return;
      try { await api("/api/templates/" + t.template_id, { method: "DELETE" }); await refreshTemplates(); } catch (e) { document.getElementById("tMsg").textContent = e.message; }
    }));
  }
  async function refreshTemplates() {
    try { templates = (await api("/api/templates")).templates; } catch (e) { templates = []; }
    const sel = document.getElementById("eTpl");
    if (sel) sel.innerHTML = templates.length === 0 ? '<option value="">暫時未有模板</option>' : templates.map((t) => '<option value="' + t.template_id + '">' + esc(t.title) + '（' + esc(t.summary) + '）</option>').join("");
    renderTemplateList();
  }
  async function saveTemplate() {
    const msgEl = document.getElementById("tMsg");
    const title = document.getElementById("tTitle").value.trim();
    const config = readRules();
    if (!title) { msgEl.textContent = "請填寫模板標題。"; return; }
    if (config.length === 0) { msgEl.textContent = "模板至少要有一條規則。"; return; }
    try {
      if (editingTemplateId) {
        await api("/api/templates/" + editingTemplateId, { method: "PUT", body: { title, config } });
        msgEl.textContent = "已儲存修改。";
      } else {
        await api("/api/templates", { method: "POST", body: { title, config } });
        msgEl.textContent = "已新增模板。";
      }
      editingTemplateId = null;
      document.getElementById("tTitle").value = "";
      document.getElementById("tRules").innerHTML = "";
      addRuleRow();
      document.getElementById("tSave").textContent = "新增模板";
      document.getElementById("tCancelEdit").style.display = "none";
      await refreshTemplates();
    } catch (e) { msgEl.textContent = e.message; }
  }
  // ---------- 綁定 ----------
  m.querySelectorAll(".eExam, .eDiff, input[name='eSource']").forEach((el) => el.addEventListener("change", () => { updatePool(); updateByExamCounts(); }));
  const byExamEl = document.getElementById("eByExam");
  if (byExamEl) {
    byExamEl.addEventListener("change", updateByExamTotal);
    byExamEl.addEventListener("input", updateByExamTotal);
  }
  updatePool();
  updateByExamCounts();
  updateByExamTotal();
  document.getElementById("eCreate").addEventListener("click", create);
  document.getElementById("eCreateByExam").addEventListener("click", createByExam);
  document.getElementById("eCreateTpl").addEventListener("click", async () => {
    const tplId = document.getElementById("eTpl").value;
    if (!tplId) { document.getElementById("eTplMsg").textContent = "暫時未有模板，請管理員喺下面新增。"; return; }
    try {
      const r = await api("/api/exams", { method: "POST", body: { template_id: Number(tplId), title: document.getElementById("eTitle").value } });
      if (r.note) alert(r.note);
      openExam(r.exam_id);
    } catch (e) { document.getElementById("eTplMsg").textContent = e.message; }
  });
  if (isAdmin) {
    renderTemplateList();
    if (exams.length > 0) {
      addRuleRow();
      document.getElementById("tAddRule").addEventListener("click", () => addRuleRow());
      document.getElementById("tSave").addEventListener("click", saveTemplate);
      document.getElementById("tCancelEdit").addEventListener("click", () => {
        editingTemplateId = null;
        document.getElementById("tTitle").value = "";
        document.getElementById("tRules").innerHTML = "";
        addRuleRow();
        document.getElementById("tSave").textContent = "新增模板";
        document.getElementById("tCancelEdit").style.display = "none";
        document.getElementById("tMsg").textContent = "";
      });
      const buildAll = async (n) => {
        const msgEl = document.getElementById("tMsg");
        const config = exams.map((e) => ({ exam: e, count: n, difficulties: [], source: "all" }));
        try {
          await api("/api/templates", { method: "POST", body: { title: "全考試各" + n + "題", config } });
          msgEl.textContent = "已建立「全考試各" + n + "題」模板（" + exams.length + " 個考試、合共 " + (exams.length * n) + " 題）。";
          await refreshTemplates();
        } catch (e) { msgEl.textContent = e.message; }
      };
      document.getElementById("tAll1").addEventListener("click", () => buildAll(1));
      document.getElementById("tAll2").addEventListener("click", () => buildAll(2));
    }
  }
  m.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openExam(Number(b.dataset.open))));
  m.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { if (confirm("確定刪除呢份考卷？連同答題紀錄都會一併清除。")) { await api("/api/exams/" + b.dataset.del, { method: "DELETE" }); showView("exam"); } }));
}
async function openExam(id) {
  const d = await api("/api/exams/" + id);
  if (d.exam.status === "已完成") { await showReport(id); return; }
  // 繼續作答先叫 resume：將暫停咗嘅時間由計時入面扣返出嚟
  let live = d;
  try { live = await api("/api/exams/" + id + "/resume", { method: "POST", body: {} }); } catch (e) {}
  examState = { id, exam: live.exam, questions: live.questions, answers: live.answers || {}, marked: live.marked || [], idx: live.firstUnanswered >= 0 ? live.firstUnanswered : 0, savedAt: "", saveFail: false };
  renderExamPage();
}
async function saveProgress() {
  if (!examState) return;
  try {
    const d = await api("/api/exams/" + examState.id + "/progress", { method: "POST", body: { answers: examState.answers, marked: examState.marked } });
    examState.savedAt = new Date(d.saved_at).toLocaleTimeString();
    examState.saveFail = false;
  } catch (e) { examState.saveFail = true; }
  updateStatusBar();
}
function fmtTime(sec) { const m = Math.floor(sec / 60), s = sec % 60; return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); }
let examTimer = null;
function renderExamPage() {
  if (examTimer) { clearInterval(examTimer); examTimer = null; }
  const m = mainEl();
  const st = examState;
  const startMs = new Date(st.exam.start_time).getTime();
  function tick() { const el = document.getElementById("exTimer"); if (el) el.textContent = fmtTime(Math.max(0, Math.floor((Date.now() - startMs) / 1000))); }
  examTimer = setInterval(tick, 1000);
  function draw() {
    const q = st.questions[st.idx];
    const total = st.questions.length;
    const answered = st.questions.filter((x) => st.answers[x.question_id] != null && st.answers[x.question_id] !== "").length;
    const markedN = st.marked.length;
    m.innerHTML = '<div class="card"><h2>' + esc(st.exam.title) + '</h2><div class="muted">第 ' + (st.idx + 1) + ' / ' + total + ' 題</div>' +
      '<div class="qnav">' + st.questions.map((x, i) => '<button data-i="' + i + '" class="' + (st.answers[x.question_id] ? "done" : "") + (st.marked.includes(x.question_id) ? " marked" : "") + (i === st.idx ? " cur" : "") + '">' + (i + 1) + '</button>').join("") + '</div>' +
      (q ? '<h3>' + esc(q.content) + '</h3>' + mediaHtml(q) + q.options.map((o, i) => { const L = String.fromCharCode(65 + i); if (q.type === "多選") return '<label><input type="checkbox" class="eOpt" value="' + L + '" ' + ((st.answers[q.question_id] || "").includes(L) ? "checked" : "") + '> ' + L + '. ' + esc(o) + optionMediaHtml(q, L) + '</label>'; return '<button class="opt ' + (st.answers[q.question_id] === L ? "sel" : "") + '" data-v="' + L + '">' + L + '. ' + esc(o) + optionMediaHtml(q, L) + '</button>'; }).join("") : '<p>呢份卷冇題目。</p>') +
      '<p><button id="eMark">' + (q && st.marked.includes(q.question_id) ? "取消待檢查" : "標記待檢查") + '</button> <button id="ePrev">上一題</button> <button id="eNext">下一題</button> <button class="primary" id="eSubmit">交卷</button> <button id="eLeave">暫停離開</button></p></div>' +
      '<div class="statusbar"><span>⏱ <span id="exTimer">--:--</span></span><span>已答 ' + answered + ' / ' + total + '</span><span>未答 ' + (total - answered) + '</span><span>待檢查 ' + markedN + '</span><span id="exSaved">' + (st.saveFail ? "自動暫存失敗，請檢查網絡再試" : (st.savedAt ? "答案已自動暫存 " + st.savedAt : "")) + '</span><span class="spacer"></span><button class="primary" id="eSubmit2">交卷</button></div>';
    tick();
    m.querySelectorAll(".qnav button").forEach((b) => b.addEventListener("click", () => { st.idx = Number(b.dataset.i); draw(); }));
    m.querySelectorAll("button.opt").forEach((b) => b.addEventListener("click", () => { st.answers[q.question_id] = b.dataset.v; saveProgress(); draw(); }));
    m.querySelectorAll(".eOpt").forEach((c) => c.addEventListener("change", () => {
      const vals = Array.from(m.querySelectorAll(".eOpt:checked")).map((x) => x.value).sort().join("");
      st.answers[q.question_id] = vals; saveProgress(); draw();
    }));
    document.getElementById("eMark").addEventListener("click", () => {
      const i = st.marked.indexOf(q.question_id);
      if (i >= 0) st.marked.splice(i, 1); else st.marked.push(q.question_id);
      saveProgress(); draw();
    });
    document.getElementById("ePrev").addEventListener("click", () => { if (st.idx > 0) { st.idx--; draw(); } });
    document.getElementById("eNext").addEventListener("click", () => { if (st.idx < total - 1) { st.idx++; draw(); } });
    document.getElementById("eLeave").addEventListener("click", async () => { await saveProgress(); if (examTimer) clearInterval(examTimer); showView("exam"); });
    const submit = async () => {
      const unanswered = st.questions.filter((x) => !st.answers[x.question_id]).length;
      if (unanswered > 0 && !confirm("仲有 " + unanswered + " 題未答，確定交卷？")) return;
      await saveProgress();
      const r = await api("/api/exams/" + st.id + "/submit", { method: "POST", body: {} });
      if (examTimer) clearInterval(examTimer);
      await showReport(st.id);
    };
    document.getElementById("eSubmit").addEventListener("click", submit);
    document.getElementById("eSubmit2").addEventListener("click", submit);
  }
  draw();
}
function updateStatusBar() {
  const el = document.getElementById("exSaved");
  if (!el || !examState) return;
  el.textContent = examState.saveFail ? "自動暫存失敗，請檢查網絡再試" : (examState.savedAt ? "答案已自動暫存 " + examState.savedAt : "");
}
async function showReport(id) {
  const m = mainEl();
  const d = await api("/api/exams/" + id + "/report");
  const wrong = d.items.filter((i) => !i.is_correct).length;
  m.innerHTML = '<div class="card"><h2>成績報告：' + esc(d.exam.title) + '</h2><p>總分：' + d.exam.score + ' / ' + d.exam.total_questions + '，答錯 ' + wrong + ' 題' + (d.exam.duration_sec != null ? '，用時 ' + fmtTime(d.exam.duration_sec) : "") + '</p><p><button id="backE">返去模擬考列表</button> <button id="goW2">去錯題本</button></p></div>' +
    d.items.map((it, i) => it.deleted
      ? '<div class="card"><div><b>' + (it.is_correct ? "✓ 答對" : "✗ 答錯") + '</b> 第 ' + (i + 1) + ' 題 · 題目已刪除</div><p class="muted">呢條題目已經喺題庫刪除，題幹同解析睇唔返，成績分數維持不變。</p><p>你嘅答案：' + esc(it.user_answer || "（未答）") + '</p></div>'
      : '<div class="card"><div><b>' + (it.is_correct ? "✓ 答對" : "✗ 答錯") + '</b> 第 ' + (i + 1) + ' 題</div>' + qCard(it.question, true) + '<p>你嘅答案：' + esc(it.user_answer || "（未答）") + '</p></div>').join("");
  document.getElementById("backE").addEventListener("click", () => showView("exam"));
  document.getElementById("goW2").addEventListener("click", () => showView("wrong"));
}

// ---------- 題庫管理 ----------
async function viewQuestions() {
  if (me.role !== "admin") { mainEl().innerHTML = '<div class="card"><p>只有管理員先可以用題庫管理。</p></div>'; return; }
  const m = mainEl();
  m.innerHTML = '<div class="card"><h2>題庫管理</h2><div style="display:flex;gap:8px;flex-wrap:wrap"><input id="qSearch" placeholder="關鍵字或者編號" style="flex:2;min-width:160px"><select id="qExamF" style="flex:1"><option value="">全部考試</option></select><select id="qTypeF" style="flex:1"><option value="">全部題型</option><option>單選</option><option>多選</option><option>判斷</option><option>簡答</option></select><select id="qDiffF" style="flex:1"><option value="">全部難度</option><option>簡單</option><option>中等</option><option>困難</option></select></div><p><button class="primary" id="qFilter">篩選</button> <button id="qAdd">新增題目</button> <span id="qMsg" class="muted"></span></p></div>' +
    '<div class="card"><h2>CSV 批次匯入</h2><p><button id="tplDl">⬇ 下載 CSV 範本（含示例）</button> <button id="tplView">睇範本內容</button> <button id="tplCopy">一鍵複製範本</button></p><p class="muted">範本用 exam 欄位，值係 VTS 或者 430，入面有 4 行示例（單選、多選、判斷、簡答各一），匯入前要刪走示例行。匯入同時兼容舊 chapter / 章節欄位名。media 欄可以留空；有連結用 ; 分隔，前面加前綴指定位置（stem:題幹、optB:選項 B、explanation:解析，唔寫前綴當題幹），例如 stem:https://…/圖.jpg;optB:https://…/圖.png。</p><div id="tplArea"></div><label>或者揀一個 CSV 檔案（會自動讀入下面個格）</label><input type="file" id="csvFile" accept=".csv,text/csv"><label>直接貼上 CSV 內容</label><textarea id="csvText" placeholder="貼上 CSV 內容，欄位：question_id,type,content,options,answer,explanation,exam,difficulty,media"></textarea><label>重複編號處理</label><select id="csvMode"><option value="skip">跳過</option><option value="overwrite">覆蓋</option></select><p><button class="primary" id="csvGo">匯入</button> <span id="csvMsg" class="muted"></span></p><div id="csvErr"></div></div>' +
    '<div class="card"><h2>批量管理</h2><p><button id="selPage">全選今頁</button> <button id="selAll">全選篩選結果</button> <button id="selNone">取消全選</button> <span id="selCount" class="muted">已選 0 題</span></p><p><button id="batchDel" class="danger">批量刪除</button> <button id="batchExam">批量改分類</button> <button id="batchDiff">批量改難度</button> <button id="expQ">⬇ 匯出題目 CSV（目前篩選）</button> <span id="batchMsg" class="muted"></span></p><p class="muted">批量刪除會一併清除呢啲題目嘅答題紀錄、收藏同相關留言；新開嘅模擬考有題目快照，刪題唔會影響佢嘅成績報告，淨係冇快照嘅舊卷先會顯示「題目已刪除」，分數維持不變。列表一次最多顯示 500 題，所以全選篩選結果只會揀到已載入嗰 500 題，題庫大嗰陣請先用篩選縮小範圍。</p></div>' +
    '<div id="qList"></div>';
  let qSelected = new Set();
  let loadedQs = [];
  let exams = [];
  try { exams = (await api("/api/questions/exams")).exams; } catch (e) {}
  const sel = document.getElementById("qExamF");
  exams.forEach((e) => { const o = document.createElement("option"); o.textContent = e; sel.appendChild(o); });
  const tplText = "question_id,type,content,options,answer,explanation,exam,difficulty,media\nDEMO-001,單選,避碰規則：兩船對遇時，邊一邊應該讓路？,左舷讓路|右舷讓路|直航船讓路|兩船同時轉向,A,對遇局面，兩船都應該向右轉，互相從左舷通過。,VTS,簡單,stem:https://example.com/eg-ship.jpg\nDEMO-002,多選,以下邊啲屬於 VTS 服務範圍？,船舶交通組織|助航服務|危險品監控|天氣預報,ABC,VTS 提供交通組織、助航同危險品監控，天氣預報唔係 VTS 本身服務。,VTS,中等,\nDEMO-003,判斷,追越船必須讓路給被追越船。,正確|錯誤,正確,追越船係讓路船，必須避讓被追越船。,VTS,簡單,optA:https://example.com/eg-yes.jpg\nDEMO-004,簡答,請簡述 VHF 第 16 頻道嘅用途。,,第 16 頻道係國際遇險、緊急同呼叫頻道，用於遇險求救同建立聯絡，聯絡好之後要轉去工作頻道通話，唔好長期佔用。,第 16 頻道係國際遇險、緊急同呼叫頻道，用於遇險求救同建立聯絡，聯絡好之後要轉去工作頻道通話，唔好長期佔用。,VTS,中等,explanation:https://example.com/eg-ch16.mp4";
  document.getElementById("tplDl").addEventListener("click", () => {
    const blob = new Blob(["\ufeff" + tplText], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "exam-template.csv"; a.click();
  });
  document.getElementById("tplView").addEventListener("click", () => { document.getElementById("tplArea").innerHTML = '<pre style="white-space:pre-wrap;background:var(--chip);padding:10px;border-radius:8px">' + esc(tplText) + '</pre>'; });
  document.getElementById("tplCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(tplText); document.getElementById("csvMsg").textContent = "已複製範本。"; } catch (e) { document.getElementById("csvMsg").textContent = "複製唔到，請用睇範本內容再手動複製。"; } });
  document.getElementById("csvGo").addEventListener("click", async () => {
    const csv = document.getElementById("csvText").value;
    try {
      const d = await api("/api/questions/import", { method: "POST", body: { csv, mode: document.getElementById("csvMode").value } });
      document.getElementById("csvMsg").textContent = "匯入完成：成功 " + d.imported + " 題，跳過 " + d.skipped + " 題，覆蓋 " + d.overwritten + " 題。";
      document.getElementById("csvErr").innerHTML = d.errors.length ? d.errors.map((e) => '<p class="muted">• ' + esc(e) + '</p>').join("") : "";
      loadList();
    } catch (e) { document.getElementById("csvMsg").textContent = e.message; }
  });
  document.getElementById("csvFile").addEventListener("change", async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    try { document.getElementById("csvText").value = await f.text(); document.getElementById("csvMsg").textContent = "已讀入「" + f.name + "」，檢查無誤就可以撳匯入。"; }
    catch (e) { document.getElementById("csvMsg").textContent = "讀唔到呢個檔案，請改用貼上 CSV 內容。"; }
  });
  function updateSelCount() {
    const el = document.getElementById("selCount");
    if (el) el.textContent = "已選 " + qSelected.size + " 題";
  }
  function currentFilters() {
    return { q: document.getElementById("qSearch").value, exam: document.getElementById("qExamF").value, type: document.getElementById("qTypeF").value, difficulty: document.getElementById("qDiffF").value };
  }
  async function refreshExamOptions() {
    try {
      const ex = (await api("/api/questions/exams")).exams;
      const sel = document.getElementById("qExamF");
      const cur = sel.value;
      sel.innerHTML = '<option value="">全部考試</option>' + ex.map((e) => '<option>' + esc(e) + '</option>').join("");
      if (ex.includes(cur)) sel.value = cur;
    } catch (e) {}
  }
  async function loadList() {
    const f = currentFilters();
    const d = await api("/api/questions?exam=" + encodeURIComponent(f.exam) + "&difficulty=" + encodeURIComponent(f.difficulty) + "&type=" + encodeURIComponent(f.type) + "&q=" + encodeURIComponent(f.q));
    loadedQs = d.questions;
    const list = document.getElementById("qList");
    updateSelCount();
    if (d.questions.length === 0) { list.innerHTML = '<div class="card"><p class="muted">暫時未有題目，請新增或者匯入。</p></div>'; return; }
    const totalTxt = (d.total != null ? "共 " + d.total + " 題" : "") + (d.total != null && d.total > d.questions.length ? "，只顯示首 " + d.questions.length + " 題，請用篩選縮小範圍" : "");
    list.innerHTML = (totalTxt ? '<p class="muted">' + totalTxt + '</p>' : "") + d.questions.map((qq) => '<div class="card"><p><label><input type="checkbox" class="qSel" data-id="' + esc(qq.question_id) + '"' + (qSelected.has(qq.question_id) ? " checked" : "") + '> 勾選呢題</label></p><div><span class="pill">' + esc(qq.exam) + '</span><span class="pill">' + esc(qq.type) + '</span><span class="pill">' + esc(qq.difficulty) + '</span><span class="pill">' + esc(qq.question_id) + '</span></div><h3>' + esc(qq.content) + '</h3><p><button data-edit="' + esc(qq.question_id) + '">修改</button> <button data-prev="' + esc(qq.question_id) + '">預覽</button> <button data-del="' + esc(qq.question_id) + '" class="danger">刪除</button></p></div>').join("");
    list.querySelectorAll(".qSel").forEach((c) => c.addEventListener("change", () => {
      if (c.checked) qSelected.add(c.dataset.id); else qSelected.delete(c.dataset.id);
      updateSelCount();
    }));
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { if (confirm("確定刪除 " + b.dataset.del + "？答題紀錄、收藏同相關留言都會一併清除。")) { qSelected.delete(b.dataset.del); await api("/api/questions/" + encodeURIComponent(b.dataset.del), { method: "DELETE" }); await refreshExamOptions(); loadList(); } }));
    list.querySelectorAll("[data-prev]").forEach((b) => b.addEventListener("click", async () => { const dd = await api("/api/questions/" + encodeURIComponent(b.dataset.prev)); openModal(qCard(dd.question, true) + '<p><button id="mClose">關閉</button></p>'); document.getElementById("mClose").addEventListener("click", closeModal); }));
    list.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", async () => { const dd = await api("/api/questions/" + encodeURIComponent(b.dataset.edit)); openQForm(dd.question); }));
  }
  function selectedIds() { return Array.from(qSelected); }
  document.getElementById("selPage").addEventListener("click", () => { loadedQs.forEach((qq) => qSelected.add(qq.question_id)); loadList(); });
  document.getElementById("selAll").addEventListener("click", async () => {
    // 列表本身一次過顯示全部篩選結果（冇分頁），所以全選篩選結果即係全選已載入嘅題
    loadedQs.forEach((qq) => qSelected.add(qq.question_id));
    loadList();
  });
  document.getElementById("selNone").addEventListener("click", () => { qSelected.clear(); loadList(); });
  document.getElementById("batchDel").addEventListener("click", async () => {
    const ids = selectedIds();
    if (ids.length === 0) { document.getElementById("batchMsg").textContent = "請先勾選要刪除嘅題目。"; return; }
    if (!confirm("確定刪除已選嘅 " + ids.length + " 題？呢啲題目嘅答題紀錄、收藏同相關留言都會一併清除，唔可以復原。")) return;
    try {
      const d = await api("/api/questions/batch-delete", { method: "POST", body: { ids } });
      ids.forEach((id) => qSelected.delete(id));
      document.getElementById("batchMsg").textContent = "已刪除 " + d.deleted + " 題，一併清除答題紀錄 " + d.answersRemoved + " 條、收藏 " + d.favoritesRemoved + " 個。";
      await refreshExamOptions();
      loadList();
    } catch (e) { document.getElementById("batchMsg").textContent = e.message; }
  });
  function openBatchUpdate(field) {
    const ids = selectedIds();
    if (ids.length === 0) { document.getElementById("batchMsg").textContent = "請先勾選要修改嘅題目。"; return; }
    const isExam = field === "exam";
    openModal('<h2>批量改' + (isExam ? "分類" : "難度") + '</h2><p class="muted">已選 ' + ids.length + ' 題。</p>' +
      (isExam
        ? '<label>新分類（自由填寫）</label><input id="bVal" list="batchExamList" placeholder="例如：VTS"><datalist id="batchExamList">' + exams.map((e) => '<option value="' + esc(e) + '">').join("") + '</datalist>'
        : '<label>新難度</label><select id="bVal"><option>簡單</option><option>中等</option><option>困難</option></select>') +
      '<p><button class="primary" id="bGo">確定修改</button> <button id="bCancel">取消</button></p><p id="bMsg" class="muted"></p>');
    document.getElementById("bCancel").addEventListener("click", closeModal);
    document.getElementById("bGo").addEventListener("click", async () => {
      const body = { ids };
      body[field] = document.getElementById("bVal").value;
      try {
        const d = await api("/api/questions/batch-update", { method: "POST", body });
        closeModal();
        document.getElementById("batchMsg").textContent = "已更新 " + d.updated + " 題。";
        await refreshExamOptions();
        loadList();
      } catch (e) { document.getElementById("bMsg").textContent = e.message; }
    });
  }
  document.getElementById("batchExam").addEventListener("click", () => openBatchUpdate("exam"));
  document.getElementById("batchDiff").addEventListener("click", () => openBatchUpdate("difficulty"));
  document.getElementById("expQ").addEventListener("click", async () => {
    try {
      const f = currentFilters();
      await downloadFile("/api/admin/export/questions?exam=" + encodeURIComponent(f.exam) + "&difficulty=" + encodeURIComponent(f.difficulty) + "&type=" + encodeURIComponent(f.type) + "&q=" + encodeURIComponent(f.q), "questions.csv");
    } catch (e) { document.getElementById("batchMsg").textContent = e.message; }
  });
  document.getElementById("qFilter").addEventListener("click", loadList);
  document.getElementById("qAdd").addEventListener("click", () => openQForm(null));
  // 由學生表現分析「去題庫」跳過嚟：用該題號預設篩選
  if (pendingQSearch) { document.getElementById("qSearch").value = pendingQSearch; pendingQSearch = ""; }
  function openQForm(q) {
    const isNew = !q;
    const qq = q || { question_id: "", type: "單選", content: "", options: ["", "", "", ""], answer: "", explanation: "", exam: "VTS", difficulty: "中等" };
    openModal('<h2>' + (isNew ? "新增題目" : "修改題目") + '</h2>' +
      '<label>編號 question_id</label><input id="fId" value="' + esc(qq.question_id) + '" ' + (isNew ? "" : "disabled") + '>' +
      '<label>題型</label><select id="fType"><option>單選</option><option>多選</option><option>判斷</option><option>簡答</option></select>' +
      '<label>題幹</label><textarea id="fContent">' + esc(qq.content) + '</textarea>' +
      '<label>選項（每行一個，判斷題請填兩個，例如 正確、錯誤）</label><textarea id="fOpts">' + esc(qq.options.join("\n")) + '</textarea>' +
      '<label>答案（單選一個字母，多選例如 AC，判斷填選項文字）</label><input id="fAns" value="' + esc(qq.answer) + '">' +
      '<label>解析</label><textarea id="fExp">' + esc(qq.explanation) + '</textarea>' +
      '<label>考試（自由填寫，建議：VTS、430）</label><input id="fExam" list="examList" value="' + esc(qq.exam) + '"><datalist id="examList">' + Array.from(new Set([...exams, "VTS", "430"])).map((e) => '<option value="' + esc(e) + '">').join("") + '</datalist>' +
      '<label>難度</label><select id="fDiff"><option>簡單</option><option>中等</option><option>困難</option></select>' +
      '<h3>題目圖片／影片（最多 5 個）</h3>' +
      '<p class="muted">圖片可以放題幹或者選項（例如選項 B 係一幅圖），影片主要放解析（例如一條短片講點解答案係咁），解析都可以加圖片。圖片唔多過 5 MB、影片唔多過 20 MB；只接受 jpg / png / gif / webp、mp4 / webm / mov。</p>' +
      '<label>放邊度</label><select id="fMediaPlace"><option value="stem">題幹</option><option value="explanation">解析</option></select>' +
      '<label>上傳檔案（可以一次揀多個，手機會彈出影相／揀相／拍片）</label><input type="file" id="fFile" accept="image/*,video/*" multiple>' +
      '<p><button id="fUpload">上傳所選檔案</button> <span id="fUpMsg" class="muted"></span></p>' +
      '<label>或者貼外部連結</label><div style="display:flex;gap:8px"><input id="fMediaUrl" placeholder="https://…/圖片.jpg 或者影片.mp4" style="flex:1"><button id="fAddUrl">加入連結</button></div>' +
      '<div id="fMediaList"></div>' +
      '<p><button class="primary" id="fSave">儲存</button> <button id="fCancel">取消</button></p><p id="fMsg" class="muted"></p>');
    document.getElementById("fType").value = qq.type;
    document.getElementById("fDiff").value = qq.difficulty;
    // ---------- 題目媒體 ----------
    let formMedia = Array.isArray(qq.media) ? qq.media.map((x) => ({ type: x.type === "video" ? "video" : "image", url: String(x.url), place: ["stem", "explanation", "option"].includes(x.place) ? x.place : "stem", option: x.place === "option" ? String(x.option || "").toUpperCase() : undefined })).filter((x) => x.url) : [];
    function placeLabel(x) {
      if (x.place === "explanation") return "解析";
      if (x.place === "option") return "選項 " + (x.option || "?");
      return "題幹";
    }
    function renderFormMedia() {
      const el = document.getElementById("fMediaList");
      if (!el) return;
      el.innerHTML = formMedia.length === 0 ? '<p class="muted">暫時未加媒體。</p>' : formMedia.map((x, i) => '<div class="media-item"><span class="pill">' + placeLabel(x) + '</span><span class="pill">' + (x.type === "video" ? "影片" : "圖片") + '</span><span class="media-url">' + esc(x.url) + '</span><button data-mi="' + i + '">移除</button></div>').join("");
      el.querySelectorAll("[data-mi]").forEach((b) => b.addEventListener("click", () => { formMedia.splice(Number(b.dataset.mi), 1); renderFormMedia(); }));
    }
    // 放邊度嘅選項字母數目，跟住選項行數即時變（選項得 4 行就淨係俾揀 A 至 D）。
    function refreshMediaPlaceOptions() {
      const sel = document.getElementById("fMediaPlace");
      if (!sel) return;
      const cur = sel.value;
      const n = Math.max(0, document.getElementById("fOpts").value.split("\n").map((s) => s.trim()).filter(Boolean).length);
      let html = '<option value="stem">題幹</option><option value="explanation">解析</option>';
      for (let i = 0; i < Math.min(n, 26); i++) { const L = String.fromCharCode(65 + i); html += '<option value="option:' + L + '">選項 ' + L + '</option>'; }
      sel.innerHTML = html;
      if (cur && Array.from(sel.options).some((o) => o.value === cur)) sel.value = cur;
    }
    function currentPlace() {
      const v = document.getElementById("fMediaPlace").value;
      if (v === "explanation") return { place: "explanation" };
      if (v.indexOf("option:") === 0) return { place: "option", option: v.slice(7) };
      return { place: "stem" };
    }
    async function uploadMediaFile(f) {
      const fd = new FormData();
      fd.append("file", f);
      const token = storage.get("exam_token");
      const res = await fetch("/api/upload", { method: "POST", headers: { "Authorization": "Bearer " + token }, body: fd });
      let data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error(data.error || ("上傳失敗（" + res.status + "）。"));
      return data;
    }
    document.getElementById("fOpts").addEventListener("input", refreshMediaPlaceOptions);
    document.getElementById("fUpload").addEventListener("click", async () => {
      const files = Array.from(document.getElementById("fFile").files || []);
      const msgEl = document.getElementById("fUpMsg");
      if (files.length === 0) { msgEl.textContent = "請先揀檔案。"; return; }
      msgEl.textContent = "上傳緊 " + files.length + " 個檔案…";
      let ok = 0;
      for (const f of files) {
        if (formMedia.length >= 5) { msgEl.textContent = "每條題目最多 5 個媒體，已經加滿。"; break; }
        try { const d = await uploadMediaFile(f); const p = currentPlace(); formMedia.push({ type: d.type, url: d.url, place: p.place, option: p.option }); ok++; }
        catch (e) { msgEl.textContent = "「" + f.name + "」上傳失敗：" + e.message; renderFormMedia(); return; }
      }
      document.getElementById("fFile").value = "";
      renderFormMedia();
      msgEl.textContent = ok > 0 ? "已上傳 " + ok + " 個檔案。" : "";
    });
    document.getElementById("fAddUrl").addEventListener("click", () => {
      const url = document.getElementById("fMediaUrl").value.trim();
      const msgEl = document.getElementById("fUpMsg");
      if (!url) return;
      if (formMedia.length >= 5) { msgEl.textContent = "每條題目最多 5 個媒體，已經加滿。"; return; }
      if (!/^https?:\/\/[^/]+/i.test(url) && url.indexOf("/uploads/") !== 0) { msgEl.textContent = "連結唔啱：淨係接受 /uploads/ 或者 http(s) 連結。"; return; }
      const ext = url.split("?")[0].split("#")[0].toLowerCase();
      const type = /\.(mp4|webm|mov)$/.test(ext) ? "video" : "image";
      const p = currentPlace();
      formMedia.push({ type, url, place: p.place, option: p.option });
      document.getElementById("fMediaUrl").value = "";
      msgEl.textContent = "";
      renderFormMedia();
    });
    refreshMediaPlaceOptions();
    renderFormMedia();
    document.getElementById("fCancel").addEventListener("click", closeModal);
    document.getElementById("fSave").addEventListener("click", async () => {
      const body = { question_id: document.getElementById("fId").value, type: document.getElementById("fType").value, content: document.getElementById("fContent").value, options: document.getElementById("fOpts").value.split("\n").map((s) => s.trim()).filter(Boolean), answer: document.getElementById("fAns").value, explanation: document.getElementById("fExp").value, exam: document.getElementById("fExam").value, difficulty: document.getElementById("fDiff").value, media: formMedia };
      try {
        if (isNew) await api("/api/questions", { method: "POST", body });
        else await api("/api/questions/" + encodeURIComponent(qq.question_id), { method: "PUT", body });
        closeModal();
        document.getElementById("qSearch").value = ""; document.getElementById("qExamF").value = ""; document.getElementById("qTypeF").value = ""; document.getElementById("qDiffF").value = "";
        document.getElementById("qMsg").textContent = "已儲存 " + body.question_id + "。";
        loadList();
      } catch (e) { document.getElementById("fMsg").textContent = e.message; }
    });
  }
  await loadList();
}

// ---------- 帳號管理 ----------
async function viewAccounts() {
  if (me.role !== "admin") { mainEl().innerHTML = '<div class="card"><p>只有管理員先可以用帳號管理。</p></div>'; return; }
  const m = mainEl();
  const d = await api("/api/admin/users");
  m.innerHTML = '<div class="card"><h2>帳號管理</h2><p><button id="expU">⬇ 匯出學生帳號 CSV</button> <span id="accMsg" class="muted"></span></p><p class="muted">帳號 CSV 包含帳號、角色、建立日期、答題數同正確率，唔包含密碼雜湊。</p>' + d.users.map((u) => '<p><b>' + esc(u.username) + '</b> · ' + esc(u.role) + ' <button data-role="' + u.user_id + '" data-to="' + (u.role === "admin" ? "user" : "admin") + '">' + (u.role === "admin" ? "降級做考生" : "升級做管理員") + '</button></p>').join("") + '</div>';
  document.getElementById("expU").addEventListener("click", async () => { try { await downloadFile("/api/admin/export/users", "users.csv"); } catch (e) { document.getElementById("accMsg").textContent = e.message; } });
  m.querySelectorAll("[data-role]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("/api/admin/users/" + b.dataset.role + "/role", { method: "POST", body: { role: b.dataset.to } }); showView("accounts"); }
    catch (e) { alert(e.message); }
  }));
}

// ---------- 啟動 ----------
render();

