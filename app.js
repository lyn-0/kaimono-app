/* ============================================================
   お買い物マネージャー
   - 買い物リスト / ほしいものリスト / 買ったものリスト
   - Firebase Authentication (Google) でログイン
   - データは Cloud Firestore に保存（users/{uid}/ 以下）
   - 画像は自動で縮小・JPEG圧縮して Firestore に保存
   ============================================================ */
"use strict";

/* ---------------- Firebase ---------------- */
// 接続先プロジェクト（家計簿「遊び代管理」と同じ kakeibo-21cf0）。
// APIキーは公開してよい値で、データ保護は Firestore のセキュリティルールが担う。
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyADydfhaPwCNBd_CO2c5qQM0ONmr-FTEZQ",
  authDomain: "kakeibo-21cf0.firebaseapp.com",
  projectId: "kakeibo-21cf0",
  storageBucket: "kakeibo-21cf0.firebasestorage.app",
  messagingSenderId: "558811122568",
  appId: "1:558811122568:web:4e08fca088a1eb9579483d",
};

let fapp = null;
let fauth = null;
let fdb = null;
let currentUser = null;

function getFirebaseConfig() {
  return FIREBASE_CONFIG;
}

function initFirebase() {
  const cfg = getFirebaseConfig();
  if (!cfg || typeof firebase === "undefined" || fapp) return;
  fapp = firebase.initializeApp(cfg);
  fauth = firebase.auth();
  fdb = firebase.firestore();
  // オフラインキャッシュ（2回目以降の読み込み高速化・圏外時の閲覧）
  fdb.enablePersistence({ synchronizeTabs: true }).catch(() => { /* 対応外ブラウザは無視 */ });
  fauth.onAuthStateChanged(async (user) => {
    currentUser = user;
    renderAuth();
    if (user) {
      await loadAllData();
    } else {
      shoppingItems = []; wishItems = []; boughtItems = []; imagesById = new Map();
      renderShopping(); renderWish(); renderBought();
    }
  });
}

/* ---------------- Firestore データ層 ---------------- */
const userCol = (name) => fdb.collection("users").doc(currentUser.uid).collection(name);

async function dbGetAll(store) {
  const snap = await userCol(store).get();
  return snap.docs.map((d) => d.data());
}
async function dbPut(store, obj) {
  await userCol(store).doc(obj.id).set(obj);
}
async function dbDelete(store, id) {
  await userCol(store).doc(id).delete();
}
async function dbClear(store) {
  const snap = await userCol(store).get();
  // バッチは500件まで → 分割して削除
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = fdb.batch();
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

/* ---------------- ユーティリティ ---------------- */
const $ = (sel) => document.querySelector(sel);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const yen = (n) => "¥" + Number(n).toLocaleString("ja-JP");
const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* ---------------- 画像管理 ----------------
   Firestore の1ドキュメント上限(1MB)に収まるよう
   縮小+JPEG圧縮した dataURL を users/{uid}/images に保存。
   アイテム側は画像IDの配列を持つ。 */
let imagesById = new Map(); // id -> dataURL

const imgSrc = (id) => imagesById.get(id) || "";

function compressImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const MAX = 1000; // 長辺の最大px
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let q = 0.85;
      let dataUrl = c.toDataURL("image/jpeg", q);
      while (dataUrl.length > 700000 && q > 0.35) { // 約700KBまで圧縮
        q -= 0.15;
        dataUrl = c.toDataURL("image/jpeg", q);
      }
      resolve(dataUrl);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした")); };
    img.src = url;
  });
}

async function saveNewImage(dataURL) {
  const id = uuid();
  await dbPut("images", { id, data: dataURL, createdAt: Date.now() });
  imagesById.set(id, dataURL);
  return id;
}

async function deleteItemImages(item) {
  for (const id of item.images || []) {
    await dbDelete("images", id);
    imagesById.delete(id);
  }
}

/* ---------------- 状態 ---------------- */
let shoppingItems = [];
let wishItems = [];
let boughtItems = [];
let activeCategory = "all";
let activeKind = "all"; // all | mono(ほしいもの) | koto(やりたいこと)
let wishSortMode = "manual";
let boughtSortMode = "newest";
let spotView = "want";   // want=行きたい / went=行った
let spotRegion = "all";
let spotSortMode = "newest";

const kindOf = (item) => item.kind || "mono"; // 既存データは「もの」扱い
const isKoto = (item) => kindOf(item) === "koto";
const isSpot = (item) => kindOf(item) === "spot";
const PENDING_NAME = "（スポット情報を取得中…）";

async function loadAllData() {
  imagesById = new Map((await dbGetAll("images")).map((d) => [d.id, d.data]));
  await loadShopping();
  await loadWish();
  await loadBought();
}

/* ============================================================
   タブ切り替え
   ============================================================ */
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
  });
});

/* ============================================================
   買い物リスト
   ============================================================ */
async function loadShopping() {
  shoppingItems = (await dbGetAll("shopping")).sort((a, b) => a.order - b.order);
  renderShopping();
}

function renderShopping() {
  const ul = $("#shoppingList");
  ul.innerHTML = "";
  shoppingItems.forEach((item) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.id = item.id;
    if (item.done) li.classList.add("done");
    li.innerHTML = `
      <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
      <input type="checkbox" ${item.done ? "checked" : ""}>
      <span class="s-name">${esc(item.name)}</span>
      ${item.qty ? `<span class="s-qty">${esc(item.qty)}</span>` : ""}
      <button class="danger-btn s-del">削除</button>`;
    li.querySelector("input").addEventListener("change", async (e) => {
      item.done = e.target.checked;
      await dbPut("shopping", item);
      li.classList.toggle("done", item.done);
      updateShoppingCount();
    });
    li.querySelector(".s-del").addEventListener("click", async () => {
      await dbDelete("shopping", item.id);
      shoppingItems = shoppingItems.filter((x) => x.id !== item.id);
      renderShopping();
    });
    addDragEvents(li, ul, shoppingItems, async () => {
      for (let i = 0; i < shoppingItems.length; i++) {
        shoppingItems[i].order = i;
        await dbPut("shopping", shoppingItems[i]);
      }
    });
    ul.appendChild(li);
  });
  $("#shoppingEmpty").classList.toggle("hidden", shoppingItems.length > 0);
  updateShoppingCount();
}

function updateShoppingCount() {
  const done = shoppingItems.filter((x) => x.done).length;
  $("#shoppingCount").textContent = shoppingItems.length ? `${done} / ${shoppingItems.length} 件チェック済み` : "";
}

$("#shoppingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#shoppingName").value.trim();
  if (!name) return;
  const item = { id: uuid(), name, qty: $("#shoppingQty").value.trim(), done: false, order: shoppingItems.length };
  await dbPut("shopping", item);
  shoppingItems.push(item);
  $("#shoppingName").value = "";
  $("#shoppingQty").value = "";
  $("#shoppingName").focus();
  renderShopping();
});

$("#clearDoneBtn").addEventListener("click", async () => {
  const done = shoppingItems.filter((x) => x.done);
  if (!done.length) return;
  if (!confirm(`チェック済みの ${done.length} 件を削除しますか？`)) return;
  for (const it of done) await dbDelete("shopping", it.id);
  shoppingItems = shoppingItems.filter((x) => !x.done);
  renderShopping();
});

/* ---- 汎用ドラッグ＆ドロップ（リスト並べ替え） ---- */
let dragEl = null;
function addDragEvents(el, container, arr, onReorder) {
  el.addEventListener("dragstart", (e) => {
    dragEl = el;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    document.querySelectorAll(".drag-over").forEach((x) => x.classList.remove("drag-over"));
    dragEl = null;
  });
  el.addEventListener("dragover", (e) => {
    if (!dragEl || dragEl === el || dragEl.parentElement !== container) return;
    e.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (!dragEl || dragEl === el) return;
    const ids = [...container.children].map((c) => c.dataset.id);
    const fromIdx = ids.indexOf(dragEl.dataset.id);
    const toIdx = ids.indexOf(el.dataset.id);
    if (fromIdx < 0 || toIdx < 0) return;
    if (fromIdx < toIdx) container.insertBefore(dragEl, el.nextSibling);
    else container.insertBefore(dragEl, el);
    const newIds = [...container.children].map((c) => c.dataset.id);
    arr.sort((a, b) => newIds.indexOf(a.id) - newIds.indexOf(b.id));
    await onReorder();
  });
}

/* ============================================================
   ほしいものリスト
   ============================================================ */
async function loadWish() {
  wishItems = (await dbGetAll("wish")).sort((a, b) => a.order - b.order);
  renderWish();
}

