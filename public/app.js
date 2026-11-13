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
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

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
    formEl.innerHTML = '<label>帳號</label><input id="aUser" autocomplete="username"><label>密碼（至少 4 個字）</label><input id="aPass" type="password" autocomplete="new-password"><label>確認密碼</label><input id="aPass2" type="password" autocomplete="new-password"><button class="primary" id="aGo">' + (first ? '建立管理員並登入' : '註冊並登入') + '</button>';
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
  openModal('<h2>改密碼</h2><label>舊密碼</label><input id="oldPw" type="password"><label>新密碼</label><input id="newPw" type="password"><p><button class="primary" id="pwGo">儲存</button> <button id="pwCancel">取消</button></p><p id="pwMsg" class="muted"></p>');
  document.getElementById("pwCancel").addEventListener("click", closeModal);
  document.getElementById("pwGo").addEventListener("click", async () => {
    try { await api("/api/auth/change-password", { method: "POST", body: { oldPassword: document.getElementById("oldPw").value, newPassword: document.getElementById("newPw").value } }); closeModal(); alert("密碼已改。"); }
    catch (e) { document.getElementById("pwMsg").textContent = e.message; }
  });
}
function optLetters(q) { return q.options.map((_, i) => String.fromCharCode(65 + i)); }
function qCard(q, showAnswer) {
  return '<div class="card"><div><span class="pill">' + esc(q.exam) + '</span><span class="pill">' + esc(q.type) + '</span><span class="pill">' + esc(q.difficulty) + '</span><span class="pill">' + esc(q.question_id) + '</span></div><h3>' + esc(q.content) + '</h3>' +
    q.options.map((o, i) => '<div>' + String.fromCharCode(65 + i) + '. ' + esc(o) + '</div>').join("") +
    (showAnswer ? '<details class="explain"><summary>解析（撳開睇）</summary><p>答案：' + esc(q.answer || "") + '</p><p>' + esc(q.explanation || "") + '</p></details>' : "") + '</div>';
}

// ---------- 儀表板 ----------
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
      '<h3>各考試題目分佈</h3>' + (a.byExam.length === 0 ? '<p class="muted">題庫暫時係空。</p>' : a.byExam.map((x) => '<div class="bar-row"><div class="lbl"><span>' + esc(x.exam) + '</span><span>' + x.n + ' 題</span></div><div class="bar blue"><div style="width:' + Math.max(4, Math.round((x.n / maxN) * 100)) + '%"></div></div></div>').join("")) + '</div>';
  }
  const trend = stats.trend.map((t) => esc(t.title) + "：" + t.score + "/" + t.total_questions).join("、") || "暫時未完成任何模擬考。";
  m.innerHTML = '<h2>我嘅學習概況</h2><div class="grid4">' +
    '<div class="stat"><div class="k">累計答題</div><div class="v">' + stats.total + '</div></div>' +
    '<div class="stat"><div class="k">整體正確率</div><div class="v">' + stats.accuracy + '%</div><div class="muted">答對 ' + stats.correct + ' 題</div></div>' +
    '<div class="stat"><div class="k">錯題本</div><div class="v">' + stats.wrong + ' 題</div><div class="muted">曾經答錯嘅題目</div></div>' +
    '<div class="stat"><div class="k">已完成模擬考</div><div class="v">' + stats.examsDone + ' 份</div></div></div>' +
    '<div class="card"><p><button class="primary" id="goP">開始刷題</button> <button id="goE">開新模擬考</button> <button id="goW">去錯題本</button></p>' +
    '<h3>各考試正確率</h3>' + (stats.perExam.length === 0 ? '<p class="muted">暫時未有答題紀錄。</p>' : stats.perExam.map((x) => { const acc = x.total ? Math.round((x.correct / x.total) * 100) : 0; return '<div class="bar-row"><div class="lbl"><span>' + esc(x.exam) + '</span><span>' + x.correct + '/' + x.total + ' · ' + acc + '%</span></div><div class="bar"><div style="width:' + acc + '%"></div></div></div>'; }).join("")) +
    '<h3>歷次模擬考分數趨勢</h3><p class="muted">' + trend + '</p></div>' + adminHtml;
  document.getElementById("goP").addEventListener("click", () => showView("practice"));
  document.getElementById("goE").addEventListener("click", () => showView("exam"));
  document.getElementById("goW").addEventListener("click", () => showView("wrong"));
}

