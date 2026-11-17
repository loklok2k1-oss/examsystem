"use strict";
// 重設密碼（管理員唔記得密碼嗰陣用，經伺服器本機跑，唔經網絡）：
//   pm2 stop exam-system
//   node scripts/reset-password.js <帳號> <新密碼>
//   pm2 start exam-system
// 或者：npm run reset-password -- <帳號> <新密碼>
// 新密碼至少 6 個字。重設之後，該帳號舊嘅登入狀態會全部失效，要用新密碼重新登入。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (e) {
  console.error("需要 Node.js 22 或以上版本。");
  process.exit(1);
}

const username = process.argv[2];
const password = process.argv[3];
if (!username || !password) {
  console.error("用法：node scripts/reset-password.js <帳號> <新密碼>");
  process.exit(1);
}
if (password.length < 6) {
  console.error("新密碼至少要 6 個字。");
  process.exit(1);
}
const dbPath = path.join(__dirname, "..", "data", "exam.db");
if (!fs.existsSync(dbPath)) {
  console.error("搵唔到資料庫：" + dbPath + "，請先啟動一次系統建立資料庫。");
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
if (!u) {
  console.error("搵唔到帳號：" + username);
  process.exit(1);
}
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
db.prepare("UPDATE users SET password_hash = ? WHERE user_id = ?").run(salt + "$" + hash, u.user_id);
db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.user_id);
db.close();
console.log("已重設「" + username + "」嘅密碼（角色：" + u.role + "），舊登入狀態已經全部失效，請用新密碼登入。");