function sortedWish() {
  let list = wishItems.filter((x) => !isSpot(x)); // スポットは専用タブで表示
  if (activeKind !== "all") list = list.filter((x) => kindOf(x) === activeKind);
  if (activeCategory !== "all") list = list.filter((x) => (x.category || "未分類") === activeCategory);
  switch (wishSortMode) {
    case "priceAsc": list.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)); break;
    case "priceDesc": list.sort((a, b) => (b.price ?? -1) - (a.price ?? -1)); break;
    case "newest": list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); break;
    case "region": list.sort((a, b) => (a.category || "未分類").localeCompare(b.category || "未分類", "ja")); break;
    default: break; // manual: order順のまま
  }
  return list;
}

function renderWish() {
  renderCategoryChips();
  renderCategoryBest();
  const grid = $("#wishGrid");
  grid.innerHTML = "";
  const list = sortedWish();
  const draggable = wishSortMode === "manual";
  list.forEach((item) => grid.appendChild(buildWishCard(item, draggable)));
  $("#wishEmpty").classList.toggle("hidden", wishItems.some((x) => !isSpot(x)));
  renderSpots();
}

function thumbHtmlOf(item) {
  const src = item.images && item.images.length ? imgSrc(item.images[0]) : "";
  if (!src) return `<div class="no-thumb">🖼️</div>`;
  const count = item.images.length > 1 ? `<span class="thumb-count">📷 ${item.images.length}</span>` : "";
  return `<img class="thumb" src="${src}" alt="">${count}`;
}

function buildWishCard(item, draggable) {
  const card = document.createElement("div");
  card.className = "item-card";
  card.dataset.id = item.id;
  if (draggable) card.draggable = true;

  card.innerHTML = `
    ${draggable ? `<span class="card-grip" title="ドラッグで並べ替え">⠿</span>` : ""}
    ${thumbHtmlOf(item)}
    <div class="card-body">
      <div class="c-name">${esc(item.name)}</div>
      ${isSpot(item) && item.price == null ? "" : `<div class="c-price ${item.price == null ? "no-price" : ""}">${item.price != null ? yen(item.price) : "価格未設定"}</div>`}
      <div class="badges">
        ${isKoto(item) ? `<span class="badge koto">✨ やりたいこと</span>` : ""}
        ${isSpot(item) ? `<span class="badge spot">📍 スポット</span>` : ""}
        ${item.category ? `<span class="badge">${esc(item.category)}</span>` : ""}
        ${item.genre ? `<span class="badge genre">${esc(item.genre)}</span>` : ""}
      </div>
      ${item.address ? `<div class="c-address">📍 ${esc(item.address)}</div>` : ""}
      ${item.rating ? `<div class="c-rating">${"★".repeat(item.rating)}${"☆".repeat(5 - item.rating)}</div>` : ""}
      ${item.url ? `<a class="c-link" href="${esc(item.url)}" target="_blank" rel="noopener">${isSpot(item) ? "🗺️ 地図を開く" : `🔗 ${isKoto(item) ? "ページ" : "商品ページ"}を開く`}</a>` : ""}
      ${item.memo ? `<div class="c-memo">${esc(item.memo)}</div>` : ""}
      <div class="card-actions">
        <button class="buy-btn">${isSpot(item) ? "🚩 行った！" : isKoto(item) ? "✨ やった！" : "🛒 買った！"}</button>
        <button class="edit-btn">✏️ 編集</button>
        <button class="danger-btn c-del">🗑</button>
      </div>
    </div>`;

  const img = card.querySelector(".thumb");
  if (img) img.addEventListener("click", () => openViewer(item.images));

  card.querySelector(".buy-btn").addEventListener("click", async () => {
    if (!confirm(`「${item.name}」を${isSpot(item) ? "「行ったスポット」" : "「買った・やった」リスト"}に移動しますか？`)) return;
    const bought = { ...item, purchasedAt: todayISO(), usages: [] };
    await dbPut("bought", bought);
    await dbDelete("wish", item.id);
    wishItems = wishItems.filter((x) => x.id !== item.id);
    boughtItems.push(bought);
    renderWish();
    renderBought();
    autoKakeiboSync(bought); // 設定ONなら家計簿にも自動追加（非同期・失敗しても影響なし）
  });
  card.querySelector(".edit-btn").addEventListener("click", () => openItemDialog("wish", item));
  card.querySelector(".c-del").addEventListener("click", async () => {
    if (!confirm(`「${item.name}」を削除しますか？`)) return;
    await deleteItemImages(item);
    await dbDelete("wish", item.id);
    wishItems = wishItems.filter((x) => x.id !== item.id);
    renderWish();
  });

  if (draggable) {
    addDragEvents(card, $("#wishGrid"), wishItems, async () => {
      for (let i = 0; i < wishItems.length; i++) {
        wishItems[i].order = i;
        await dbPut("wish", wishItems[i]);
      }
    });
  }
  return card;
}

/* ---- カテゴリチップ ---- */
function getCategories() {
  const set = new Set(wishItems.filter((x) => !isSpot(x)).map((x) => x.category || "未分類"));
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

function renderCategoryChips() {
  const wrap = $("#categoryChips");
  wrap.innerHTML = "";
  const cats = getCategories();
  if (activeCategory !== "all" && !cats.includes(activeCategory)) activeCategory = "all";
  const mk = (label, value) => {
    const b = document.createElement("button");
    b.className = "chip" + (activeCategory === value ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", () => {
      activeCategory = value;
      renderWish();
    });
    return b;
  };
  wrap.appendChild(mk("すべて", "all"));
  cats.forEach((c) => wrap.appendChild(mk(c, c)));
}

/* ---- カテゴリ選択時のおすすめバナー ---- */
function renderCategoryBest() {
  const box = $("#categoryBest");
  if (activeCategory === "all") { box.hidden = true; return; }
  const group = wishItems.filter((x) => !isSpot(x) && (x.category || "未分類") === activeCategory);
  if (group.length < 2) { box.hidden = true; return; }
  const { best, reasons } = pickBest(group);
  box.hidden = false;
  box.innerHTML = `🏆 <b>${esc(activeCategory)}</b> のおすすめ: <b>${esc(best.name)}</b>${best.price != null ? `（${yen(best.price)}）` : ""} — ${esc(reasons.join("、") || "総合スコア1位")}`;
}

/* ============================================================
   スコアリング（おすすめ判定・比較で共用）
   ============================================================ */
function scoreItems(group) {
  const prices = group.filter((x) => x.price != null && x.price > 0).map((x) => x.price);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const maxSpecs = Math.max(...group.map((x) => (x.specs || []).length), 0);
  return group.map((item) => {
    let priceScore = 0.5;
    if (item.price != null && item.price > 0 && prices.length >= 2) {
      priceScore = maxP === minP ? 1 : 1 - (item.price - minP) / (maxP - minP);
    } else if (item.price != null && item.price > 0) {
      priceScore = 0.7;
    }
    const ratingScore = item.rating ? item.rating / 5 : 0.4;
    const specScore = maxSpecs > 0 ? (item.specs || []).length / maxSpecs : 0.5;
    const total = priceScore * 0.5 + ratingScore * 0.35 + specScore * 0.15;
    return { item, priceScore, ratingScore, specScore, total };
  });
}

function pickBest(group) {
  const scored = scoreItems(group).sort((a, b) => b.total - a.total);
  const best = scored[0].item;
  const reasons = [];
  if (group.length < 2) return { best, reasons, scored };
  const prices = group.filter((x) => x.price != null && x.price > 0);
  if (prices.length >= 2) {
    const cheapest = prices.reduce((a, b) => (a.price <= b.price ? a : b));
    if (cheapest.id === best.id) reasons.push(`グループ内で最安（${yen(best.price)}）`);
  }
  const maxRating = Math.max(...group.map((x) => x.rating || 0));
  if (best.rating && best.rating === maxRating && maxRating > 0) reasons.push(`ほしい度が最も高い（★${best.rating}）`);
  const maxSpecs = Math.max(...group.map((x) => (x.specs || []).length));
  if ((best.specs || []).length === maxSpecs && maxSpecs > 0) reasons.push("スペック情報が充実");
  return { best, reasons, scored };
}

/* ============================================================
   アイテム編集ダイアログ（wish / bought 共用）
   ============================================================ */
let editingStore = "wish";
let editingItem = null;   // null = 新規
let dialogImages = [];    // [{id?, dataURL}] 既存はid付き、新規はdataURLのみ
let dialogRating = 0;
let dialogKind = "mono";

