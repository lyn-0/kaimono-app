/* ============================================================
   お買い物マネージャー
   - 買い物リスト / ほしいものリスト / 買ったものリスト
   - IndexedDB にすべて保存（画像は Blob）
   ============================================================ */
"use strict";

/* ---------------- IndexedDB ---------------- */
const DB_NAME = "kaimono-app";
const DB_VER = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("shopping")) d.createObjectStore("shopping", { keyPath: "id" });
      if (!d.objectStoreNames.contains("wish")) d.createObjectStore("wish", { keyPath: "id" });
      if (!d.objectStoreNames.contains("bought")) d.createObjectStore("bought", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}
function dbGetAll(store) {
  return new Promise((res, rej) => {
    const r = tx(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function dbPut(store, obj) {
  return new Promise((res, rej) => {
    const r = tx(store, "readwrite").put(obj);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
function dbDelete(store, id) {
  return new Promise((res, rej) => {
    const r = tx(store, "readwrite").delete(id);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
function dbClear(store) {
  return new Promise((res, rej) => {
    const r = tx(store, "readwrite").clear();
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
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

// 画像の ObjectURL をリスト（バケット）ごとに管理し、再描画時に自分の分だけ破棄する
const urlBuckets = { wish: [], bought: [], dialog: [] };
function makeUrl(blob, bucket) {
  const u = URL.createObjectURL(blob);
  urlBuckets[bucket].push(u);
  return u;
}
function revokeUrls(bucket) {
  urlBuckets[bucket].forEach((u) => URL.revokeObjectURL(u));
  urlBuckets[bucket] = [];
}

/* ---------------- 状態 ---------------- */
let shoppingItems = [];
let wishItems = [];
let boughtItems = [];
let activeCategory = "all";
let wishSortMode = "manual";
let boughtSortMode = "newest";

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
    // 配列も DOM 順に合わせる
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
  let list = [...wishItems];
  if (activeCategory !== "all") list = list.filter((x) => (x.category || "未分類") === activeCategory);
  switch (wishSortMode) {
    case "priceAsc": list.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)); break;
    case "priceDesc": list.sort((a, b) => (b.price ?? -1) - (a.price ?? -1)); break;
    case "newest": list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); break;
    default: break; // manual: order順のまま
  }
  return list;
}

function renderWish() {
  revokeUrls("wish");
  renderCategoryChips();
  renderCategoryBest();
  const grid = $("#wishGrid");
  grid.innerHTML = "";
  const list = sortedWish();
  const draggable = wishSortMode === "manual";

  list.forEach((item) => {
    const card = buildWishCard(item, draggable);
    grid.appendChild(card);
  });
  $("#wishEmpty").classList.toggle("hidden", wishItems.length > 0);
}

function buildWishCard(item, draggable) {
  const card = document.createElement("div");
  card.className = "item-card";
  card.dataset.id = item.id;
  if (draggable) card.draggable = true;

  const thumbHtml = item.images && item.images.length
    ? `<img class="thumb" src="${makeUrl(item.images[0], "wish")}" alt="">${item.images.length > 1 ? `<span class="thumb-count">📷 ${item.images.length}</span>` : ""}`
    : `<div class="no-thumb">🖼️</div>`;

  card.innerHTML = `
    ${draggable ? `<span class="card-grip" title="ドラッグで並べ替え">⠿</span>` : ""}
    ${thumbHtml}
    <div class="card-body">
      <div class="c-name">${esc(item.name)}</div>
      <div class="c-price ${item.price == null ? "no-price" : ""}">${item.price != null ? yen(item.price) : "価格未設定"}</div>
      <div class="badges">
        ${item.category ? `<span class="badge">${esc(item.category)}</span>` : ""}
        ${item.genre ? `<span class="badge genre">${esc(item.genre)}</span>` : ""}
      </div>
      ${item.rating ? `<div class="c-rating">${"★".repeat(item.rating)}${"☆".repeat(5 - item.rating)}</div>` : ""}
      ${item.url ? `<a class="c-link" href="${esc(item.url)}" target="_blank" rel="noopener">🔗 商品ページを開く</a>` : ""}
      ${item.memo ? `<div class="c-memo">${esc(item.memo)}</div>` : ""}
      <div class="card-actions">
        <button class="buy-btn">🛒 買った！</button>
        <button class="edit-btn">✏️ 編集</button>
        <button class="danger-btn c-del">🗑</button>
      </div>
    </div>`;

  const img = card.querySelector(".thumb");
  if (img) img.addEventListener("click", () => openViewer(item.images));

  card.querySelector(".buy-btn").addEventListener("click", async () => {
    if (!confirm(`「${item.name}」を買ったものリストに移動しますか？`)) return;
    const bought = { ...item, purchasedAt: todayISO(), usages: [] };
    await dbPut("bought", bought);
    await dbDelete("wish", item.id);
    wishItems = wishItems.filter((x) => x.id !== item.id);
    boughtItems.push(bought);
    renderWish();
    renderBought();
  });
  card.querySelector(".edit-btn").addEventListener("click", () => openItemDialog("wish", item));
  card.querySelector(".c-del").addEventListener("click", async () => {
    if (!confirm(`「${item.name}」を削除しますか？`)) return;
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
  const set = new Set(wishItems.map((x) => x.category || "未分類"));
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
  const group = wishItems.filter((x) => (x.category || "未分類") === activeCategory);
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
let dialogImages = [];    // Blob[]
let dialogRating = 0;

function openItemDialog(store, item) {
  editingStore = store;
  editingItem = item || null;
  dialogImages = item ? [...(item.images || [])] : [];
  dialogRating = item ? item.rating || 0 : 0;

  $("#itemDialogTitle").textContent = item ? "アイテムを編集" : "ほしいものを追加";
  $("#fName").value = item ? item.name : "";
  $("#fPrice").value = item && item.price != null ? item.price : "";
  $("#fCategory").value = item ? item.category || "" : "";
  $("#fGenre").value = item ? item.genre || "" : "";
  $("#fUrl").value = item ? item.url || "" : "";
  $("#fMemo").value = item ? item.memo || "" : "";

  // datalist 更新
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
  wrap.querySelectorAll("img").forEach((i) => URL.revokeObjectURL(i.src));
  wrap.innerHTML = "";
  dialogImages.forEach((blob, idx) => {
    const div = document.createElement("div");
    div.className = "img-wrap";
    const url = URL.createObjectURL(blob);
    div.innerHTML = `<img src="${url}"><button type="button" class="img-del" title="削除">✕</button>`;
    div.querySelector(".img-del").addEventListener("click", () => {
      dialogImages.splice(idx, 1);
      renderDialogImages();
    });
    wrap.appendChild(div);
  });
}

$("#itemDialog").addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  let added = false;
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      const blob = it.getAsFile();
      if (blob) { dialogImages.push(blob); added = true; }
    }
  }
  if (added) {
    e.preventDefault();
    renderDialogImages();
  }
});
$("#pasteZone").addEventListener("click", (e) => {
  if (e.target.tagName !== "INPUT") $("#pasteZone").focus();
});
$("#fImages").addEventListener("change", (e) => {
  for (const f of e.target.files) dialogImages.push(f);
  e.target.value = "";
  renderDialogImages();
});

$("#itemCancelBtn").addEventListener("click", () => $("#itemDialog").close());

$("#itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#fName").value.trim();
  if (!name) return;
  const priceRaw = $("#fPrice").value;
  const specs = [...document.querySelectorAll("#specRows .spec-row")]
    .map((r) => ({ k: r.querySelector(".spec-k").value.trim(), v: r.querySelector(".spec-v").value.trim() }))
    .filter((s) => s.k || s.v);

  const base = editingItem || { id: uuid(), createdAt: Date.now(), order: wishItems.length };
  const item = {
    ...base,
    name,
    price: priceRaw === "" ? null : Number(priceRaw),
    category: $("#fCategory").value.trim(),
    genre: $("#fGenre").value.trim(),
    url: $("#fUrl").value.trim(),
    memo: $("#fMemo").value.trim(),
    rating: dialogRating,
    specs,
    images: dialogImages,
  };
  await dbPut(editingStore, item);

  if (editingStore === "wish") {
    const idx = wishItems.findIndex((x) => x.id === item.id);
    if (idx >= 0) wishItems[idx] = item; else wishItems.push(item);
    renderWish();
  } else {
    const idx = boughtItems.findIndex((x) => x.id === item.id);
    if (idx >= 0) boughtItems[idx] = item; else boughtItems.push(item);
    renderBought();
  }
  $("#itemDialog").close();
});

$("#addWishBtn").addEventListener("click", () => openItemDialog("wish", null));
$("#wishSort").addEventListener("change", (e) => {
  wishSortMode = e.target.value;
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

function renderBought() {
  revokeUrls("bought");
  const grid = $("#boughtGrid");
  grid.innerHTML = "";
  sortedBought().forEach((item) => {
    const uses = (item.usages || []).length;
    const cospa = cospaOf(item);
    const card = document.createElement("div");
    card.className = "item-card";
    card.dataset.id = item.id;

    const thumbHtml = item.images && item.images.length
      ? `<img class="thumb" src="${makeUrl(item.images[0], "bought")}" alt="">`
      : `<div class="no-thumb">🖼️</div>`;

    card.innerHTML = `
      ${thumbHtml}
      <div class="card-body">
        <div class="c-name">${esc(item.name)}</div>
        <div class="c-price ${item.price == null ? "no-price" : ""}">${item.price != null ? yen(item.price) : "価格未設定"}</div>
        <div class="badges">
          ${item.category ? `<span class="badge">${esc(item.category)}</span>` : ""}
          ${item.genre ? `<span class="badge genre">${esc(item.genre)}</span>` : ""}
          <span class="badge">購入: ${item.purchasedAt ? fmtDate(item.purchasedAt) : "不明"}</span>
        </div>
        <div class="cospa-box ${cospa == null ? "no-usage" : ""}">
          ${cospa != null
            ? `<div class="cospa-main">1回あたり ${yen(Math.round(cospa))}</div><div class="cospa-sub">使用 ${uses} 回（最終: ${fmtDate(item.usages[item.usages.length - 1])}）</div>`
            : uses > 0
              ? `<div>使用 ${uses} 回（価格未設定のためコスパ計算不可）</div>`
              : `<div>まだ使用記録がありません</div>`}
        </div>
        ${item.url ? `<a class="c-link" href="${esc(item.url)}" target="_blank" rel="noopener">🔗 商品ページを開く</a>` : ""}
        <div class="card-actions">
          <button class="buy-btn u-log">📅 使用記録</button>
          <button class="edit-btn">✏️ 編集</button>
          <button class="edit-btn u-back" title="ほしいものリストに戻す">↩</button>
          <button class="danger-btn c-del">🗑</button>
        </div>
      </div>`;

    const img = card.querySelector(".thumb");
    if (img) img.addEventListener("click", () => openViewer(item.images));
    card.querySelector(".u-log").addEventListener("click", () => openUsageDialog(item));
    card.querySelector(".edit-btn:not(.u-back)").addEventListener("click", () => openItemDialog("bought", item));
    card.querySelector(".u-back").addEventListener("click", async () => {
      if (!confirm(`「${item.name}」をほしいものリストに戻しますか？（使用記録は消えます）`)) return;
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
      await dbDelete("bought", item.id);
      boughtItems = boughtItems.filter((x) => x.id !== item.id);
      renderBought();
    });
    grid.appendChild(card);
  });
  $("#boughtEmpty").classList.toggle("hidden", boughtItems.length > 0);
}

$("#boughtSort").addEventListener("change", (e) => {
  boughtSortMode = e.target.value;
  renderBought();
});

/* ---- 使用記録ダイアログ ---- */
let usageItem = null;

function openUsageDialog(item) {
  usageItem = item;
  $("#usageDialogTitle").textContent = `📅 使用記録: ${item.name}`;
  $("#usageDate").value = todayISO();
  renderUsage();
  $("#usageDialog").showModal();
}

function renderUsage() {
  const item = usageItem;
  const uses = (item.usages || []).slice().sort();
  const cospa = cospaOf(item);
  $("#usageStats").innerHTML = `
    使用回数: <span class="big">${uses.length} 回</span>
    ${cospa != null ? ` ／ コスパ: <span class="big">1回あたり ${yen(Math.round(cospa))}</span>` : ""}
    ${item.price != null ? `<div class="hint">価格 ${yen(item.price)} ÷ 使用 ${uses.length} 回</div>` : `<div class="hint">価格を設定するとコスパが計算されます</div>`}`;
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
  wishItems.forEach((x) => {
    if (x.genre) count[x.genre] = (count[x.genre] || 0) + 1;
  });
  return Object.keys(count).filter((g) => count[g] >= 2).sort((a, b) => a.localeCompare(b, "ja"));
}

function renderCompare() {
  revokeUrls("dialog");
  const genre = $("#compareGenre").value;
  const box = $("#compareResult");
  const group = wishItems.filter((x) => x.genre === genre);
  if (!genre || group.length < 2) {
    box.innerHTML = `<p class="hint">同じジャンルを設定したほしいものが2件以上あると比較できます。<br>各アイテムの「編集」からジャンル（例: ヘアアイロン）を設定してください。</p>`;
    return;
  }

  // スペックキーの和集合
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

  // 画像行
  html += `<tr><td>画像</td>`;
  group.forEach((it) => {
    html += `<td>${it.images && it.images.length ? `<img src="${makeUrl(it.images[0], "dialog")}" data-viewer="${esc(it.id)}">` : "—"}</td>`;
  });
  html += `</tr>`;

  // 価格行
  html += `<tr><td>価格</td>`;
  group.forEach((it) => {
    const isBest = it.price != null && it.price === minPrice && prices.length >= 2;
    html += `<td class="${isBest ? "best-cell" : ""}">${it.price != null ? yen(it.price) + (isBest ? " 🏆最安" : "") : "未設定"}</td>`;
  });
  html += `</tr>`;

  // ほしい度行
  html += `<tr><td>ほしい度</td>`;
  group.forEach((it) => {
    const isBest = (it.rating || 0) === maxRating && maxRating > 0;
    html += `<td class="${isBest ? "best-cell" : ""}">${it.rating ? "★".repeat(it.rating) : "—"}</td>`;
  });
  html += `</tr>`;

  // スペック行（数値の場合は差を強調）
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

  // リンク行
  html += `<tr><td>リンク</td>`;
  group.forEach((it) => {
    html += `<td>${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">商品ページ</a>` : "—"}</td>`;
  });
  html += `</tr></tbody></table></div>`;
  if (specKeys.length) html += `<p class="hint">※ 数値スペックは大きい値を強調表示しています（軽さなど小さい方が良い項目はご注意ください）</p>`;

  // ---- おすすめ判定 ----
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
  revokeUrls("dialog");
  const box = $("#recommendResult");
  const byCat = {};
  wishItems.forEach((x) => {
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
    const imgHtml = best.images && best.images.length ? `<img src="${makeUrl(best.images[0], "dialog")}">` : "";
    div.innerHTML = `
      <h3>${esc(cat)}（${group.length}件）</h3>
      <div class="rec-pick">
        ${imgHtml}
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
let viewerImages = [];
let viewerIdx = 0;

function openViewer(images) {
  if (!images || !images.length) return;
  viewerImages = images;
  viewerIdx = 0;
  showViewerImg();
  $("#imageViewer").showModal();
}
function showViewerImg() {
  const img = $("#viewerImg");
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  const url = URL.createObjectURL(viewerImages[viewerIdx]);
  img.src = url;
  img.dataset.url = url;
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
function blobToDataURL(blob) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
}
async function dataURLToBlob(dataUrl) {
  const r = await fetch(dataUrl);
  return r.blob();
}

async function buildExportData() {
  const serialize = async (items) => Promise.all(items.map(async (it) => ({
    ...it,
    images: await Promise.all((it.images || []).map(blobToDataURL)),
  })));
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    shopping: shoppingItems,
    wish: await serialize(wishItems),
    bought: await serialize(boughtItems),
  };
}

async function restoreFromData(data) {
  const deserialize = async (items) => Promise.all((items || []).map(async (it) => ({
    ...it,
    images: await Promise.all((it.images || []).map(dataURLToBlob)),
  })));
  const wish = await deserialize(data.wish);
  const bought = await deserialize(data.bought);
  await dbClear("shopping");
  await dbClear("wish");
  await dbClear("bought");
  for (const it of data.shopping || []) await dbPut("shopping", it);
  for (const it of wish) await dbPut("wish", it);
  for (const it of bought) await dbPut("bought", it);
  await init();
}

$("#exportBtn").addEventListener("click", async () => {
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
  if (!file) return;
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
   Googleログイン & Googleドライブ同期
   - GIS (Google Identity Services) のトークンで Drive の
     アプリ専用領域 (appDataFolder) にバックアップを保存/読込
   ============================================================ */
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email";
const DRIVE_FILENAME = "kaimono-backup.json";
let gToken = null;      // { access_token, expires_at }
let gProfile = null;    // { name, email, picture }
let tokenClient = null;

const getClientId = () => localStorage.getItem("googleClientId") || "";
const gisReady = () => typeof google !== "undefined" && google.accounts?.oauth2;

function requestToken() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: getClientId(),
        scope: GOOGLE_SCOPES,
        callback: () => {},
      });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      gToken = { access_token: resp.access_token, expires_at: Date.now() + (resp.expires_in - 60) * 1000 };
      sessionStorage.setItem("gToken", JSON.stringify(gToken));
      resolve(gToken);
    };
    tokenClient.error_callback = (err) => reject(new Error(err.message || err.type || "ログインがキャンセルされました"));
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

async function ensureToken() {
  if (gToken && gToken.expires_at > Date.now()) return;
  const saved = sessionStorage.getItem("gToken");
  if (saved) {
    const t = JSON.parse(saved);
    if (t.expires_at > Date.now()) { gToken = t; return; }
  }
  await requestToken();
}

async function googleLogin() {
  if (location.protocol === "file:") {
    alert("Googleログインはファイル直開きでは使えません。\n「起動.bat」をダブルクリックしてアプリを開いてください。");
    return;
  }
  if (!getClientId()) { openGoogleSetup(); return; }
  if (!gisReady()) {
    alert("Googleのログイン部品を読み込めませんでした。インターネット接続を確認してページを再読み込みしてください。");
    return;
  }
  try {
    await requestToken();
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + gToken.access_token },
    });
    if (!r.ok) throw new Error("プロフィール取得に失敗 (HTTP " + r.status + ")");
    gProfile = await r.json();
    localStorage.setItem("gProfile", JSON.stringify(gProfile));
    renderAuth();
  } catch (err) {
    alert("ログインに失敗しました: " + err.message);
  }
}

function googleLogout() {
  if (gToken && gisReady()) {
    try { google.accounts.oauth2.revoke(gToken.access_token, () => {}); } catch (e) { /* no-op */ }
  }
  gToken = null;
  gProfile = null;
  sessionStorage.removeItem("gToken");
  localStorage.removeItem("gProfile");
  renderAuth();
}

/* ---- Drive バックアップ ---- */
const authHeader = () => ({ Authorization: "Bearer " + gToken.access_token });

async function driveFindFile() {
  const q = encodeURIComponent(`name='${DRIVE_FILENAME}'`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`, { headers: authHeader() });
  if (!r.ok) throw new Error("Drive検索に失敗 (HTTP " + r.status + ")");
  const json = await r.json();
  return json.files && json.files[0] ? json.files[0] : null;
}

async function driveSaveBackup() {
  try {
    await ensureToken();
    const json = JSON.stringify(await buildExportData());
    const existing = await driveFindFile();
    let resp;
    if (existing) {
      resp = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`, {
        method: "PATCH",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: json,
      });
    } else {
      const boundary = "kaimono_boundary_" + Date.now();
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: DRIVE_FILENAME, parents: ["appDataFolder"] }) +
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
      resp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
    }
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    localStorage.setItem("lastDriveSync", new Date().toISOString());
    renderAuth();
    alert("Googleドライブに保存しました。");
  } catch (err) {
    alert("Googleドライブへの保存に失敗しました: " + err.message);
  }
}

async function driveLoadBackup() {
  try {
    await ensureToken();
    const existing = await driveFindFile();
    if (!existing) {
      alert("Googleドライブにまだバックアップがありません。先に「☁️ 保存」してください。");
      return;
    }
    const when = new Date(existing.modifiedTime).toLocaleString("ja-JP");
    if (!confirm(`Googleドライブのバックアップ（${when} 保存）で現在のデータをすべて置き換えます。よろしいですか？`)) return;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`, { headers: authHeader() });
    if (!r.ok) throw new Error("HTTP " + r.status);
    await restoreFromData(await r.json());
    alert("Googleドライブから復元しました。");
  } catch (err) {
    alert("Googleドライブからの読み込みに失敗しました: " + err.message);
  }
}

/* ---- ログインUI ---- */
const G_LOGO = `<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

function renderAuth() {
  const area = $("#authArea");
  if (gProfile && gProfile.name) {
    const last = localStorage.getItem("lastDriveSync");
    const lastText = last ? "前回の保存: " + new Date(last).toLocaleString("ja-JP") : "まだ保存していません";
    area.innerHTML = `
      ${gProfile.picture ? `<img class="avatar" src="${esc(gProfile.picture)}" alt="" referrerpolicy="no-referrer">` : ""}
      <span class="auth-name" title="${esc(gProfile.email || "")}">${esc(gProfile.name)}</span>
      <button id="driveSaveBtn" class="ghost-btn" title="${esc(lastText)}">☁️ 保存</button>
      <button id="driveLoadBtn" class="ghost-btn" title="Googleドライブのバックアップから復元">☁️ 読込</button>
      <button id="logoutBtn" class="ghost-btn">ログアウト</button>`;
    $("#driveSaveBtn").addEventListener("click", driveSaveBackup);
    $("#driveLoadBtn").addEventListener("click", driveLoadBackup);
    $("#logoutBtn").addEventListener("click", googleLogout);
  } else {
    area.innerHTML = `
      <button id="loginBtn" class="google-btn">${G_LOGO} Googleでログイン</button>
      <button id="gSetupBtn" class="ghost-btn" title="Googleログインの設定">⚙️</button>`;
    $("#loginBtn").addEventListener("click", googleLogin);
    $("#gSetupBtn").addEventListener("click", openGoogleSetup);
  }
}

/* ---- 初期設定ダイアログ ---- */
function openGoogleSetup() {
  $("#clientIdInput").value = getClientId();
  $("#googleSetupDialog").showModal();
}
$("#setupCancelBtn").addEventListener("click", () => $("#googleSetupDialog").close());
$("#setupSaveBtn").addEventListener("click", () => {
  const v = $("#clientIdInput").value.trim();
  if (v && !v.endsWith(".apps.googleusercontent.com")) {
    if (!confirm("クライアントIDの形式が通常と異なります（.apps.googleusercontent.com で終わるはずです）。このまま保存しますか？")) return;
  }
  localStorage.setItem("googleClientId", v);
  tokenClient = null; // 新しいIDで作り直す
  $("#googleSetupDialog").close();
  if (v) alert("保存しました。「Googleでログイン」からログインできます。");
});

function initAuth() {
  try { gProfile = JSON.parse(localStorage.getItem("gProfile") || "null"); } catch (e) { gProfile = null; }
  const saved = sessionStorage.getItem("gToken");
  if (saved) {
    try {
      const t = JSON.parse(saved);
      if (t.expires_at > Date.now()) gToken = t;
    } catch (e) { /* no-op */ }
  }
  renderAuth();
}
initAuth();

/* ============================================================
   初期化
   ============================================================ */
async function init() {
  if (!db) db = await openDB();
  await loadShopping();
  await loadWish();
  await loadBought();
}
init().catch((err) => {
  document.body.insertAdjacentHTML("afterbegin",
    `<div style="background:#fdeeec;color:#c0392b;padding:12px 20px;">データベースを開けませんでした: ${esc(err.message)}</div>`);
});
