"use strict";

const KINDS = [
  { kind: "cash",   label: "現金" },
  { kind: "wallet", label: "儲值金" },
  { kind: "bank",   label: "銀行" },
  { kind: "card",   label: "信用卡" },
  { kind: "broker", label: "證券戶" },
];
const DEFAULT_ACCOUNTS = [
  { id: "cash",    name: "現金",       kind: "cash" },
  { id: "jkopay",  name: "街口",       kind: "wallet" },
  { id: "linepay", name: "LINE Pay",   kind: "wallet" },
  { id: "bank",    name: "台新銀行",   kind: "bank" },
  { id: "sinopac", name: "永豐(薪轉・交割)", kind: "bank" },
  { id: "ctbc",    name: "中國信託",   kind: "bank" },
  { id: "cathay",  name: "國泰世華",   kind: "bank" },
  { id: "card",    name: "信用卡",     kind: "card" },
  { id: "broker",  name: "投資部位(股票)", kind: "broker" },
];
const RENAMES = { "永豐銀行": "永豐(薪轉・交割)", "證券交割戶": "投資部位(股票)" };
let ACCOUNTS = [];
function decorate(a) {
  return { id: a.id, name: a.name, kind: a.kind,
    group: a.kind === "broker" ? "invest" : "life", liability: a.kind === "card" };
}
function applyAccounts() {
  ACCOUNTS = state.accounts.map(decorate);
}
const EXPENSE_CATS = ["餐飲", "交通", "日用", "娛樂", "服飾", "醫療", "居住", "通訊", "旅遊", "其他"];
const INCOME_CATS = ["薪資", "股利", "其他收入"];
const INVEST_COST = "投資成本";
const RECON_EXP = "未記錄支出";
const RECON_INC = "對帳差額";
const PRESETS = [
  { label: "提款",         from: { kind: "bank" },   to: { kind: "cash" } },
  { label: "儲值街口",     from: { kind: "bank" },   to: { id: "jkopay" } },
  { label: "儲值LINE Pay", from: { kind: "bank" },   to: { id: "linepay" } },
  { label: "繳卡費",       from: { kind: "bank" },   to: { kind: "card" } },
  { label: "買股票",       from: { id: "sinopac", kind: "bank" },   to: { kind: "broker" }, fixedFrom: true },
  { label: "賣股票",       from: { kind: "broker" }, to: { id: "sinopac", kind: "bank" } },
  { label: "銀行互轉",     from: { kind: "bank" },   to: { kind: "bank", other: true } },
];
const KEY = "exp.v1";
const TOKEN_KEY = "exp.token";

let memStore = null;
let state = { entries: [], url: "", openings: {}, accounts: null };
let tType = "expense";
let lastType = "expense";
let tCat = EXPENSE_CATS[0];
let viewMonth = monthOf(todayStr());
let storageOk = true;

function $(id) { return document.getElementById(id); }
function kindOf(id) { return (ACCOUNTS.find(a => a.id === id) || {}).kind; }
function acctName(id) { return (ACCOUNTS.find(a => a.id === id) || { name: id }).name; }
function pad(n) { return String(n).padStart(2, "0"); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function monthOf(ds) { return ds.slice(0, 7); }
function money(n) {
  const v = Math.round(n * 100) / 100;
  return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("zh-TW");
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = Object.assign(state, JSON.parse(raw));
  } catch (e) { storageOk = false; if (memStore) state = memStore; }
  if (!Array.isArray(state.accounts) || !state.accounts.length) {
    state.accounts = DEFAULT_ACCOUNTS.map(a => Object.assign({}, a));
  }
  if (!state.renamedV1) {
    state.accounts.forEach(a => { if (RENAMES[a.name]) a.name = RENAMES[a.name]; });
    state.renamedV1 = true;
  }
  applyAccounts();
}
function save() {
  memStore = state;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { storageOk = false; }
}
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { storageOk = false; } }

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
}

/* ---------- 計算 ---------- */
function liveEntries() { return state.entries.filter(e => !e.void); }