// 種類に応じて入力欄のラベル・プレースホルダを切り替え
function applyKindToDialog() {
  $("#fKind").classList.toggle("koto", dialogKind === "koto");
  $("#fKind").classList.toggle("spot", dialogKind === "spot");
  document.querySelectorAll("#fKind button").forEach((b) => b.classList.toggle("active", b.dataset.kind === dialogKind));
  const koto = dialogKind === "koto";
  const spot = dialogKind === "spot";
  $("#fNameLabel").textContent = spot ? "スポット名（URLがあれば自動取得）" : koto ? "やりたいこと *" : "商品名 *";
  $("#fCategoryLabel").textContent = spot ? "地域（自動取得・絞り込みに使われます）" : "カテゴリ";
  $("#fUrlLabel").textContent = spot ? "GoogleマップURL" : koto ? "参考URL（クリニック・予約ページなど）" : "商品ページURL";
  $("#fName").placeholder = spot ? "例: 東京タワー" : koto ? "例: 医療脱毛 全身5回コース" : "例: ヘアアイロン SL-010";
  $("#fPrice").placeholder = spot ? "予算があれば（例: 3000）" : koto ? "例: 98000" : "例: 12800";
  $("#fCategory").placeholder = spot ? "例: 東京都 港区" : koto ? "例: 美容医療" : "例: 美容家電";
  $("#fGenre").placeholder = spot ? "例: カフェ（比較用・任意）" : koto ? "例: 医療脱毛（クリニック比較用）" : "例: ヘアアイロン";
  $("#fUrl").placeholder = spot ? "https://maps.app.goo.gl/... など" : koto ? "クリニック・予約ページなどのURL" : "https://...";
  $("#fName").required = !spot;
  $("#fAddressRow").hidden = !spot;
}
document.querySelectorAll("#fKind button").forEach((b) => {
  b.addEventListener("click", () => {
    dialogKind = b.dataset.kind;
    applyKindToDialog();
  });
});

function openItemDialog(store, item, presetKind) {
  editingStore = store;
  editingItem = item || null;
  dialogImages = item
    ? (item.images || []).map((id) => ({ id, dataURL: imgSrc(id) })).filter((e) => e.dataURL)
    : [];
  dialogRating = item ? item.rating || 0 : 0;
  dialogKind = item ? kindOf(item) : (presetKind || (activeKind !== "all" ? activeKind : "mono"));
  applyKindToDialog();
  $("#fAddress").value = item ? item.address || "" : "";

  $("#itemDialogTitle").textContent = item ? "アイテムを編集" : "リストに追加";
  $("#fName").value = item ? item.name : "";
  $("#fPrice").value = item && item.price != null ? item.price : "";
  $("#fCategory").value = item ? item.category || "" : "";
  $("#fGenre").value = item ? item.genre || "" : "";
  $("#fUrl").value = item ? item.url || "" : "";
  $("#fMemo").value = item ? item.memo || "" : "";

  const allItems = [...wishItems, ...boughtItems];
  $("#categoryList").innerHTML = [...new Set(allItems.map((x) => x.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join("");
  $("#genreList").innerHTML = [...new Set(allItems.map((x) => x.genre).filter(Boolean))].map((g) => `<option value="${esc(g)}">`).join("");

  renderRating();
  renderSpecRows(item ? item.specs || [] : []);
  renderDialogImages();
  $("#itemDialog").showModal();
}

function renderRating() {
  document.querySelectorAll("#fRating button[data-v]").forEach((b) => {
    const v = Number(b.dataset.v);
    if (v >= 1) b.classList.toggle("lit", v <= dialogRating);
  });
}
document.querySelectorAll("#fRating button").forEach((b) => {
  b.addEventListener("click", () => {
    dialogRating = Number(b.dataset.v);
    renderRating();
  });
});

/* ---- スペック行 ---- */
function renderSpecRows(specs) {
  const wrap = $("#specRows");
  wrap.innerHTML = "";
  specs.forEach((s) => addSpecRow(s.k, s.v));
  if (!specs.length) addSpecRow("", "");
}
function addSpecRow(k = "", v = "") {
  const row = document.createElement("div");
  row.className = "spec-row";
  row.innerHTML = `
    <input type="text" class="spec-k" placeholder="項目（例: 温度）" value="${esc(k)}">
    <input type="text" class="spec-v" placeholder="値（例: 220℃）" value="${esc(v)}">
    <button type="button" class="danger-btn spec-del">✕</button>`;
  row.querySelector(".spec-del").addEventListener("click", () => row.remove());
  $("#specRows").appendChild(row);
}
$("#addSpecBtn").addEventListener("click", () => addSpecRow());

/* ---- 画像（貼り付け・選択） ---- */
function renderDialogImages() {
  const wrap = $("#imagePreview");
  wrap.innerHTML = "";
  dialogImages.forEach((entry, idx) => {
    const div = document.createElement("div");
    div.className = "img-wrap";
    div.innerHTML = `<img src="${entry.dataURL}"><button type="button" class="img-del" title="削除">✕</button>`;
    div.querySelector(".img-del").addEventListener("click", () => {
      dialogImages.splice(idx, 1);
      renderDialogImages();
    });
    wrap.appendChild(div);
  });
}

async function addDialogImageFiles(files) {
  for (const f of files) {
    try {
      dialogImages.push({ dataURL: await compressImage(f) });
    } catch (err) {
      alert("画像の取り込みに失敗しました: " + err.message);
    }
  }
  renderDialogImages();
}

$("#itemDialog").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  addDialogImageFiles(files);
});
$("#pasteZone").addEventListener("click", (e) => {
  if (e.target.tagName !== "INPUT") $("#pasteZone").focus();
});
$("#fImages").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  addDialogImageFiles(files);
});

$("#itemCancelBtn").addEventListener("click", () => $("#itemDialog").close());

$("#itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  let name = $("#fName").value.trim();
  if (!name) {
    // スポットはURLがあれば名前を自動取得するので未入力OK
    if (dialogKind === "spot" && $("#fUrl").value.trim()) name = PENDING_NAME;
    else { alert("名前を入力してください"); return; }
  }
  const priceRaw = $("#fPrice").value;
  const specs = [...document.querySelectorAll("#specRows .spec-row")]
    .map((r) => ({ k: r.querySelector(".spec-k").value.trim(), v: r.querySelector(".spec-v").value.trim() }))
    .filter((s) => s.k || s.v);

  // 画像: 新規分を保存し、外された既存分を削除
  const imageIds = [];
  for (const entry of dialogImages) {
    imageIds.push(entry.id || await saveNewImage(entry.dataURL));
  }
  if (editingItem) {
    for (const oldId of editingItem.images || []) {
      if (!imageIds.includes(oldId)) {
        await dbDelete("images", oldId);
        imagesById.delete(oldId);
      }
    }
  }

  const base = editingItem || { id: uuid(), createdAt: Date.now(), order: wishItems.length };
  const item = {
    ...base,
    kind: dialogKind,
    name,
    price: priceRaw === "" ? null : Number(priceRaw),
    category: $("#fCategory").value.trim(),
    genre: $("#fGenre").value.trim(),
    url: $("#fUrl").value.trim(),
    memo: $("#fMemo").value.trim(),
    rating: dialogRating,
    specs,
    images: imageIds,
    address: $("#fAddress").value.trim(),
  };
  await dbPut(editingStore, item);

  if (editingStore === "wish") {
    const idx = wishItems.findIndex((x) => x.id === item.id);
    if (idx >= 0) wishItems[idx] = item; else wishItems.push(item);
    renderWish();
    // URLからの自動取得（非同期）: スポットは名前・住所・地域・地図画像 / それ以外は画像・価格・ジャンル
    if (isSpot(item)) {
      if (item.url && (item.name === PENDING_NAME || !item.address || !item.category || !item.images.length)) {
        autoFetchSpotInfo(item.id);
      }
    } else if (item.url && (!item.images.length || item.price == null || !item.genre)) {
      autoFetchProductInfo(item.id);
    }
  } else {
    const idx = boughtItems.findIndex((x) => x.id === item.id);
    if (idx >= 0) boughtItems[idx] = item; else boughtItems.push(item);
    renderBought();
  }
  $("#itemDialog").close();
});

/* ---- 商品URLからの画像自動取得 ----
   ① Microlink API で商品ページのメイン画像(og:image)を取得
      （Amazon・楽天などスクショ生成が効かないECサイトはこちらで取れる）
   ② 取れなければ mShots (WordPress) のページスクショにフォールバック
   どちらも CORS対応プロキシ (images.weserv.nl) 経由で画像を取得する。 */
async function fetchViaWeserv(imageUrl) {
  const prox = "https://images.weserv.nl/?w=1000&output=jpg&url=" + encodeURIComponent(imageUrl);
  const resp = await fetch(prox, { cache: "no-store" });
  if (!resp.ok) return null;
  const blob = await resp.blob();
  if (!blob.type.startsWith("image/") || blob.size < 3000) return null;
  // ロゴやファビコンのような小さすぎる画像は除外
  try {
    const bmp = await createImageBitmap(blob);
    const ok = Math.min(bmp.width, bmp.height) >= 150;
    bmp.close();
    if (!ok) return null;
  } catch (e) { return null; }
  return blob;
}