// ---------- 刷題 ----------
let practiceState = { list: [], idx: 0, drawn: [], answered: false, last: null, favs: new Set() };
async function viewPractice() {
  const m = mainEl();
  let exams = [];
  try { exams = (await api("/api/questions/exams")).exams; } catch (e) {}
  m.innerHTML = '<div class="card"><h2>刷題模式</h2><div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<select id="pExam" style="flex:1;min-width:120px"><option value="">全部考試</option>' + exams.map((e) => '<option>' + esc(e) + '</option>').join("") + '<option value="VTS">VTS</option><option value="430">430</option></select>' +
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
    '<h3>' + esc(q.content) + '</h3>' +
    (q.type === "簡答" ? '<textarea id="pAns" placeholder="寫低你嘅答案"></textarea>' : q.options.map((o, i) => { const L = String.fromCharCode(65 + i); if (q.type === "多選") return '<label><input type="checkbox" class="pOpt" value="' + L + '"> ' + L + '. ' + esc(o) + '</label>'; return '<button class="opt" data-v="' + L + '">' + L + '. ' + esc(o) + '</button>'; }).join("")) +
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
    let ua = "";
    if (q.type === "簡答") ua = document.getElementById("pAns").value;
    else if (q.type === "多選") ua = Array.from(area.querySelectorAll(".pOpt:checked")).map((x) => x.value).sort().join("");
    else { const sel = area.querySelector("button.opt.sel"); ua = sel ? sel.dataset.v : ""; }
    if (!ua) { document.getElementById("pResult").innerHTML = '<p class="muted">請先揀答案。</p>'; return; }
    try {
      const d = await api("/api/practice/answer", { method: "POST", body: { question_id: q.question_id, user_answer: ua } });
      const res = document.getElementById("pResult");
      if (q.type === "簡答") {
        res.innerHTML = '<details class="explain" open><summary>參考答案</summary><p>' + esc(d.reference || "") + '</p><p>' + esc(d.explanation || "") + '</p></details><p>你覺得自己答啱定答錯？ <button id="selfOk">我答對了</button> <button id="selfNo">我答錯了</button></p>';
        document.getElementById("selfOk").addEventListener("click", async () => { await api("/api/practice/answer", { method: "POST", body: { question_id: q.question_id, user_answer: ua, self_correct: true } }); res.innerHTML = "<p>已記錄：答對。</p>"; });
        document.getElementById("selfNo").addEventListener("click", async () => { await api("/api/practice/answer", { method: "POST", body: { question_id: q.question_id, user_answer: ua, self_correct: false } }); res.innerHTML = "<p>已記錄：答錯，已經加入錯題本。</p>"; });
      } else {
        res.innerHTML = '<p><b>' + (d.correct ? "✓ 答對" : "✗ 答錯") + '</b>，正確答案：' + esc(d.answer || "") + '</p><details class="explain"><summary>解析（撳開睇）</summary><p>' + esc(d.explanation || "") + '</p></details>';
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
  m.innerHTML = '<div class="card"><h2>開新模擬考</h2><label>考卷名稱</label><input id="eTitle" placeholder="例如：VTS 模擬卷 01"><label>考試</label><select id="eExam">' + exams.map((e) => '<option>' + esc(e) + '</option>').join("") + '<option value="VTS">VTS</option><option value="430">430</option></select><label>題數</label><input id="eCount" type="number" value="10" min="1" max="100"><p><button class="primary" id="eCreate">隨機組卷</button> <span id="eMsg" class="muted"></span></p><p class="muted">手動選題：去題庫管理撳題目，再用下面嘅手動組卷。簡答題唔會入模擬考自動計分。</p><label>手動選題（用逗號分隔編號，例如 Test-001,Test-002）</label><input id="eManual" placeholder="Test-001"><p><button id="eCreateManual">手動組卷</button></p></div>' +
    '<div class="card"><h2>我嘅考卷</h2>' + (d.exams.length === 0 ? '<p class="muted">暫時未開過模擬考。</p>' : d.exams.map((e) => '<p><b>' + esc(e.title) + '</b> · ' + esc(e.status) + (e.score != null ? ' · ' + e.score + '/' + e.total_questions + ' 分' : ' · ' + e.total_questions + ' 題') + ' <button data-open="' + e.exam_id + '">' + (e.status === "已完成" ? "睇成績" : "繼續作答") + '</button> <button data-del="' + e.exam_id + '" class="danger">刪除</button></p>').join("")) + '</div>';
  async function create(manual) {
    try {
      const body = { title: document.getElementById("eTitle").value, exam: document.getElementById("eExam").value, count: Number(document.getElementById("eCount").value) || 10 };
      if (manual) { body.question_ids = document.getElementById("eManual").value.split(",").map((s) => s.trim()).filter(Boolean); if (!body.question_ids.length) { document.getElementById("eMsg").textContent = "請先填寫題目編號。"; return; } }
      const r = await api("/api/exams", { method: "POST", body });
      openExam(r.exam_id);
    } catch (e) { document.getElementById("eMsg").textContent = e.message; }
  }
  document.getElementById("eCreate").addEventListener("click", () => create(false));
  document.getElementById("eCreateManual").addEventListener("click", () => create(true));
  m.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openExam(Number(b.dataset.open))));
  m.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { if (confirm("確定刪除呢份考卷？連同答題紀錄都會一併清除。")) { await api("/api/exams/" + b.dataset.del, { method: "DELETE" }); showView("exam"); } }));
}
async function openExam(id) {
  const d = await api("/api/exams/" + id);
  if (d.exam.status === "已完成") { await showReport(id); return; }
  examState = { id, exam: d.exam, questions: d.questions, answers: d.answers || {}, marked: d.marked || [], idx: d.firstUnanswered >= 0 ? d.firstUnanswered : 0, savedAt: "", saveFail: false };
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
      (q ? '<h3>' + esc(q.content) + '</h3>' + q.options.map((o, i) => { const L = String.fromCharCode(65 + i); if (q.type === "多選") return '<label><input type="checkbox" class="eOpt" value="' + L + '" ' + ((st.answers[q.question_id] || "").includes(L) ? "checked" : "") + '> ' + L + '. ' + esc(o) + '</label>'; return '<button class="opt ' + (st.answers[q.question_id] === L ? "sel" : "") + '" data-v="' + L + '">' + L + '. ' + esc(o) + '</button>'; }).join("") : '<p>呢份卷冇題目。</p>') +
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
    d.items.map((it, i) => '<div class="card"><div><b>' + (it.is_correct ? "✓ 答對" : "✗ 答錯") + '</b> 第 ' + (i + 1) + ' 題</div>' + qCard(it.question, true) + '<p>你嘅答案：' + esc(it.user_answer || "（未答）") + '</p></div>').join("");
  document.getElementById("backE").addEventListener("click", () => showView("exam"));
  document.getElementById("goW2").addEventListener("click", () => showView("wrong"));
}