function balances() {
  const b = {};
  ACCOUNTS.forEach(a => {
    const open = Number(state.openings[a.id] || 0);
    b[a.id] = a.liability ? -open : open;
  });
  liveEntries().forEach(e => {
    if (e.type === "expense") b[e.account] -= e.amount;
    else if (e.type === "income") b[e.account] += e.amount;
    else if (e.type === "transfer") { b[e.account] -= e.amount; b[e.toAccount] += e.amount; }
  });
  return b;
}

function monthStats(ym) {
  const s = { exp: 0, inc: 0, div: 0, invCost: 0, invNet: 0, cats: {} };
  liveEntries().filter(e => monthOf(e.date) === ym).forEach(e => {
    if (e.type === "expense") {
      if (e.category === INVEST_COST) s.invCost += e.amount;
      else { s.exp += e.amount; s.cats[e.category] = (s.cats[e.category] || 0) + e.amount; }
    } else if (e.type === "income") {
      if (e.category === "股利") s.div += e.amount; else s.inc += e.amount;
    } else if (e.type === "transfer") {
      if (kindOf(e.toAccount) === "broker") s.invNet += e.amount;
      if (kindOf(e.account) === "broker") s.invNet -= e.amount;
    }
  });
  return s;
}

/* ---------- 畫面 ---------- */
function renderCats() {
  const list = tType === "income" ? INCOME_CATS : EXPENSE_CATS.concat([INVEST_COST]);
  if (!list.includes(tCat)) tCat = list[0];
  $("cats").innerHTML = list.map(c =>
    `<button class="chip${c === tCat ? " on" : ""}" data-c="${esc(c)}">${esc(c)}</button>`).join("");
}
function fillAcctSelects() {
  const prevFrom = $("acct").value, prevTo = $("toAcct").value;
  const opts = ACCOUNTS.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  $("acct").innerHTML = opts;
  $("toAcct").innerHTML = opts;
  const has = id => ACCOUNTS.some(a => a.id === id);
  $("acct").value = has(prevFrom) ? prevFrom : ACCOUNTS[0].id;
  $("toAcct").value = has(prevTo) ? prevTo : (has("cash") ? "cash" : ACCOUNTS[0].id);
}
function resolveAcct(spec, avoid, prefer) {
  if (spec.id) {
    const byId = ACCOUNTS.find(a => a.id === spec.id);
    if (byId || !spec.kind) return byId;
  }
  const ofKind = ACCOUNTS.filter(a => a.kind === spec.kind);
  if (prefer) { const p = ofKind.find(a => a.id === prefer); if (p) return p; }
  if (spec.other) return ofKind.find(a => a.id !== avoid);
  return ofKind[0];
}
function renderPresets() {
  $("presets").innerHTML = PRESETS.map((p, i) =>
    `<button class="preset" data-p="${i}">${esc(p.label)}</button>`).join("");
}
function applyType() {
  document.querySelectorAll("#typeSeg button").forEach(b => b.classList.toggle("on", b.dataset.t === tType));
  const tr = tType === "transfer";
  $("catBox").style.display = tr ? "none" : "";
  $("toBox").style.display = tr ? "" : "none";
  $("presetBox").style.display = tr ? "" : "none";
  $("acctLabel").textContent = tr ? "轉出帳戶" : (tType === "income" ? "入帳帳戶" : "付款帳戶");
  if (tType === "income" && lastType !== "income" && ACCOUNTS.some(a => a.id === "sinopac")) $("acct").value = "sinopac";
  if (tType === "expense" && lastType === "income" && ACCOUNTS.some(a => a.id === "cash")) $("acct").value = "cash";
  lastType = tType;
  if (!tr) renderCats();
}
function typeLabel(e) {
  if (e.type === "transfer") return "轉帳 " + acctName(e.account) + " → " + acctName(e.toAccount);
  return e.category + " · " + acctName(e.account);
}
function renderRecent() {
  const items = liveEntries().slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  $("recent").innerHTML = items.length ? items.map(e => {
    const sign = e.type === "income" ? "+" : e.type === "expense" ? "-" : "";
    return `<div class="row"><div><div>${esc(typeLabel(e))}</div><small>${esc(e.date)}${e.note ? " · " + esc(e.note) : ""}</small></div>
      <div class="num">${sign}${money(e.amount)}<br><button class="del" data-del="${e.id}">刪除</button></div></div>`;
  }).join("") : `<p class="muted">還沒有紀錄</p>`;
}
function renderMonth() {
  const s = monthStats(viewMonth);
  $("monthTitle").textContent = viewMonth.replace("-", " 年 ") + " 月";
  $("mExp").textContent = money(s.exp);
  $("mInc").textContent = money(s.inc);
  $("mDiv").textContent = money(s.div);
  $("mInvCost").textContent = money(s.invCost);
  $("mInvNet").textContent = money(s.invNet);
  const cats = Object.entries(s.cats).sort((a, b) => b[1] - a[1]);
  const total = cats.reduce((n, c) => n + c[1], 0);
  $("mCats").innerHTML = cats.length ? cats.map(([c, v]) =>
    `<div class="row"><span>${esc(c)} <small>${total ? Math.round(v / total * 100) : 0}%</small></span><span class="num">${money(v)}</span></div>`).join("")
    : `<p class="muted">這個月還沒有支出</p>`;
}
function acctRow(a, bal) {
  const shown = a.liability ? -bal : bal;
  const label = a.liability ? "目前欠款" : "";
  const recon = a.kind === "cash" || a.kind === "wallet"
    ? `<button class="btn2" data-recon="${a.id}">對帳</button>` : "";
  return `<div class="row"><span>${esc(a.name)} <small>${label}</small></span>
    <span class="num ${shown < 0 && !a.liability ? "neg" : ""}">${money(shown)} ${recon}</span></div>`;
}
function renderAccts() {
  const b = balances();
  $("lifeList").innerHTML = ACCOUNTS.filter(a => a.group === "life").map(a => acctRow(a, b[a.id])).join("");
  const life = ACCOUNTS.filter(a => a.group === "life").reduce((n, a) => n + b[a.id], 0);
  $("lifeTotal").textContent = money(life);
  $("invList").innerHTML = ACCOUNTS.filter(a => a.group === "invest").map(a => acctRow(a, b[a.id])).join("");
}
function renderSettings() {
  $("setUrl").value = state.url || "";
  $("setToken").value = getToken();
  $("openList").innerHTML = ACCOUNTS.map(a =>
    `<label>${esc(a.name)}${a.liability ? "(欠款)" : ""}</label>
     <input type="number" inputmode="decimal" step="any" data-open="${a.id}" value="${Number(state.openings[a.id] || 0)}">`).join("");
  $("storageNote").textContent = storageOk ? "" : "注意:這個瀏覽器無法儲存資料,關閉頁面後紀錄會消失。請盡快同步。";
  renderAcctMgr();
}
function acctInUse(id) {
  return state.entries.some(e => e.account === id || e.toAccount === id);
}
function renderAcctMgr() {
  $("acctMgr").innerHTML = state.accounts.map(a => {
    const kindLabel = (KINDS.find(k => k.kind === a.kind) || {}).label;
    const del = acctInUse(a.id) ? `<small class="muted">有紀錄</small>`
      : `<button class="del" data-rmacct="${a.id}">刪除</button>`;
    return `<div class="row"><div style="flex:1"><input type="text" data-rename="${a.id}" value="${esc(a.name)}" aria-label="帳戶名稱"></div>
      <div style="white-space:nowrap"><small class="muted">${esc(kindLabel)}</small> ${del}</div></div>`;
  }).join("");
  $("newKind").innerHTML = KINDS.map(k => `<option value="${k.kind}">${esc(k.label)}</option>`).join("");
}
function refreshAfterAcctChange() {
  applyAccounts(); save(); fillAcctSelects(); renderAll(); renderSettings();
}
function unsynced() {
  return state.entries.filter(e => !e.synced || (e.void && !e.voidSynced));
}
function renderSync(msg) {
  const n = unsynced().length;
  const el = $("sync");
  el.classList.toggle("pending", n > 0);
  el.textContent = msg || (n > 0 ? "未同步 " + n + " 筆" + (lastError ? "・點我查看" : "") : "已同步");
}
function renderAll() {
  renderRecent(); renderMonth(); renderAccts(); renderSync();
}