// ① メタ画像（og:image等）
async function fetchMetaImage(url) {
  try {
    const r = await fetch("https://api.microlink.io/?url=" + encodeURIComponent(url));
    if (!r.ok) return null;
    const j = await r.json();
    const imgUrl = j?.data?.image?.url;
    if (j.status !== "success" || !imgUrl) return null;
    return await fetchViaWeserv(imgUrl);
  } catch (e) {
    return null;
  }
}

// ② ページスクショ（mShots・生成完了までポーリング）
async function fetchUrlScreenshot(url) {
  const mshots = "https://s0.wp.com/mshots/v1/" + encodeURIComponent(url) + "?w=1200";
  const proxied = "https://images.weserv.nl/?url=" + encodeURIComponent(mshots);
  for (let attempt = 0; attempt < 7; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000)); // スクショ生成待ち
    try {
      const resp = await fetch(proxied, { cache: "no-store" });
      if (!resp.ok) continue;
      const blob = await resp.blob();
      // 生成中はGIFのプレースホルダが返る（完成したスクショはJPEG）→ 再試行
      if (blob.type !== "image/gif" && blob.size > 3000) return blob;
    } catch (e) { /* ネットワークエラーは再試行 */ }
  }
  return null;
}

/* ---- スポット: GoogleマップURLからの情報自動取得 ----
   ・スポット名: URLの /maps/place/名前 部分から抽出
   ・短縮リンク(maps.app.goo.gl): Microlinkで展開してから抽出
   ・住所/地域: URL内の座標 @lat,lng を OpenStreetMap Nominatim で逆ジオコーディング
   ・画像: Microlinkが返す地図サムネイル(og:image) */
function parseMapsUrl(u) {
  const out = { name: null, lat: null, lng: null };
  if (!u) return out;
  try {
    const m = u.match(/\/maps\/place\/([^\/@?]+)/);
    if (m) out.name = decodeURIComponent(m[1].replace(/\+/g, " ")).trim();
    const c = u.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (c) { out.lat = c[1]; out.lng = c[2]; }
    const q = u.match(/[?&]q=([^&]+)/);
    if (q) {
      const qv = decodeURIComponent(q[1].replace(/\+/g, " "));
      const ql = qv.match(/^(-?\d+\.?\d*),(-?\d+\.?\d*)$/);
      if (ql) { out.lat = out.lat ?? ql[1]; out.lng = out.lng ?? ql[2]; }
      else if (!out.name) out.name = qv;
    }
  } catch (e) { /* 解析できない形式は無視 */ }
  return out;
}