// ---------- 題庫管理 ----------
async function viewQuestions() {
  if (me.role !== "admin") { mainEl().innerHTML = '<div class="card"><p>只有管理員先可以用題庫管理。</p></div>'; return; }
  const m = mainEl();
  m.innerHTML = '<div class="card"><h2>題庫管理</h2><div style="display:flex;gap:8px;flex-wrap:wrap"><input id="qSearch" placeholder="關鍵字或者編號" style="flex:2;min-width:160px"><select id="qExamF" style="flex:1"><option value="">全部考試</option></select><select id="qTypeF" style="flex:1"><option value="">全部題型</option><option>單選</option><option>多選</option><option>判斷</option><option>簡答</option></select><select id="qDiffF" style="flex:1"><option value="">全部難度</option><option>簡單</option><option>中等</option><option>困難</option></select></div><p><button class="primary" id="qFilter">篩選</button> <button id="qAdd">新增題目</button> <span id="qMsg" class="muted"></span></p></div>' +
    '<div class="card"><h2>CSV 批次匯入</h2><p><button id="tplDl">⬇ 下載 CSV 範本（含示例）</button> <button id="tplView">睇範本內容</button> <button id="tplCopy">一鍵複製範本</button></p><p class="muted">範本用 exam 欄位，值係 VTS 或者 430，入面有 4 行示例（單選、多選、判斷、簡答各一），匯入前要刪走示例行。匯入同時兼容舊 chapter / 章節欄位名。</p><div id="tplArea"></div><label>直接貼上 CSV 內容</label><textarea id="csvText" placeholder="貼上 CSV 內容，欄位：question_id,type,content,options,answer,explanation,exam,difficulty"></textarea><label>重複編號處理</label><select id="csvMode"><option value="skip">跳過</option><option value="overwrite">覆蓋</option></select><p><button class="primary" id="csvGo">匯入</button> <span id="csvMsg" class="muted"></span></p><div id="csvErr"></div></div>' +
    '<div id="qList"></div>';
  let exams = [];
  try { exams = (await api("/api/questions/exams")).exams; } catch (e) {}
  const sel = document.getElementById("qExamF");
  exams.forEach((e) => { const o = document.createElement("option"); o.textContent = e; sel.appendChild(o); });
  const tplText = "question_id,type,content,options,answer,explanation,exam,difficulty\nDEMO-001,單選,避碰規則：兩船對遇時，邊一邊應該讓路？,左舷讓路|右舷讓路|直航船讓路|兩船同時轉向,A,對遇局面，兩船都應該向右轉，互相從左舷通過。,VTS,簡單\nDEMO-002,多選,以下邊啲屬於 VTS 服務範圍？,船舶交通組織|助航服務|危險品監控|天氣預報,ABC,VTS 提供交通組織、助航同危險品監控，天氣預報唔係 VTS 本身服務。,VTS,中等\nDEMO-003,判斷,追越船必須讓路給被追越船。,正確|錯誤,正確,追越船係讓路船，必須避讓被追越船。,VTS,簡單\nDEMO-004,簡答,請簡述 VHF 第 16 頻道嘅用途。,,第 16 頻道係國際遇險、緊急同呼叫頻道，用於遇險求救同建立聯絡，聯絡好之後要轉去工作頻道通話，唔好長期佔用。,第 16 頻道係國際遇險、緊急同呼叫頻道，用於遇險求救同建立聯絡，聯絡好之後要轉去工作頻道通話，唔好長期佔用。,VTS,中等";
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
  async function loadList() {
    const q = document.getElementById("qSearch").value, ex = document.getElementById("qExamF").value, ty = document.getElementById("qTypeF").value, df = document.getElementById("qDiffF").value;
    const d = await api("/api/questions?exam=" + encodeURIComponent(ex) + "&difficulty=" + encodeURIComponent(df) + "&type=" + encodeURIComponent(ty) + "&q=" + encodeURIComponent(q));
    const list = document.getElementById("qList");
    if (d.questions.length === 0) { list.innerHTML = '<div class="card"><p class="muted">暫時未有題目，請新增或者匯入。</p></div>'; return; }
    list.innerHTML = d.questions.map((qq) => '<div class="card"><div><span class="pill">' + esc(qq.exam) + '</span><span class="pill">' + esc(qq.type) + '</span><span class="pill">' + esc(qq.difficulty) + '</span><span class="pill">' + esc(qq.question_id) + '</span></div><h3>' + esc(qq.content) + '</h3><p><button data-edit="' + esc(qq.question_id) + '">修改</button> <button data-prev="' + esc(qq.question_id) + '">預覽</button> <button data-del="' + esc(qq.question_id) + '" class="danger">刪除</button></p></div>').join("");
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { if (confirm("確定刪除 " + b.dataset.del + "？")) { await api("/api/questions/" + encodeURIComponent(b.dataset.del), { method: "DELETE" }); loadList(); } }));
    list.querySelectorAll("[data-prev]").forEach((b) => b.addEventListener("click", async () => { const dd = await api("/api/questions/" + encodeURIComponent(b.dataset.prev)); openModal(qCard(dd.question, true) + '<p><button id="mClose">關閉</button></p>'); document.getElementById("mClose").addEventListener("click", closeModal); }));
    list.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", async () => { const dd = await api("/api/questions/" + encodeURIComponent(b.dataset.edit)); openQForm(dd.question); }));
  }
  document.getElementById("qFilter").addEventListener("click", loadList);
  document.getElementById("qAdd").addEventListener("click", () => openQForm(null));
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
      '<label>考試（自由填寫，建議：VTS、430）</label><input id="fExam" list="examList" value="' + esc(qq.exam) + '"><datalist id="examList"><option value="VTS"><option value="430"></datalist>' +
      '<label>難度</label><select id="fDiff"><option>簡單</option><option>中等</option><option>困難</option></select>' +
      '<p><button class="primary" id="fSave">儲存</button> <button id="fCancel">取消</button></p><p id="fMsg" class="muted"></p>');
    document.getElementById("fType").value = qq.type;
    document.getElementById("fDiff").value = qq.difficulty;
    document.getElementById("fCancel").addEventListener("click", closeModal);
    document.getElementById("fSave").addEventListener("click", async () => {
      const body = { question_id: document.getElementById("fId").value, type: document.getElementById("fType").value, content: document.getElementById("fContent").value, options: document.getElementById("fOpts").value.split("\n").map((s) => s.trim()).filter(Boolean), answer: document.getElementById("fAns").value, explanation: document.getElementById("fExp").value, exam: document.getElementById("fExam").value, difficulty: document.getElementById("fDiff").value };
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
  m.innerHTML = '<div class="card"><h2>帳號管理</h2>' + d.users.map((u) => '<p><b>' + esc(u.username) + '</b> · ' + esc(u.role) + ' <button data-role="' + u.user_id + '" data-to="' + (u.role === "admin" ? "user" : "admin") + '">' + (u.role === "admin" ? "降級做考生" : "升級做管理員") + '</button></p>').join("") + '</div>';
  m.querySelectorAll("[data-role]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("/api/admin/users/" + b.dataset.role + "/role", { method: "POST", body: { role: b.dataset.to } }); showView("accounts"); }
    catch (e) { alert(e.message); }
  }));
}

// ---------- 啟動 ----------
render();