/* ---------- 動作 ---------- */
function addEntry(e) {
  e.id = newId();
  e.createdAt = Date.now();
  e.synced = false;
  state.entries.push(e);
  save();
  renderAll();
  syncNow();
}

function onSave() {
  const amount = Number($("amount").value);
  if (!(amount > 0)) { toast("請輸入金額"); return; }
  const date = $("date").value || todayStr();
  const note = $("note").value.trim();
  const account = $("acct").value;
  if (tType === "transfer") {
    const toAccount = $("toAcct").value;
    if (toAccount === account) { toast("轉出與轉入不能是同一個帳戶"); return; }
    addEntry({ date, type: "transfer", amount, category: "轉帳", account, toAccount, note });
  } else {
    addEntry({ date, type: tType, amount, category: tCat, account, toAccount: "", note });
  }
  $("amount").value = ""; $("note").value = "";
  toast("已記下");
}

function reconcile(id) {
  const b = balances()[id];
  const input = prompt(acctName(id) + " 實際餘額?(App 目前 " + money(b) + ")");
  if (input === null || input.trim() === "") return;
  const actual = Number(input);
  if (!isFinite(actual)) { toast("請輸入數字"); return; }
  const diff = Math.round((actual - b) * 100) / 100;
  if (diff === 0) { toast("帳目一致"); return; }
  if (diff < 0) addEntry({ date: todayStr(), type: "expense", amount: -diff, category: RECON_EXP, account: id, toAccount: "", note: "對帳" });
  else addEntry({ date: todayStr(), type: "income", amount: diff, category: RECON_INC, account: id, toAccount: "", note: "對帳" });
  toast("已記錄差額 " + money(diff));
}