async function reverseGeocode(lat, lng) {
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&accept-language=ja`);
  if (!r.ok) return null;
  const j = await r.json();
  const a = j.address || {};
  const parts = (j.display_name || "").split(", ").filter((s) => s && s !== "日本" && !/^\d{3}-?\d{4}$/.test(s));
  const pref = a.state || a.province || parts.find((s) => /[都道府県]$/.test(s)) || "";
  const city = a.city || a.town || a.village || a.county || "";
  // 構造化フィールドから日本式住所を組み立て（包含される重複要素は除く）
  let addrParts = [pref, city, a.suburb || a.quarter || "", a.neighbourhood || "", a.road || "", a.house_number || ""].filter(Boolean);
  addrParts = addrParts.filter((p, i) => !addrParts.some((o, oi) => oi !== i && o !== p && o.includes(p)));
  return {
    address: (a.postcode ? "〒" + a.postcode + " " : "") + addrParts.join(""),
    region: pref && city && city !== pref ? `${pref} ${city}` : (pref || city || ""),
  };
}

async function autoFetchSpotInfo(itemId) {
  const item = wishItems.find((x) => x.id === itemId);
  if (!item || !item.url) return;
  toast("📍 スポット情報を取得中...");
  try {
    let parsed = parseMapsUrl(item.url);
    let mapImageUrl = null;
    // Microlinkで短縮リンクの展開と地図サムネイル取得
    try {
      const r = await fetch("https://api.microlink.io/?url=" + encodeURIComponent(item.url));
      if (r.ok) {
        const j = await r.json();
        if (j.status === "success") {
          mapImageUrl = j.data?.image?.url || null;
          const p2 = parseMapsUrl(j.data?.url || "");
          parsed = { name: parsed.name || p2.name, lat: parsed.lat ?? p2.lat, lng: parsed.lng ?? p2.lng };
        }
      }
    } catch (e) { /* Microlink失敗時はURL解析結果だけで続行 */ }

    const cur = wishItems.find((x) => x.id === itemId);
    if (!cur) return;
    let changed = false;

    if (parsed.name && (!cur.name || cur.name === PENDING_NAME)) {
      cur.name = parsed.name;
      changed = true;
    }
    if (parsed.lat != null && (!cur.address || !cur.category)) {
      try {
        const geo = await reverseGeocode(parsed.lat, parsed.lng);
        if (geo) {
          if (!cur.address && geo.address) { cur.address = geo.address; changed = true; }
          if (!cur.category && geo.region) { cur.category = geo.region; changed = true; }
        }
      } catch (e) { /* 住所なしで続行 */ }
    }
    if (!(cur.images || []).length && mapImageUrl) {
      const blob = await fetchViaWeserv(mapImageUrl);
      if (blob) {
        const imgId = await saveNewImage(await compressImage(blob));
        cur.images = [imgId];
        changed = true;
      }
    }
    if (cur.name === PENDING_NAME) {
      cur.name = "（名称を取得できませんでした）";
      changed = true;
    }
    if (changed) {
      await dbPut("wish", cur);
      renderWish();
      toast("📍 スポット情報を登録しました");
    } else {
      toast("⚠️ スポット情報を自動取得できませんでした（手動でも入力できます）");
    }
  } catch (err) {
    console.warn("スポット情報の自動取得に失敗:", err);
    toast("⚠️ スポット情報を自動取得できませんでした（手動でも入力できます）");
  }
}

/* ---- 商品ページHTMLからの価格・ジャンル抽出 ---- */
async function fetchPageHtml(url) {
  const endpoints = [
    "https://corsproxy.io/?url=" + encodeURIComponent(url),
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
  ];
  for (const ep of endpoints) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(ep, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) continue;
      const t = await r.text();
      if (t && t.length > 500) return t;
    } catch (e) { /* 次のプロキシへ */ }
  }
  return null;
}

function extractProductInfo(html) {
  const out = { price: null, genre: "" };
  const setPrice = (v) => {
    const n = Math.round(parseFloat(String(v).replace(/[,，]/g, "")));
    if (out.price == null && n >= 10 && n < 100000000) out.price = n;
  };
  // 1) JSON-LD（schema.org Product / BreadcrumbList）
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const nodes = [];
      const collect = (x) => {
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) return x.forEach(collect);
        nodes.push(x);
        if (x["@graph"]) collect(x["@graph"]);
      };
      collect(JSON.parse(m[1].trim()));
      for (const n of nodes) {
        const types = [].concat(n["@type"] || []);
        if (types.includes("Product")) {
          for (const o of [].concat(n.offers || [])) {
            setPrice(o.price ?? o.lowPrice ?? (o.priceSpecification && o.priceSpecification.price));
          }
          if (!out.genre && typeof n.category === "string") {
            out.genre = n.category.split(/[>\/｜|]/).pop().trim().slice(0, 20);
          }
        }
        if (!out.genre && types.includes("BreadcrumbList") && Array.isArray(n.itemListElement)) {
          const names = n.itemListElement.map((e) => e?.name || e?.item?.name).filter(Boolean).map(String);
          const cand = names.reverse().find((s) => s.length >= 2 && s.length <= 20);
          if (cand) out.genre = cand.trim();
        }
      }
    } catch (e) { /* 壊れたJSON-LDは無視 */ }
  }
  // 2) metaタグの価格
  if (out.price == null) {
    const pm = html.match(/(?:og:price:amount|product:price:amount)["'][^>]*content=["']([\d.,]+)/i)
      || html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)/i);
    if (pm) setPrice(pm[1]);
  }
  // 3) Amazonなど: 価格ブロック付近の¥表記
  if (out.price == null) {
    const ci = html.search(/corePrice|priceToPay|apex_desktop/);
    if (ci >= 0) {
      const pm = html.slice(ci, ci + 20000).match(/[￥¥]\s*([\d,]{3,})/);
      if (pm) setPrice(pm[1]);
    }
  }
  // 4) 汎用: ページ内で2回以上出てくる¥金額の最頻値
  if (out.price == null) {
    const counts = {};
    for (const m of html.matchAll(/[￥¥]\s*([\d,]{3,})/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    const best = Object.entries(counts).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])[0];
    if (best) setPrice(best[0]);
  }
  // 5) Amazonのパンくずからジャンル
  if (!out.genre) {
    const bi = html.indexOf("wayfinding-breadcrumbs");
    if (bi >= 0) {
      const seg = html.slice(bi, bi + 6000);
      const names = [...seg.matchAll(/<a[^>]*>\s*([^<>{}]{2,20}?)\s*<\/a>/g)].map((x) => x[1].trim()).filter(Boolean);
      if (names.length) out.genre = names[names.length - 1];
    }
  }
  return out;
}

// もの・やりたいこと: URLから画像・価格・ジャンルをまとめて自動入力
async function autoFetchProductInfo(itemId) {
  const item = wishItems.find((x) => x.id === itemId);
  if (!item || !item.url || isSpot(item)) return;
  const needImage = !(item.images || []).length;
  const needPrice = item.price == null;
  const needGenre = !item.genre;
  if (!needImage && !needPrice && !needGenre) return;
  toast("🔎 商品情報を取得中...（少し時間がかかることがあります）");
  try {
    let info = { price: null, genre: "" };
    if (needPrice || needGenre) {
      const html = await fetchPageHtml(item.url);
      if (html) info = extractProductInfo(html);
    }
    let blob = null;
    if (needImage) {
      blob = await fetchMetaImage(item.url);
      if (!blob) blob = await fetchUrlScreenshot(item.url);
    }
    // 取得中のユーザー編集を上書きしないよう、最新の状態に反映
    const cur = wishItems.find((x) => x.id === itemId);
    if (!cur) return;
    const got = [];
    if (blob && !(cur.images || []).length) {
      const imgId = await saveNewImage(await compressImage(blob));
      cur.images = [imgId];
      got.push("画像");
    }
    if (needPrice && cur.price == null && info.price != null) { cur.price = info.price; got.push("価格 " + yen(info.price)); }
    if (needGenre && !cur.genre && info.genre) { cur.genre = info.genre; got.push(`ジャンル「${info.genre}」`); }
    if (got.length) {
      await dbPut("wish", cur);
      renderWish();
      toast("🔎 " + got.join("・") + " を自動入力しました");
    } else {
      toast("⚠️ 商品情報を自動取得できませんでした（手動で入力できます）");
    }
  } catch (err) {
    console.warn("商品情報の自動取得に失敗:", err);
    toast("⚠️ 商品情報を自動取得できませんでした（手動で入力できます）");
  }
}

$("#addWishBtn").addEventListener("click", () => openItemDialog("wish", null));
$("#wishSort").addEventListener("change", (e) => {
  wishSortMode = e.target.value;
  renderWish();
});
$("#kindFilter").addEventListener("change", (e) => {
  activeKind = e.target.value;
  renderWish();
});

/* ============================================================
   買ったものリスト（使用記録・コスパ）
   ============================================================ */
async function loadBought() {
  boughtItems = await dbGetAll("bought");
  renderBought();
}

function cospaOf(item) {
  const uses = (item.usages || []).length;
  if (!uses || item.price == null) return null;
  return item.price / uses;
}

function sortedBought() {
  const list = [...boughtItems];
  switch (boughtSortMode) {
    case "cospaAsc": list.sort((a, b) => (cospaOf(a) ?? Infinity) - (cospaOf(b) ?? Infinity)); break;
    case "cospaDesc": list.sort((a, b) => (cospaOf(b) ?? -1) - (cospaOf(a) ?? -1)); break;
    case "usageDesc": list.sort((a, b) => (b.usages || []).length - (a.usages || []).length); break;
    default: list.sort((a, b) => (b.purchasedAt || "").localeCompare(a.purchasedAt || "")); break;
  }
  return list;
}

function buildBoughtCard(item) {
    const uses = (item.usages || []).length;
    const cospa = cospaOf(item);
    const card = document.createElement("div");
    card.className = "item-card";
    card.dataset.id = item.id;

    card.innerHTML = `
      ${thumbHtmlOf(item)}
      <div class="card-body">
        <div class="c-name">${esc(item.name)}</div>
        ${isSpot(item) && item.price == null ? "" : `<div class="c-price ${item.price == null ? "no-price" : ""}">${item.price != null ? yen(item.price) : "価格未設定"}</div>`}
        <div class="badges">
          ${isKoto(item) ? `<span class="badge koto">✨ やりたいこと</span>` : ""}
          ${isSpot(item) ? `<span class="badge spot">📍 スポット</span>` : ""}
          ${item.category ? `<span class="badge">${esc(item.category)}</span>` : ""}
          ${item.genre ? `<span class="badge genre">${esc(item.genre)}</span>` : ""}
          <span class="badge">${isSpot(item) ? "訪問" : isKoto(item) ? "実施" : "購入"}: ${item.purchasedAt ? fmtDate(item.purchasedAt) : "不明"}</span>
          ${item.kakeiboSyncedAt ? `<span class="badge best">💰 家計簿済</span>` : ""}
        </div>
        ${item.address ? `<div class="c-address">📍 ${esc(item.address)}</div>` : ""}
        <div class="cospa-box ${cospa == null ? "no-usage" : ""}">
          ${cospa != null
            ? `<div class="cospa-main">1回あたり ${yen(Math.round(cospa))}</div><div class="cospa-sub">${isSpot(item) ? "訪問" : "使用"} ${uses} 回（最終: ${fmtDate(item.usages[item.usages.length - 1])}）</div>`
            : uses > 0
              ? `<div>${isSpot(item) ? "訪問" : "使用"} ${uses} 回${item.price == null ? "" : ""}（最終: ${fmtDate(item.usages[item.usages.length - 1])}）</div>`
              : `<div>まだ${isSpot(item) ? "訪問" : "使用"}記録がありません</div>`}
        </div>
        ${item.url ? `<a class="c-link" href="${esc(item.url)}" target="_blank" rel="noopener">${isSpot(item) ? "🗺️ 地図を開く" : `🔗 ${isKoto(item) ? "ページ" : "商品ページ"}を開く`}</a>` : ""}
        <div class="card-actions">
          <button class="buy-btn u-log">📅 ${isSpot(item) ? "訪問記録" : "使用記録"}</button>
          <button class="edit-btn k-sync" title="家計簿「遊び代管理」に追加">💰</button>
          <button class="edit-btn">✏️ 編集</button>
          <button class="edit-btn u-back" title="ほしいものリストに戻す">↩</button>
          <button class="danger-btn c-del">🗑</button>
        </div>
      </div>`;

    const img = card.querySelector(".thumb");
    if (img) img.addEventListener("click", () => openViewer(item.images));
    card.querySelector(".u-log").addEventListener("click", () => openUsageDialog(item));
    card.querySelector(".k-sync").addEventListener("click", () => openKakeiboDialog(item));
    card.querySelector(".edit-btn:not(.u-back):not(.k-sync)").addEventListener("click", () => openItemDialog("bought", item));
    card.querySelector(".u-back").addEventListener("click", async () => {
      if (!confirm(`「${item.name}」を「ほしい・やりたい」リストに戻しますか？（使用記録は消えます）`)) return;
      const wish = { ...item, order: wishItems.length };
      delete wish.purchasedAt;
      delete wish.usages;
      await dbPut("wish", wish);
      await dbDelete("bought", item.id);
      boughtItems = boughtItems.filter((x) => x.id !== item.id);
      wishItems.push(wish);
      renderBought();
      renderWish();
    });
    card.querySelector(".c-del").addEventListener("click", async () => {
      if (!confirm(`「${item.name}」を削除しますか？`)) return;
      await deleteItemImages(item);
      await dbDelete("bought", item.id);
      boughtItems = boughtItems.filter((x) => x.id !== item.id);
      renderBought();
    });
    return card;
}

function renderBought() {
  const grid = $("#boughtGrid");
  grid.innerHTML = "";
  sortedBought().filter((x) => !isSpot(x)).forEach((item) => grid.appendChild(buildBoughtCard(item)));
  $("#boughtEmpty").classList.toggle("hidden", boughtItems.some((x) => !isSpot(x)));
  renderSpots();
}

/* ============================================================
   スポットタブ（行きたい / 行った）
   ============================================================ */
function renderSpots() {
  const grid = $("#spotGrid");
  if (!grid) return;
  $("#spotViewSwitch").classList.toggle("went", spotView === "went");
  document.querySelectorAll("#spotViewSwitch button").forEach((b) => b.classList.toggle("active", b.dataset.view === spotView));

  const src = (spotView === "want" ? wishItems : boughtItems).filter(isSpot);

  // 地域チップ
  const chipWrap = $("#spotRegionChips");
  chipWrap.innerHTML = "";
  const regions = [...new Set(src.map((x) => x.category || "未分類"))].sort((a, b) => a.localeCompare(b, "ja"));
  if (spotRegion !== "all" && !regions.includes(spotRegion)) spotRegion = "all";
  const mkChip = (label, value) => {
    const b = document.createElement("button");
    b.className = "chip" + (spotRegion === value ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", () => { spotRegion = value; renderSpots(); });
    return b;
  };
  chipWrap.appendChild(mkChip("すべて", "all"));
  regions.forEach((r) => chipWrap.appendChild(mkChip(r, r)));

  let list = src;
  if (spotRegion !== "all") list = list.filter((x) => (x.category || "未分類") === spotRegion);
  if (spotSortMode === "region") {
    list = [...list].sort((a, b) => (a.category || "未分類").localeCompare(b.category || "未分類", "ja"));
  } else {
    list = [...list].sort((a, b) => spotView === "went"
      ? (b.purchasedAt || "").localeCompare(a.purchasedAt || "")
      : (b.createdAt || 0) - (a.createdAt || 0));
  }

  grid.innerHTML = "";
  list.forEach((item) => grid.appendChild(spotView === "want" ? buildWishCard(item, false) : buildBoughtCard(item)));

  const empty = $("#spotEmpty");
  empty.classList.toggle("hidden", src.length > 0);
  empty.innerHTML = spotView === "want"
    ? "行きたいスポットはまだありません。<br>「＋ スポットを追加」からGoogleマップのURLを貼って登録してください。"
    : "行ったスポットはまだありません。<br>「🚩 行きたい」側の「🚩 行った！」ボタンから記録できます。";
}

$("#addSpotBtn").addEventListener("click", () => openItemDialog("wish", null, "spot"));
document.querySelectorAll("#spotViewSwitch button").forEach((b) => {
  b.addEventListener("click", () => {
    spotView = b.dataset.view;
    renderSpots();
  });
});
$("#spotSort").addEventListener("change", (e) => {
  spotSortMode = e.target.value;
  renderSpots();
});

$("#boughtSort").addEventListener("change", (e) => {
  boughtSortMode = e.target.value;
  renderBought();
});

/* ---- 使用記録ダイアログ ---- */
let usageItem = null;

function openUsageDialog(item) {
  usageItem = item;
  const label = isSpot(item) ? "訪問記録" : "使用記録";
  $("#usageDialogTitle").textContent = `📅 ${label}: ${item.name}`;
  $("#useTodayBtn").textContent = isSpot(item) ? "✅ 今日行った" : "✅ 今日使った";
  $("#usageDate").value = todayISO();
  renderUsage();
  $("#usageDialog").showModal();
}

function renderUsage() {
  const item = usageItem;
  const uses = (item.usages || []).slice().sort();
  const cospa = cospaOf(item);
  const w = isSpot(item) ? "訪問" : "使用";
  $("#usageStats").innerHTML = `
    ${w}回数: <span class="big">${uses.length} 回</span>
    ${cospa != null ? ` ／ コスパ: <span class="big">1回あたり ${yen(Math.round(cospa))}</span>` : ""}
    ${item.price != null ? `<div class="hint">価格 ${yen(item.price)} ÷ ${w} ${uses.length} 回</div>` : isSpot(item) ? "" : `<div class="hint">価格を設定するとコスパが計算されます</div>`}`;
  const ul = $("#usageList");
  ul.innerHTML = "";
  uses.slice().reverse().forEach((d) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${fmtDate(d)}</span><button class="danger-btn">削除</button>`;
    li.querySelector("button").addEventListener("click", async () => {
      const idx = item.usages.indexOf(d);
      if (idx >= 0) item.usages.splice(idx, 1);
      await dbPut("bought", item);
      renderUsage();
      renderBought();
    });
    ul.appendChild(li);
  });
}