function deleteEntry(id) {
  if (!confirm("確定刪除這筆?")) return;
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  if (!e.synced) state.entries = state.entries.filter(x => x.id !== id);
  else { e.void = true; e.voidSynced = false; }
  save(); renderAll(); syncNow();
}

/* ---------- 同步 ---------- */
let syncing = false;
let lastError = "";
async function syncNow(manual) {
  const pending = unsynced();
  if (!pending.length) { if (manual === true) toast("沒有待同步的紀錄"); return; }
  if (syncing) return;
  const url = state.url, token = getToken();
  if (!url || !token) {
    lastError = "尚未設定同步網址或密鑰(到「設定」填寫)";
    if (manual === true) toast(lastError);
    renderSync(); return;
  }
  if (!navigator.onLine) {
    lastError = "目前沒有網路";
    if (manual === true) toast(lastError);
    renderSync(); return;
  }
  syncing = true;
  renderSync("同步中…");
  try {
    const rows = pending.map(e => ({
      id: e.id, date: e.date, type: e.type, amount: e.amount, category: e.category,
      account: acctName(e.account), toAccount: e.toAccount ? acctName(e.toAccount) : "",
      note: e.note || "", createdAt: e.createdAt, void: !!e.void,
    }));
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token, rows }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "同步失敗");
    const sent = new Set(rows.map(r => r.id));
    state.entries.forEach(e => { if (sent.has(e.id)) { e.synced = true; if (e.void) e.voidSynced = true; } });
    state.entries = state.entries.filter(e => !(e.void && e.voidSynced && e.synced));
    save();
    syncing = false;
    lastError = "";
    renderAll();
    if (manual === true) toast("同步完成");
  } catch (err) {
    syncing = false;
    lastError = err && err.message === "unauthorized" ? "密鑰不對(設定頁的密鑰與 Apps Script 的 TOKEN 不一致)"
      : "同步失敗:" + (err && err.message ? err.message : "未知錯誤");
    renderSync();
    if (manual === true) toast(lastError);
  }
}

/* ---------- 事件 ---------- */
function bind() {
  $("typeSeg").addEventListener("click", ev => {
    const t = ev.target.closest("button"); if (!t) return;
    tType = t.dataset.t; applyType();
  });
  $("cats").addEventListener("click", ev => {
    const c = ev.target.closest("button"); if (!c) return;
    tCat = c.dataset.c; renderCats();
  });
  $("presets").addEventListener("click", ev => {
    const p = ev.target.closest("button"); if (!p) return;
    const pr = PRESETS[Number(p.dataset.p)];
    const from = resolveAcct(pr.from, null, pr.fixedFrom ? null : $("acct").value);
    const to = from && resolveAcct(pr.to, from.id, null);
    if (!from || !to) { toast("找不到對應帳戶,請到「設定」新增"); return; }
    $("acct").value = from.id; $("toAcct").value = to.id;
    $("note").value = pr.label;
  });
  $("save").addEventListener("click", onSave);
  $("recent").addEventListener("click", ev => {
    const d = ev.target.closest("[data-del]"); if (d) deleteEntry(d.dataset.del);
  });
  $("lifeList").addEventListener("click", ev => {
    const r = ev.target.closest("[data-recon]"); if (r) reconcile(r.dataset.recon);
  });
  $("nav").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll("section").forEach(s => s.classList.toggle("on", s.id === "tab-" + b.dataset.tab));
    if (b.dataset.tab === "month") renderMonth();
    if (b.dataset.tab === "acct") renderAccts();
    if (b.dataset.tab === "set") renderSettings();
  });
  $("prevM").addEventListener("click", () => shiftMonth(-1));
  $("nextM").addEventListener("click", () => shiftMonth(1));
  $("saveSet").addEventListener("click", () => {
    state.url = $("setUrl").value.trim();
    setToken($("setToken").value.trim());
    save(); toast("設定已儲存"); syncNow();
  });
  $("syncNow").addEventListener("click", () => { syncNow(true); });
  $("sync").addEventListener("click", () => {
    if (unsynced().length === 0) { toast("已同步"); return; }
    syncNow(true);
  });
  $("saveOpen").addEventListener("click", () => {
    document.querySelectorAll("[data-open]").forEach(i => { state.openings[i.dataset.open] = Number(i.value) || 0; });
    save(); renderAll(); toast("期初餘額已儲存");
  });
  $("addAcct").addEventListener("click", () => {
    const name = $("newName").value.trim();
    if (!name) { toast("請輸入帳戶名稱"); return; }
    if (state.accounts.some(a => a.name === name)) { toast("已有同名帳戶"); return; }
    state.accounts.push({ id: "a" + newId(), name, kind: $("newKind").value });
    $("newName").value = "";
    refreshAfterAcctChange(); toast("已新增帳戶");
  });
  $("acctMgr").addEventListener("change", ev => {
    const i = ev.target.closest("[data-rename]"); if (!i) return;
    const name = i.value.trim();
    const acct = state.accounts.find(a => a.id === i.dataset.rename);
    if (!acct) return;
    if (!name || state.accounts.some(a => a.id !== acct.id && a.name === name)) {
      i.value = acct.name; toast("名稱不可空白或重複"); return;
    }
    acct.name = name; refreshAfterAcctChange();
  });
  $("acctMgr").addEventListener("click", ev => {
    const d = ev.target.closest("[data-rmacct]"); if (!d) return;
    const id = d.dataset.rmacct;
    if (acctInUse(id)) { toast("這個帳戶已有紀錄,不能刪除"); return; }
    if (state.accounts.length <= 1) { toast("至少要保留一個帳戶"); return; }
    if (!confirm("確定刪除這個帳戶?")) return;
    state.accounts = state.accounts.filter(a => a.id !== id);
    delete state.openings[id];
    refreshAfterAcctChange();
  });
  window.addEventListener("online", syncNow);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
}
function shiftMonth(d) {
  const [y, m] = viewMonth.split("-").map(Number);
  const dt = new Date(y, m - 1 + d, 1);
  viewMonth = dt.getFullYear() + "-" + pad(dt.getMonth() + 1);
  renderMonth();
}

/* ---------- 啟動 ---------- */
load();
fillAcctSelects();
renderPresets();
$("date").value = todayStr();
applyType();
bind();
renderAll();
renderSettings();
syncNow();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