async function addUsage(dateISO) {
  if (!usageItem.usages) usageItem.usages = [];
  usageItem.usages.push(dateISO);
  await dbPut("bought", usageItem);
  renderUsage();
  renderBought();
}
$("#useTodayBtn").addEventListener("click", () => addUsage(todayISO()));
$("#useDateBtn").addEventListener("click", () => {
  if ($("#usageDate").value) addUsage($("#usageDate").value);
});
$("#usageCloseBtn").addEventListener("click", () => $("#usageDialog").close());

/* ============================================================
   ジャンル比較
   ============================================================ */
$("#compareBtn").addEventListener("click", () => {
  const genres = getComparableGenres();
  const sel = $("#compareGenre");
  sel.innerHTML = genres.length
    ? genres.map((g) => `<option value="${esc(g)}">${esc(g)}（${wishItems.filter((x) => x.genre === g).length}件）</option>`).join("")
    : `<option value="">比較できるジャンルがありません</option>`;
  renderCompare();
  $("#compareDialog").showModal();
});
$("#compareGenre").addEventListener("change", renderCompare);
$("#compareCloseBtn").addEventListener("click", () => $("#compareDialog").close());

function getComparableGenres() {
  const count = {};
  wishItems.filter((x) => !isSpot(x)).forEach((x) => {
    if (x.genre) count[x.genre] = (count[x.genre] || 0) + 1;
  });
  return Object.keys(count).filter((g) => count[g] >= 2).sort((a, b) => a.localeCompare(b, "ja"));
}

function renderCompare() {
  const genre = $("#compareGenre").value;
  const box = $("#compareResult");
  const group = wishItems.filter((x) => !isSpot(x) && x.genre === genre);
  if (!genre || group.length < 2) {
    box.innerHTML = `<p class="hint">同じジャンルを設定したほしいものが2件以上あると比較できます。<br>各アイテムの「編集」からジャンル（例: ヘアアイロン）を設定してください。</p>`;
    return;
  }

  const specKeys = [];
  group.forEach((it) => (it.specs || []).forEach((s) => {
    if (s.k && !specKeys.includes(s.k)) specKeys.push(s.k);
  }));

  const prices = group.filter((x) => x.price != null && x.price > 0).map((x) => x.price);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxRating = Math.max(...group.map((x) => x.rating || 0));

  let html = `<div class="compare-table-wrap"><table class="compare-table"><thead><tr><th></th>`;
  group.forEach((it) => { html += `<th>${esc(it.name)}</th>`; });
  html += `</tr></thead><tbody>`;

  html += `<tr><td>画像</td>`;
  group.forEach((it) => {
    const src = it.images && it.images.length ? imgSrc(it.images[0]) : "";
    html += `<td>${src ? `<img src="${src}" data-viewer="${esc(it.id)}">` : "—"}</td>`;
  });
  html += `</tr>`;

  html += `<tr><td>価格</td>`;
  group.forEach((it) => {
    const isBest = it.price != null && it.price === minPrice && prices.length >= 2;
    html += `<td class="${isBest ? "best-cell" : ""}">${it.price != null ? yen(it.price) + (isBest ? " 🏆最安" : "") : "未設定"}</td>`;
  });
  html += `</tr>`;

  html += `<tr><td>ほしい度</td>`;
  group.forEach((it) => {
    const isBest = (it.rating || 0) === maxRating && maxRating > 0;
    html += `<td class="${isBest ? "best-cell" : ""}">${it.rating ? "★".repeat(it.rating) : "—"}</td>`;
  });
  html += `</tr>`;

  specKeys.forEach((key) => {
    const values = group.map((it) => {
      const s = (it.specs || []).find((x) => x.k === key);
      return s ? s.v : null;
    });
    const nums = values.map((v) => (v != null ? parseFloat(String(v).replace(/[,¥]/g, "")) : NaN));
    const validNums = nums.filter((n) => !isNaN(n));
    const allNumeric = validNums.length >= 2 && new Set(validNums).size > 1;
    const maxNum = allNumeric ? Math.max(...validNums) : null;
    html += `<tr><td>${esc(key)}</td>`;
    values.forEach((v, i) => {
      const hl = allNumeric && !isNaN(nums[i]) && nums[i] === maxNum;
      html += `<td class="${hl ? "best-cell" : ""}">${v != null ? esc(v) : "—"}</td>`;
    });
    html += `</tr>`;
  });

  html += `<tr><td>リンク</td>`;
  group.forEach((it) => {
    html += `<td>${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">商品ページ</a>` : "—"}</td>`;
  });
  html += `</tr></tbody></table></div>`;
  if (specKeys.length) html += `<p class="hint">※ 数値スペックは大きい値を強調表示しています（軽さなど小さい方が良い項目はご注意ください）</p>`;

  const { best, reasons, scored } = pickBest(group);
  html += `<div class="verdict"><h3>🏆 おすすめ: ${esc(best.name)}</h3>`;
  if (reasons.length) html += `<div>${esc(reasons.join("、"))}</div>`;
  html += `<ul>`;
  scored.forEach((s) => {
    const strengths = [];
    if (s.item.price != null && s.item.price === minPrice && prices.length >= 2) strengths.push("最安");
    if ((s.item.rating || 0) === maxRating && maxRating > 0) strengths.push(`ほしい度★${s.item.rating}`);
    const specCount = (s.item.specs || []).length;
    if (specCount) strengths.push(`スペック${specCount}項目`);
    html += `<li><b>${esc(s.item.name)}</b> — 総合スコア ${(s.total * 100).toFixed(0)}点${strengths.length ? `（${esc(strengths.join(" / "))}）` : ""}</li>`;
  });
  html += `</ul>`;
  const cheapest = prices.length >= 2 ? group.find((x) => x.price === minPrice) : null;
  if (cheapest && cheapest.id !== best.id) {
    html += `<div>💡 価格重視なら <b>${esc(cheapest.name)}</b>（${yen(cheapest.price)}）もおすすめです。</div>`;
  }
  html += `<p class="hint">※ 判定は「価格の安さ 50% + ほしい度 35% + スペック充実度 15%」で機械的に採点しています。</p></div>`;

  box.innerHTML = html;
  box.querySelectorAll("img[data-viewer]").forEach((img) => {
    img.addEventListener("click", () => {
      const it = group.find((x) => x.id === img.dataset.viewer);
      if (it) openViewer(it.images);
    });
  });
}

/* ============================================================
   カテゴリごとのおすすめ
   ============================================================ */
$("#recommendBtn").addEventListener("click", () => {
  renderRecommend();
  $("#recommendDialog").showModal();
});
$("#recommendCloseBtn").addEventListener("click", () => $("#recommendDialog").close());

function renderRecommend() {
  const box = $("#recommendResult");
  const byCat = {};
  wishItems.filter((x) => !isSpot(x)).forEach((x) => {
    const c = x.category || "未分類";
    (byCat[c] = byCat[c] || []).push(x);
  });
  const cats = Object.keys(byCat).sort((a, b) => a.localeCompare(b, "ja"));
  if (!cats.length) {
    box.innerHTML = `<p class="hint">ほしいものが登録されていません。</p>`;
    return;
  }
  box.innerHTML = "";
  cats.forEach((cat) => {
    const group = byCat[cat];
    const { best, reasons } = pickBest(group);
    const div = document.createElement("div");
    div.className = "rec-block";
    const src = best.images && best.images.length ? imgSrc(best.images[0]) : "";
    div.innerHTML = `
      <h3>${esc(cat)}（${group.length}件）</h3>
      <div class="rec-pick">
        ${src ? `<img src="${src}">` : ""}
        <div>
          <div class="rec-name">🏆 ${esc(best.name)}${best.price != null ? ` — ${yen(best.price)}` : ""}</div>
          <div class="rec-why">${esc(reasons.join("、") || (group.length === 1 ? "このカテゴリ唯一の候補" : "総合スコア1位"))}</div>
        </div>
      </div>`;
    box.appendChild(div);
  });
}

/* ============================================================
   画像ビューア
   ============================================================ */
let viewerImages = []; // 画像IDの配列
let viewerIdx = 0;

function openViewer(imageIds) {
  const ids = (imageIds || []).filter((id) => imagesById.get(id));
  if (!ids.length) return;
  viewerImages = ids;
  viewerIdx = 0;
  showViewerImg();
  $("#imageViewer").showModal();
}
function showViewerImg() {
  $("#viewerImg").src = imgSrc(viewerImages[viewerIdx]);
}
$("#viewerImg").addEventListener("click", () => {
  if (viewerImages.length > 1) {
    viewerIdx = (viewerIdx + 1) % viewerImages.length;
    showViewerImg();
  }
});
$("#viewerCloseBtn").addEventListener("click", () => $("#imageViewer").close());

/* ============================================================
   バックアップ（エクスポート／インポート）
   ============================================================ */
function dataURLToBlob(dataUrl) {
  return fetch(dataUrl).then((r) => r.blob());
}

async function buildExportData() {
  const withImages = (items) => items.map((it) => ({
    ...it,
    images: (it.images || []).map((id) => imagesById.get(id)).filter(Boolean),
  }));
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    shopping: shoppingItems,
    wish: withImages(wishItems),
    bought: withImages(boughtItems),
  };
}

async function restoreFromData(data) {
  await dbClear("shopping");
  await dbClear("wish");
  await dbClear("bought");
  await dbClear("images");
  imagesById = new Map();

  const restoreItems = async (items, store) => {
    for (const it of items || []) {
      const ids = [];
      for (const src of it.images || []) {
        // 大きい画像（旧バックアップのPNG等）は取り込み時に再圧縮
        const dataUrl = src.length > 400000 ? await compressImage(await dataURLToBlob(src)) : src;
        ids.push(await saveNewImage(dataUrl));
      }
      await dbPut(store, { ...it, images: ids });
    }
  };
  for (const it of data.shopping || []) await dbPut("shopping", it);
  await restoreItems(data.wish, "wish");
  await restoreItems(data.bought, "bought");
  await loadAllData();
}

$("#exportBtn").addEventListener("click", async () => {
  if (!currentUser) return;
  const data = await buildExportData();
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `お買い物マネージャー_backup_${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !currentUser) return;
  if (!confirm("現在のデータをすべて置き換えて復元します。よろしいですか？")) return;
  try {
    const data = JSON.parse(await file.text());
    await restoreFromData(data);
    alert("復元が完了しました。");
  } catch (err) {
    alert("復元に失敗しました: " + err.message);
  }
});

/* ============================================================
   家計簿「遊び代管理」連携
   - 家計簿側: users/{uid}/data/state の1ドキュメントに
     expenses: [{id, amount, date, categoryId, note, isFromReceipt}]
     categories: [{id, name, icon, color}] を保持
   - 同じGoogleアカウントでログインすればUIDが一致する
   ============================================================ */
const KAKEIBO_CONFIG = {
  apiKey: "AIzaSyADydfhaPwCNBd_CO2c5qQM0ONmr-FTEZQ",
  authDomain: "kakeibo-21cf0.firebaseapp.com",
  projectId: "kakeibo-21cf0",
  storageBucket: "kakeibo-21cf0.firebasestorage.app",
  messagingSenderId: "558811122568",
  appId: "1:558811122568:web:4e08fca088a1eb9579483d",
};
// 家計簿アプリのデフォルトカテゴリ（state未取得時のフォールバック）
const KAKEIBO_DEF_CATS = [
  { id: "c1", name: "食事", icon: "🍜" },
  { id: "c2", name: "エンタメ", icon: "🎮" },
  { id: "c3", name: "ショッピング", icon: "🛍️" },
  { id: "c4", name: "カフェ", icon: "☕" },
  { id: "c5", name: "交通", icon: "🚃" },
  { id: "c6", name: "その他", icon: "💬" },
];

let kApp = null, kAuth = null, kDb = null, kUser = null;

// 買い物アプリ自体が家計簿と同じFirebaseプロジェクトなら追加ログイン不要
const kakeiboSameProject = () => {
  const c = getFirebaseConfig();
  return !!(c && c.projectId === KAKEIBO_CONFIG.projectId);
};
const getKUser = () => (kakeiboSameProject() ? currentUser : kUser);

function initKakeibo() {
  if (typeof firebase === "undefined") return;
  if (kakeiboSameProject()) {
    if (fapp && !kDb) { kApp = fapp; kAuth = fauth; kDb = fdb; }
    return;
  }
  if (kApp) return;
  kApp = firebase.apps.find((a) => a.name === "kakeibo") || firebase.initializeApp(KAKEIBO_CONFIG, "kakeibo");
  kAuth = kApp.auth();
  kDb = kApp.firestore();
  kAuth.onAuthStateChanged((u) => {
    kUser = u;
    if ($("#kakeiboDialog").open) renderKakeiboDialog();
  });
}

async function kakeiboLogin() {
  initKakeibo();
  if (kakeiboSameProject()) return;
  await kAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
}

const kStateRef = () => kDb.collection("users").doc(getKUser().uid).collection("data").doc("state");

async function fetchKakeiboState() {
  const snap = await kStateRef().get();
  return snap.exists ? snap.data() : null;
}

function kakeiboCategories(state) {
  return state && Array.isArray(state.categories) && state.categories.length
    ? state.categories
    : KAKEIBO_DEF_CATS;
}

// ジャンル/カテゴリ名 → 家計簿カテゴリの自動マッチング
function matchKakeiboCategory(cats, item) {
  const names = [item.genre, item.category].filter(Boolean);
  for (const n of names) {
    const hit = cats.find((c) => c.name === n) || cats.find((c) => c.name.includes(n) || n.includes(c.name));
    if (hit) return hit;
  }
  return cats.find((c) => c.name === "ショッピング") || cats[cats.length - 1];
}

function buildKakeiboExpense(item, { amount, dateISO, categoryId, note }) {
  return {
    id: Date.now().toString(),
    amount,
    date: dateISO,
    categoryId,
    note,
    isFromReceipt: false,
  };
}

async function kakeiboAddExpense(exp) {
  const ref = kStateRef();
  try {
    await ref.update({ expenses: firebase.firestore.FieldValue.arrayUnion(exp) });
  } catch (e) {
    // stateドキュメント未作成（家計簿を一度も使っていないアカウント）の場合
    await ref.set({ expenses: [exp] }, { merge: true });
  }
}

async function markKakeiboSynced(item, expId) {
  item.kakeiboExpenseId = expId;
  item.kakeiboSyncedAt = Date.now();
  await dbPut("bought", item);
  renderBought();
}

const kakeiboAutoSyncOn = () => localStorage.getItem("kakeiboAutoSync") === "1";

// 「買った！」直後の自動同期（失敗しても買い物アプリ側の処理は止めない）
async function autoKakeiboSync(item) {
  try {
    if (!kakeiboAutoSyncOn() || item.price == null) return;
    initKakeibo();
    if (!getKUser() || !kDb) return; // 家計簿側に未ログインなら手動(💰)に任せる
    const state = await fetchKakeiboState();
    const cat = matchKakeiboCategory(kakeiboCategories(state), item);
    const exp = buildKakeiboExpense(item, {
      amount: item.price,
      dateISO: new Date(item.purchasedAt + "T12:00:00").toISOString(),
      categoryId: cat.id,
      note: item.name + (item.genre ? `（${item.genre}）` : ""),
    });
    await kakeiboAddExpense(exp);
    await markKakeiboSynced(item, exp.id);
    toast(`💰 家計簿に自動追加しました（${cat.name}・${yen(item.price)}）`);
  } catch (err) {
    console.warn("家計簿への自動同期に失敗:", err);
    toast("⚠️ 家計簿への自動同期に失敗しました。💰ボタンから手動で追加できます");
  }
}

/* ---- 手動同期ダイアログ ---- */
let kakeiboItem = null;
let kakeiboCats = KAKEIBO_DEF_CATS;

function openKakeiboDialog(item) {
  kakeiboItem = item;
  initKakeibo();
  renderKakeiboDialog();
  $("#kakeiboDialog").showModal();
  if (getKUser() && kDb) {
    fetchKakeiboState()
      .then((state) => { kakeiboCats = kakeiboCategories(state); renderKakeiboDialog(); })
      .catch((err) => {
        $("#kakeiboBody").insertAdjacentHTML("afterbegin",
          `<p class="hint" style="color:#ef4444">家計簿データの取得に失敗しました: ${esc(err.message)}</p>`);
      });
  }
}

function renderKakeiboDialog() {
  const item = kakeiboItem;
  const body = $("#kakeiboBody");
  const submitBtn = $("#kakeiboSubmitBtn");
  if (!item) return;

  if (!getKUser()) {
    body.innerHTML = `
      <p class="hint">家計簿「遊び代管理」と同じGoogleアカウントでログインすると、支出データを追加できます（初回のみ）。</p>`;
    submitBtn.textContent = "Googleでログイン（家計簿側）";
    return;
  }

  const matched = matchKakeiboCategory(kakeiboCats, item);
  const syncedWarn = item.kakeiboSyncedAt
    ? `<p class="hint" style="color:#b45309">⚠️ この商品は ${new Date(item.kakeiboSyncedAt).toLocaleString("ja-JP")} に同期済みです。もう一度追加すると家計簿に二重登録されます。</p>`
    : "";
  body.innerHTML = `
    ${syncedWarn}
    <div class="form-grid">
      <label>金額（円）<input type="number" id="kAmount" min="1" value="${item.price != null ? item.price : ""}" placeholder="金額を入力"></label>
      <label>日付<input type="date" id="kDate" value="${esc(item.purchasedAt || todayISO())}"></label>
      <label class="full">家計簿カテゴリ
        <select id="kCategory">
          ${kakeiboCats.map((c) => `<option value="${esc(c.id)}" ${c.id === matched.id ? "selected" : ""}>${esc(c.icon || "")} ${esc(c.name)}</option>`).join("")}
        </select>
      </label>
      <label class="full">メモ<input type="text" id="kNote" value="${esc(item.name + (item.genre ? `（${item.genre}）` : ""))}"></label>
    </div>
    <label class="auto-sync-row">
      <input type="checkbox" id="kAutoSync" ${kakeiboAutoSyncOn() ? "checked" : ""}>
      今後「🛒 買った！」を押したら自動で家計簿にも追加する
    </label>`;
  submitBtn.textContent = "家計簿に追加";
  $("#kAutoSync").addEventListener("change", (e) => {
    localStorage.setItem("kakeiboAutoSync", e.target.checked ? "1" : "0");
  });
}

$("#kakeiboCancelBtn").addEventListener("click", () => $("#kakeiboDialog").close());
$("#kakeiboSubmitBtn").addEventListener("click", async () => {
  const item = kakeiboItem;
  if (!item) return;
  if (!getKUser()) {
    try {
      await kakeiboLogin();
      renderKakeiboDialog();
      const state = await fetchKakeiboState();
      kakeiboCats = kakeiboCategories(state);
      renderKakeiboDialog();
    } catch (err) {
      if (err.code !== "auth/popup-closed-by-user") alert("ログインに失敗しました: " + (err.message || err.code));
    }
    return;
  }
  const amount = Number($("#kAmount").value);
  if (!amount || amount <= 0) { alert("金額を入力してください"); return; }
  const dateVal = $("#kDate").value || todayISO();
  if (item.kakeiboSyncedAt && !confirm("同期済みの商品です。家計簿にもう1件追加しますか？")) return;
  try {
    const exp = buildKakeiboExpense(item, {
      amount,
      dateISO: new Date(dateVal + "T12:00:00").toISOString(),
      categoryId: $("#kCategory").value,
      note: $("#kNote").value.trim(),
    });
    await kakeiboAddExpense(exp);
    await markKakeiboSynced(item, exp.id);
    $("#kakeiboDialog").close();
    toast(`💰 家計簿に追加しました（${yen(amount)}）`);
  } catch (err) {
    alert("家計簿への追加に失敗しました: " + (err.message || err.code) +
      "\n家計簿アプリと同じGoogleアカウントでログインしているか確認してください。");
  }
});

/* ---- トースト通知 ---- */
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 350);
  }, 3200);
}

/* ============================================================
   ログイン / ログアウト / ゲート
   ============================================================ */
const G_LOGO = `<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

async function googleLogin() {
  if (location.protocol === "file:") {
    alert("ログインはファイル直開きでは使えません。\n「起動.bat」または公開URLから開いてください。");
    return;
  }
  if (typeof firebase === "undefined") {
    alert("Firebaseの読み込みに失敗しました。インターネット接続を確認してページを再読み込みしてください。");
    return;
  }
  initFirebase();
  try {
    await fauth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    // 画面の更新は onAuthStateChanged が行う
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      alert("ログインに失敗しました: " + (err.message || err.code));
    }
  }
}

function googleLogout() {
  if (fauth) fauth.signOut();
}

function updateGate() {
  const loggedIn = !!currentUser;
  $("#loginGate").hidden = loggedIn;
  document.body.classList.toggle("locked", !loggedIn);
}

function renderAuth() {
  updateGate();
  const area = $("#authArea");
  if (currentUser) {
    const tip = esc([currentUser.displayName, currentUser.email].filter(Boolean).join(" / "));
    area.innerHTML = `
      ${currentUser.photoURL
        ? `<img class="avatar" src="${esc(currentUser.photoURL)}" alt="" title="${tip}" referrerpolicy="no-referrer">`
        : `<span class="avatar avatar-ph" title="${tip}">👤</span>`}
      <button id="logoutBtn" class="ghost-btn">ログアウト</button>`;
    $("#logoutBtn").addEventListener("click", googleLogout);
  } else {
    area.innerHTML = `<button id="loginBtn" class="google-btn">${G_LOGO} Googleでログイン</button>`;
    $("#loginBtn").addEventListener("click", googleLogin);
  }
}

/* ============================================================
   起動
   ============================================================ */
function boot() {
  // 全ダイアログの右上に ✕ 閉じるボタンを挿入
  document.querySelectorAll("dialog:not(.image-viewer)").forEach((dlg) => {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "dialog-x";
    x.setAttribute("aria-label", "閉じる");
    x.textContent = "✕";
    x.addEventListener("click", () => dlg.close());
    dlg.prepend(x);
  });

  $("#gateLoginBtn").innerHTML = `${G_LOGO} Googleでログイン`;
  $("#gateLoginBtn").addEventListener("click", googleLogin);
  if (location.protocol === "file:") {
    $("#gateNote").textContent = "※ ファイル直開きではログインできません。「起動.bat」または公開URLから開いてください。";
  }
  renderAuth();
  initFirebase(); // ログイン状態を自動復元
}
boot();
