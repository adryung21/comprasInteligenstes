(() => {
  "use strict";

  const DB_NAME = "mi-compra-inteligente-db";
  const DB_VERSION = 2;
  const STORE_NAMES = ["products", "stores", "categories", "prices", "shoppingItems", "settings", "purchaseHistory", "sharedLists"];

  let db;
  let storageBackend = "indexeddb";
  const memoryStorage = Object.fromEntries(STORE_NAMES.map((name) => [name, []]));
  let deferredInstallPrompt = null;
  let currentStream = null;
  let capturedImageData = "";
  let scanData = null;
  let productEditingImage = "";

  const state = {
    products: [],
    stores: [],
    categories: [],
    prices: [],
    shoppingItems: [],
    purchaseHistory: [],
    sharedLists: [],
    settings: {}
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function uid(prefix = "id") {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function money(value) {
    return new Intl.NumberFormat("es-EC", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2
    }).format(Number(value || 0));
  }

  function localDate(value) {
    if (!value) return "—";
    const d = new Date(`${value}T12:00:00`);
    return new Intl.DateTimeFormat("es-EC", { dateStyle: "medium" }).format(d);
  }

  function today() {
    const d = new Date();
    const offset = d.getTimezoneOffset();
    return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
  }

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[char]));
  }

  function toast(message, type = "") {
    const el = document.createElement("div");
    el.className = `toast ${type}`.trim();
    el.textContent = message;
    $("#toastContainer").appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function confirmAction(message) {
    return window.confirm(message);
  }

  function localStorageAvailable() {
    try {
      const key = "__mci_test__";
      localStorage.setItem(key, "1");
      localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  function selectFallbackStorage() {
    storageBackend = localStorageAvailable() ? "localstorage" : "memory";
  }

  function localKey(storeName) {
    return `mci_${storeName}`;
  }

  function readFallbackStore(storeName) {
    if (storageBackend === "memory") return [...memoryStorage[storeName]];
    try {
      return JSON.parse(localStorage.getItem(localKey(storeName)) || "[]");
    } catch {
      storageBackend = "memory";
      return [...memoryStorage[storeName]];
    }
  }

  function writeFallbackStore(storeName, rows) {
    if (storageBackend === "memory") {
      memoryStorage[storeName] = [...rows];
      return;
    }
    try {
      localStorage.setItem(localKey(storeName), JSON.stringify(rows));
    } catch {
      storageBackend = "memory";
      memoryStorage[storeName] = [...rows];
    }
  }

  function openDB() {
    return new Promise((resolve) => {
      if (!("indexedDB" in window)) {
        selectFallbackStorage();
        resolve(null);
        return;
      }

      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        selectFallbackStorage();
        resolve(null);
        return;
      }

      request.onupgradeneeded = () => {
        const database = request.result;
        STORE_NAMES.forEach((name) => {
          if (!database.objectStoreNames.contains(name)) {
            database.createObjectStore(name, { keyPath: "id" });
          }
        });
      };

      request.onsuccess = () => {
        storageBackend = "indexeddb";
        resolve(request.result);
      };
      request.onerror = () => {
        selectFallbackStorage();
        resolve(null);
      };
      request.onblocked = () => {
        selectFallbackStorage();
        resolve(null);
      };
    });
  }

  function tx(storeName, mode = "readonly") {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function getAll(storeName) {
    if (storageBackend !== "indexeddb") {
      return Promise.resolve(readFallbackStore(storeName));
    }
    return new Promise((resolve, reject) => {
      const request = tx(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  function put(storeName, value) {
    if (storageBackend !== "indexeddb") {
      const rows = readFallbackStore(storeName);
      const index = rows.findIndex((row) => row.id === value.id);
      if (index >= 0) rows[index] = value;
      else rows.push(value);
      writeFallbackStore(storeName, rows);
      return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
      const request = tx(storeName, "readwrite").put(value);
      request.onsuccess = () => resolve(value);
      request.onerror = () => reject(request.error);
    });
  }

  function remove(storeName, id) {
    if (storageBackend !== "indexeddb") {
      writeFallbackStore(storeName, readFallbackStore(storeName).filter((row) => row.id !== id));
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const request = tx(storeName, "readwrite").delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function clearStore(storeName) {
    if (storageBackend !== "indexeddb") {
      writeFallbackStore(storeName, []);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const request = tx(storeName, "readwrite").clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function loadState() {
    const [products, stores, categories, prices, shoppingItems, settingsRows, purchaseHistory, sharedLists] =
      await Promise.all(STORE_NAMES.map(getAll));

    state.products = products;
    state.stores = stores;
    state.categories = categories;
    state.prices = prices;
    state.shoppingItems = shoppingItems;
    state.purchaseHistory = purchaseHistory;
    state.sharedLists = sharedLists;
    state.settings = Object.fromEntries(settingsRows.map((row) => [row.id, row.value]));
  }

  async function seedDefaults() {
    if (!state.categories.length) {
      const defaults = ["Alimentos", "Bebidas", "Limpieza", "Higiene personal", "Medicamentos", "Hogar", "Mascotas", "Otros"];
      for (const name of defaults) await put("categories", { id: uid("cat"), name });
    }
    if (!state.stores.length) {
      for (const name of ["Tienda 1", "Tienda 2"]) await put("stores", { id: uid("store"), name });
    }
    await loadState();
  }

  function getProduct(id) { return state.products.find((x) => x.id === id); }
  function getStore(id) { return state.stores.find((x) => x.id === id); }
  function getCategory(id) { return state.categories.find((x) => x.id === id); }

  function getProductPrices(productId) {
    return state.prices
      .filter((p) => p.productId === productId)
      .sort((a, b) => Number(a.price) - Number(b.price) || String(b.date).localeCompare(String(a.date)));
  }

  function getBestPrice(productId) {
    return getProductPrices(productId)[0] || null;
  }

  function latestPricesByStore(productId) {
    const map = new Map();
    state.prices
      .filter((p) => p.productId === productId)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .forEach((price) => {
        if (!map.has(price.storeId)) map.set(price.storeId, price);
      });
    return [...map.values()].sort((a, b) => Number(a.price) - Number(b.price));
  }

  function navigate(viewName) {
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
    $$(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === viewName));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function optionList(items, placeholder, selected = "") {
    return `<option value="">${escapeHTML(placeholder)}</option>` +
      items.map((item) => `<option value="${item.id}" ${item.id === selected ? "selected" : ""}>${escapeHTML(item.name)}</option>`).join("");
  }

  function refreshSelects() {
    const sortedCategories = [...state.categories].sort((a, b) => a.name.localeCompare(b.name));
    const sortedStores = [...state.stores].sort((a, b) => a.name.localeCompare(b.name));
    const sortedProducts = [...state.products].sort((a, b) => a.name.localeCompare(b.name));

    $("#productCategory").innerHTML = optionList(sortedCategories, "Selecciona una categoría");
    $("#productCategoryFilter").innerHTML = optionList(sortedCategories, "Todas las categorías");
    $("#compareCategoryFilter").innerHTML = optionList(sortedCategories, "Todas las categorías");
    $("#priceStore").innerHTML = optionList(sortedStores, "Selecciona una tienda");
    $("#priceStoreFilter").innerHTML = optionList(sortedStores, "Todas las tiendas");
    $("#priceProduct").innerHTML = optionList(sortedProducts, "Selecciona un producto");
    $("#shoppingProduct").innerHTML = optionList(sortedProducts, "Selecciona un producto");
  }

  function renderDashboard() {
    $("#statProducts").textContent = state.products.length;
    $("#statStores").textContent = state.stores.length;
    $("#statPrices").textContent = state.prices.length;
    const pending = state.shoppingItems.filter((x) => !x.completed);
    $("#statPending").textContent = pending.length;

    const bestRows = state.products
      .map((product) => ({ product, price: getBestPrice(product.id) }))
      .filter((row) => row.price)
      .sort((a, b) => String(b.price.date).localeCompare(String(a.price.date)))
      .slice(0, 6);

    $("#dashboardBestPrices").className = bestRows.length ? "card-list" : "card-list empty-state";
    $("#dashboardBestPrices").innerHTML = bestRows.length
      ? bestRows.map(({ product, price }) => `
        <div class="list-card">
          <div>
            <strong>${escapeHTML(product.name)}</strong>
            <small>${escapeHTML(getStore(price.storeId)?.name || "Tienda eliminada")} · ${localDate(price.date)}</small>
          </div>
          <strong>${money(price.price)}</strong>
        </div>`).join("")
      : "Aún no hay precios registrados.";

    $("#dashboardShopping").className = pending.length ? "card-list" : "card-list empty-state";
    $("#dashboardShopping").innerHTML = pending.length
      ? pending.slice(0, 6).map((item) => {
        const product = getProduct(item.productId);
        const best = product ? getBestPrice(product.id) : null;
        return `<div class="list-card">
          <div><strong>${escapeHTML(product?.name || "Producto eliminado")}</strong><small>Cantidad: ${item.quantity}</small></div>
          <strong>${best ? money(Number(best.price) * Number(item.quantity)) : "Sin precio"}</strong>
        </div>`;
      }).join("")
      : "Tu lista está vacía.";
  }

  function renderProducts() {
    const query = $("#productSearch").value.trim().toLowerCase();
    const categoryId = $("#productCategoryFilter").value;
    const products = [...state.products]
      .filter((p) => !categoryId || p.categoryId === categoryId)
      .filter((p) => [p.name, p.brand, p.presentation, p.barcode].join(" ").toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));

    const container = $("#productList");
    container.className = products.length ? "cards-grid" : "cards-grid empty-state";
    container.innerHTML = products.length ? products.map((p) => {
      const best = getBestPrice(p.id);
      const image = p.imageData
        ? `<img class="product-image" src="${p.imageData}" alt="${escapeHTML(p.name)}">`
        : `<div class="product-image placeholder">${escapeHTML(p.name.slice(0,1).toUpperCase())}</div>`;
      return `<article class="product-card">
        ${image}
        <div class="product-body">
          <span class="badge">${escapeHTML(getCategory(p.categoryId)?.name || "Sin categoría")}</span>
          <h3>${escapeHTML(p.name)}</h3>
          <div class="product-meta">
            ${p.brand ? `${escapeHTML(p.brand)}<br>` : ""}
            ${p.presentation ? `${escapeHTML(p.presentation)}<br>` : ""}
            ${p.barcode ? `Código: ${escapeHTML(p.barcode)}` : "Sin código"}
          </div>
          <div class="product-meta" style="margin-top:8px">
            ${best ? `Mejor precio: <strong>${money(best.price)}</strong> en ${escapeHTML(getStore(best.storeId)?.name || "—")}` : "Sin precios registrados"}
          </div>
          <div class="product-actions">
            <button class="btn btn-secondary btn-sm" data-action="edit-product" data-id="${p.id}">Editar</button>
            <button class="btn btn-secondary btn-sm" data-action="price-product" data-id="${p.id}">+ Precio</button>
            <button class="btn btn-accent btn-sm" data-action="add-product-list" data-id="${p.id}">+ Lista</button>
            <button class="btn btn-danger btn-sm" data-action="delete-product" data-id="${p.id}">Borrar</button>
          </div>
        </div>
      </article>`;
    }).join("") : "No hay productos que coincidan.";
  }

  function renderPrices() {
    const query = $("#priceSearch").value.trim().toLowerCase();
    const storeId = $("#priceStoreFilter").value;
    const rows = [...state.prices]
      .filter((p) => !storeId || p.storeId === storeId)
      .filter((p) => {
        const product = getProduct(p.productId)?.name || "";
        const store = getStore(p.storeId)?.name || "";
        return `${product} ${store} ${p.note || ""}`.toLowerCase().includes(query);
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.createdAt || 0) - Number(a.createdAt || 0));

    const container = $("#priceList");
    container.className = rows.length ? "table-wrap" : "table-wrap empty-state";
    container.innerHTML = rows.length ? `
      <table>
        <thead><tr><th>Producto</th><th>Tienda</th><th>Precio</th><th>Fecha</th><th>Nota</th><th></th></tr></thead>
        <tbody>
          ${rows.map((p) => `<tr>
            <td><strong>${escapeHTML(getProduct(p.productId)?.name || "Producto eliminado")}</strong></td>
            <td>${escapeHTML(getStore(p.storeId)?.name || "Tienda eliminada")}</td>
            <td class="price-main">${money(p.price)}</td>
            <td>${localDate(p.date)}</td>
            <td>${escapeHTML(p.note || "—")}</td>
            <td><button class="btn btn-danger btn-sm" data-action="delete-price" data-id="${p.id}">Borrar</button></td>
          </tr>`).join("")}
        </tbody>
      </table>` : "No hay precios que coincidan.";
  }

  function renderCompare() {
    const query = $("#compareSearch").value.trim().toLowerCase();
    const categoryId = $("#compareCategoryFilter").value;

    const products = state.products
      .filter((p) => !categoryId || p.categoryId === categoryId)
      .filter((p) => `${p.name} ${p.brand || ""}`.toLowerCase().includes(query))
      .map((product) => ({ product, prices: latestPricesByStore(product.id) }))
      .filter((row) => row.prices.length)
      .sort((a, b) => a.product.name.localeCompare(b.product.name));

    const container = $("#compareList");
    container.className = products.length ? "cards-grid" : "cards-grid empty-state";
    container.innerHTML = products.length ? products.map(({ product, prices }) => {
      const best = prices[0];
      const highest = prices[prices.length - 1];
      const savings = prices.length > 1 ? Number(highest.price) - Number(best.price) : 0;
      return `<article class="compare-card">
        <div class="compare-body">
          <span class="badge">${escapeHTML(getCategory(product.categoryId)?.name || "Sin categoría")}</span>
          <h3>${escapeHTML(product.name)}</h3>
          <div class="price-main">${money(best.price)}</div>
          <div class="product-meta">Mejor precio en ${escapeHTML(getStore(best.storeId)?.name || "—")}</div>
          ${savings > 0 ? `<p><strong>Ahorro posible: ${money(savings)}</strong></p>` : ""}
          <div class="compare-lines">
            ${prices.map((price, i) => `<div class="compare-line">
              <span>${i === 0 ? "✓ " : ""}${escapeHTML(getStore(price.storeId)?.name || "—")}</span>
              <strong>${money(price.price)}</strong>
            </div>`).join("")}
          </div>
        </div>
      </article>`;
    }).join("") : "Registra precios para comenzar a comparar.";
  }

  function renderShopping() {
    const showCompleted = $("#showCompleted").checked;
    const all = [...state.shoppingItems].sort((a, b) =>
      Number(a.completed) - Number(b.completed) ||
      Number(b.createdAt || 0) - Number(a.createdAt || 0)
    );
    const visible = showCompleted ? all : all.filter((x) => !x.completed);
    const completed = all.filter((x) => x.completed);
    const pending = all.filter((x) => !x.completed);

    const totalItems = all.length;
    const completedItems = completed.length;
    const progress = totalItems ? Math.round((completedItems / totalItems) * 100) : 0;

    let grandTotal = 0;
    let collectedTotal = 0;
    let pendingTotal = 0;
    let withoutPrice = 0;

    all.forEach((item) => {
      const best = getBestPrice(item.productId);
      if (!best) {
        withoutPrice++;
        return;
      }

      const subtotal = Number(best.price) * Number(item.quantity);
      grandTotal += subtotal;

      if (item.completed) collectedTotal += subtotal;
      else pendingTotal += subtotal;
    });

    $("#shoppingProgressPercent").textContent = `${progress}%`;
    $("#shoppingProgressBar").style.width = `${progress}%`;
    $("#shoppingCollectedText").textContent =
      `${completedItems} de ${totalItems} artículo${totalItems === 1 ? "" : "s"} recolectado${completedItems === 1 ? "" : "s"}`;
    $("#shoppingRemainingText").textContent =
      `${pending.length} pendiente${pending.length === 1 ? "" : "s"}`;

    $("#shoppingGrandTotal").textContent = money(grandTotal);
    $("#shoppingCollectedTotal").textContent = money(collectedTotal);
    $("#shoppingPendingTotal").textContent = money(pendingTotal);
    $("#shoppingWithoutPriceCount").textContent = withoutPrice;

    const container = $("#shoppingList");
    container.className = visible.length ? "shopping-list" : "shopping-list empty-state";

    container.innerHTML = visible.length ? visible.map((item) => {
      const product = getProduct(item.productId);
      const best = product ? getBestPrice(product.id) : null;
      const subtotal = best ? Number(best.price) * Number(item.quantity) : null;

      return `<article class="shopping-item ${item.completed ? "completed" : ""}">
        <button class="check-btn" data-action="toggle-shopping" data-id="${item.id}"
          aria-label="${item.completed ? "Restaurar" : "Marcar comprado"}">${item.completed ? "✓" : ""}</button>
        <div>
          <h4>${escapeHTML(product?.name || "Producto eliminado")}</h4>
          <p>Cantidad: ${item.quantity}${best ? ` · ${escapeHTML(getStore(best.storeId)?.name || "—")}` : " · Sin precio registrado"}</p>
          <span class="shopping-item-cost">
            ${subtotal !== null ? `${item.completed ? "Recolectado:" : "Subtotal:"} ${money(subtotal)}` : "Pendiente de precio"}
          </span>
        </div>
        <div class="inline-actions">
          <button class="btn btn-secondary btn-sm" data-action="change-quantity" data-id="${item.id}">Cantidad</button>
          <button class="btn btn-danger btn-sm" data-action="delete-shopping" data-id="${item.id}">Borrar</button>
        </div>
      </article>`;
    }).join("") : (
      totalItems === 0
        ? "Añade productos para crear tu lista."
        : "Todos los artículos están recolectados. Activa “Mostrar artículos comprados” para revisarlos."
    );

    renderOptimization(pending);
  }

  function renderOptimization(items) {
    const groups = new Map();
    let unknown = 0;

    items.forEach((item) => {
      const product = getProduct(item.productId);
      const best = product ? getBestPrice(product.id) : null;
      if (!product || !best) { unknown++; return; }
      if (!groups.has(best.storeId)) groups.set(best.storeId, []);
      groups.get(best.storeId).push({
        name: product.name,
        quantity: Number(item.quantity),
        unitPrice: Number(best.price),
        subtotal: Number(best.price) * Number(item.quantity)
      });
    });

    const container = $("#shoppingOptimization");
    if (!groups.size) {
      container.className = "optimization empty-state";
      container.textContent = unknown ? "Hay artículos sin precios registrados." : "No hay información suficiente.";
      return;
    }

    container.className = "optimization";
    container.innerHTML = [...groups.entries()].map(([storeId, rows]) => {
      const subtotal = rows.reduce((sum, r) => sum + r.subtotal, 0);
      return `<div class="store-group">
        <div class="store-group-header">
          <strong>${escapeHTML(getStore(storeId)?.name || "Tienda eliminada")}</strong>
          <strong>${money(subtotal)}</strong>
        </div>
        <ul>${rows.map((r) => `<li>${escapeHTML(r.name)} × ${r.quantity} — ${money(r.subtotal)}</li>`).join("")}</ul>
      </div>`;
    }).join("") + (unknown ? `<div class="notice">${unknown} artículo(s) todavía no tienen precio.</div>` : "");
  }

  function renderSettings() {
    const stores = [...state.stores].sort((a, b) => a.name.localeCompare(b.name));
    const categories = [...state.categories].sort((a, b) => a.name.localeCompare(b.name));

    $("#storeList").className = stores.length ? "mini-list" : "mini-list empty-state";
    $("#storeList").innerHTML = stores.length ? stores.map((x) => `
      <div class="mini-item"><span>${escapeHTML(x.name)}</span><button class="btn btn-danger btn-sm" data-action="delete-store" data-id="${x.id}">Borrar</button></div>`).join("") : "No hay tiendas.";

    $("#categoryList").className = categories.length ? "mini-list" : "mini-list empty-state";
    $("#categoryList").innerHTML = categories.length ? categories.map((x) => `
      <div class="mini-item"><span>${escapeHTML(x.name)}</span><button class="btn btn-danger btn-sm" data-action="delete-category" data-id="${x.id}">Borrar</button></div>`).join("") : "No hay categorías.";

    $("#aiEndpoint").value = state.settings.aiEndpoint || "";
    updateAIStatus();
  }

  function updateAIStatus(status = "") {
    const badge = $("#aiStatusBadge");
    if (!badge) return;

    const endpoint = String(state.settings.aiEndpoint || "").trim();
    badge.classList.remove("ready", "error");

    if (status === "error") {
      badge.textContent = "Error de conexión";
      badge.classList.add("error");
    } else if (endpoint) {
      badge.textContent = "IA configurada";
      badge.classList.add("ready");
    } else {
      badge.textContent = "Sin configurar";
    }
  }

  function showEndpointMessage(message, type = "") {
    const box = $("#aiEndpointMessage");
    if (!box) return;
    box.textContent = message;
    box.className = `endpoint-message ${type}`.trim();
  }

  async function testAIEndpoint() {
    const endpoint = $("#aiEndpoint").value.trim();
    if (!endpoint) {
      showEndpointMessage("Primero escribe la dirección del endpoint.", "error");
      return;
    }

    const button = $("#testAIEndpointBtn");
    button.disabled = true;
    button.textContent = "Probando…";

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { "Accept": "application/json" }
      });

      if (!response.ok) throw new Error(`Respuesta ${response.status}`);
      const data = await response.json();

      if (!data?.ok) throw new Error("El servidor no confirmó disponibilidad.");

      showEndpointMessage("Conexión correcta. La IA visual está lista.", "success");
      updateAIStatus();
    } catch (error) {
      showEndpointMessage(`No se pudo conectar: ${error.message}`, "error");
      updateAIStatus("error");
    } finally {
      button.disabled = false;
      button.textContent = "Probar conexión";
    }
  }


  function shoppingSnapshot() {
    return state.shoppingItems.map(item => {
      const product = getProduct(item.productId);
      const best = getBestPrice(item.productId);
      return {
        productId:item.productId,
        name:product?.name || "Producto eliminado",
        brand:product?.brand || "",
        category:getCategory(product?.categoryId)?.name || "",
        quantity:Number(item.quantity),
        completed:Boolean(item.completed),
        store:best ? (getStore(best.storeId)?.name || "") : "",
        unitPrice:best ? Number(best.price) : null,
        subtotal:best ? Number(best.price)*Number(item.quantity) : null
      };
    });
  }

  function renderHistoryAndSharedLists() {
    const history = [...state.purchaseHistory].sort((a,b)=>Number(b.finishedAt)-Number(a.finishedAt));
    const hc = $("#purchaseHistoryContainer");
    hc.className = history.length ? "history-list" : "history-list empty-state";
    hc.innerHTML = history.length ? history.map(h => `
      <article class="history-card">
        <div class="history-card-head"><div><h4>${escapeHTML(h.name)}</h4>
        <p>${new Date(h.finishedAt).toLocaleString("es-EC")} · ${h.completedCount}/${h.totalCount} recolectados</p></div>
        <strong>${money(h.total)}</strong></div>
        <div class="history-card-actions">
          <button class="btn btn-secondary btn-sm" data-action="print-history" data-id="${h.id}">Informe PDF</button>
          <button class="btn btn-secondary btn-sm" data-action="reuse-history" data-id="${h.id}">Reutilizar lista</button>
          <button class="btn btn-danger btn-sm" data-action="delete-history" data-id="${h.id}">Borrar</button>
        </div>
      </article>`).join("") : "Todavía no hay compras finalizadas.";

    const shared = [...state.sharedLists].sort((a,b)=>Number(b.importedAt)-Number(a.importedAt));
    const sc = $("#sharedListsContainer");
    sc.className = shared.length ? "history-list" : "history-list empty-state";
    sc.innerHTML = shared.length ? shared.map(s => `
      <article class="history-card">
        <div class="history-card-head"><div><h4>${escapeHTML(s.name)}</h4>
        <p>${s.items.length} artículos · importada ${new Date(s.importedAt).toLocaleString("es-EC")}</p></div></div>
        <div class="history-card-actions">
          <button class="btn btn-secondary btn-sm" data-action="activate-shared" data-id="${s.id}">Abrir como nueva</button>
          <button class="btn btn-secondary btn-sm" data-action="merge-shared" data-id="${s.id}">Combinar</button>
          <button class="btn btn-danger btn-sm" data-action="delete-shared" data-id="${s.id}">Borrar</button>
        </div>
      </article>`).join("") : "No hay listas importadas.";
  }

  async function replaceActiveList(items) {
    for (const item of state.shoppingItems) await remove("shoppingItems", item.id);
    for (const row of items) {
      let product = state.products.find(p => p.id === row.productId) ||
        state.products.find(p => p.name.toLowerCase() === String(row.name||"").toLowerCase());
      if (!product) {
        product = {id:uid("product"),name:row.name||"Producto importado",brand:row.brand||"",
          presentation:"",categoryId:state.categories.find(c=>c.name===row.category)?.id || state.categories[0]?.id || "",
          barcode:"",imageData:"",createdAt:Date.now(),updatedAt:Date.now()};
        await put("products", product);
      }
      await put("shoppingItems",{id:uid("shopping"),productId:product.id,quantity:Number(row.quantity||1),
        completed:false,createdAt:Date.now()});
    }
    await loadState(); renderAll();
  }

  async function finishPurchase() {
    if (!state.shoppingItems.length) return toast("La lista está vacía.","error");
    const name = prompt("Nombre de esta compra:", `Compra ${new Date().toLocaleDateString("es-EC")}`) || "";
    if (!name.trim()) return;
    const items = shoppingSnapshot();
    const total = items.reduce((s,i)=>s+(i.subtotal||0),0);
    const completedCount = items.filter(i=>i.completed).length;
    if (!confirm(`Se guardará la compra y se limpiará la lista activa.\n\n${completedCount} de ${items.length} recolectados\nTotal: ${money(total)}\n\n¿Finalizar?`)) return;
    await put("purchaseHistory",{id:uid("purchase"),name:name.trim(),finishedAt:Date.now(),items,
      total,totalCount:items.length,completedCount,pendingCount:items.length-completedCount});
    for (const item of state.shoppingItems) await remove("shoppingItems",item.id);
    await loadState(); renderAll(); toast("Compra finalizada y guardada en el historial.","success");
  }

  function printPurchaseReport(record) {
    const rows = record.items.map(i=>`<tr><td>${escapeHTML(i.name)}</td><td>${escapeHTML(i.category)}</td>
      <td>${i.quantity}</td><td>${escapeHTML(i.store||"—")}</td><td>${i.unitPrice===null?"—":money(i.unitPrice)}</td>
      <td>${i.subtotal===null?"—":money(i.subtotal)}</td><td>${i.completed?"Recolectado":"Pendiente"}</td></tr>`).join("");
    const w = window.open("","_blank");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHTML(record.name)}</title>
      <style>body{font-family:Arial;padding:28px;color:#111}h1{margin-bottom:4px}table{width:100%;border-collapse:collapse;margin-top:20px}
      th,td{border:1px solid #bbb;padding:8px;text-align:left}th{background:#eee}.summary{display:flex;gap:24px;margin:18px 0}
      @media print{button{display:none}}</style></head><body><h1>Mi Compra Inteligente</h1><h2>${escapeHTML(record.name)}</h2>
      <p>Fecha: ${new Date(record.finishedAt).toLocaleString("es-EC")}</p>
      <div class="summary"><strong>Total: ${money(record.total)}</strong><strong>Progreso: ${record.completedCount}/${record.totalCount} (${record.totalCount?Math.round(record.completedCount/record.totalCount*100):0}%)</strong></div>
      <table><thead><tr><th>Producto</th><th>Categoría</th><th>Cant.</th><th>Tienda</th><th>P. unitario</th><th>Subtotal</th><th>Estado</th></tr></thead>
      <tbody>${rows}</tbody></table><p>Generado: ${new Date().toLocaleString("es-EC")}</p><button onclick="window.print()">Imprimir / Guardar como PDF</button>
      <script>setTimeout(()=>window.print(),500)<\/script></body></html>`);
    w.document.close();
  }

  function exportSharedList() {
    if (!state.shoppingItems.length) return toast("La lista está vacía.","error");
    const payload={type:"mi-compra-shared-list",version:1,name:`Lista compartida ${new Date().toLocaleDateString("es-EC")}`,
      exportedAt:new Date().toISOString(),items:shoppingSnapshot().map(i=>({productId:i.productId,name:i.name,brand:i.brand,category:i.category,quantity:i.quantity}))};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}), url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url;a.download=`lista-compra-${today()}.json`;a.click();URL.revokeObjectURL(url);
  }

  async function importSharedList(file) {
    try {
      const data=JSON.parse(await file.text());
      if (data.type!=="mi-compra-shared-list" || !Array.isArray(data.items)) throw new Error();
      await put("sharedLists",{id:uid("shared"),name:data.name||"Lista compartida",items:data.items,importedAt:Date.now()});
      await loadState();renderAll();toast("Lista importada sin reemplazar la lista activa.","success");
    } catch { toast("El archivo no es una lista compartida válida.","error"); }
  }

  function renderAll() {
    refreshSelects();
    renderDashboard();
    renderProducts();
    renderPrices();
    renderCompare();
    renderShopping();
    renderSettings();
    renderHistoryAndSharedLists();
  }

  function configurePriceProduct(productId = "") {
    const select = $("#priceProduct");
    const selectField = $("#priceProductSelectField");
    const lockedField = $("#priceProductLockedField");
    const lockedName = $("#priceProductLockedName");
    const product = productId ? getProduct(productId) : null;

    select.dataset.lockedId = "";

    if (product) {
      select.value = product.id;
      select.disabled = true;
      select.removeAttribute("required");
      selectField.classList.add("hidden");
      lockedName.textContent = product.name;
      lockedField.classList.remove("hidden");
      select.dataset.lockedId = product.id;
    } else {
      select.disabled = false;
      select.required = true;
      select.value = "";
      selectField.classList.remove("hidden");
      lockedField.classList.add("hidden");
      lockedName.textContent = "—";
    }
  }

  function openModal(id, options = {}) {
    if (id === "priceModal") {
      if (!state.products.length || !state.stores.length) {
        toast("Primero debes tener al menos un producto y una tienda.", "error");
        return;
      }

      $("#priceForm").reset();
      $("#priceDate").value = today();
      configurePriceProduct(options.productId || "");
    }

    if (id === "productModal") resetProductForm();

    if (id === "shoppingModal" && !state.products.length) {
      toast("Primero registra al menos un producto.", "error");
      return;
    }

    document.getElementById(id).showModal();
  }

  function closeModal(id) {
    document.getElementById(id).close();
  }

  function resetProductForm() {
    $("#productForm").reset();
    $("#productId").value = "";
    $("#productModalTitle").textContent = "Nuevo producto";
    $("#productImagePreview").classList.add("hidden");
    $("#productImagePreview").src = "";
    productEditingImage = "";
  }

  function fileToDataURL(file, maxSize = 1100, quality = 0.78) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      img.onload = () => {
        const ratio = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * ratio));
        canvas.height = Math.max(1, Math.round(img.height * ratio));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleProductSubmit(event) {
    event.preventDefault();
    const id = $("#productId").value || uid("product");
    const imageFile = $("#productImage").files[0];
    let imageData = productEditingImage;
    if (imageFile) imageData = await fileToDataURL(imageFile);

    const product = {
      id,
      name: $("#productName").value.trim(),
      brand: $("#productBrand").value.trim(),
      presentation: $("#productPresentation").value.trim(),
      categoryId: $("#productCategory").value,
      barcode: $("#productBarcode").value.trim(),
      imageData,
      createdAt: state.products.find((x) => x.id === id)?.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    const duplicate = state.products.find((x) =>
      x.id !== id && product.barcode && x.barcode === product.barcode
    );
    if (duplicate) {
      toast("Ya existe un producto con ese código de barras.", "error");
      return;
    }

    await put("products", product);
    await loadState();
    renderAll();
    closeModal("productModal");
    toast("Producto guardado.", "success");
  }

  async function handlePriceSubmit(event) {
    event.preventDefault();

    const productId = $("#priceProduct").dataset.lockedId || $("#priceProduct").value;
    const product = getProduct(productId);

    if (!product) {
      toast("Selecciona un producto válido.", "error");
      return;
    }

    const price = {
      id: uid("price"),
      productId,
      storeId: $("#priceStore").value,
      price: Number($("#priceValue").value),
      date: $("#priceDate").value,
      note: $("#priceNote").value.trim(),
      createdAt: Date.now()
    };

    await put("prices", price);
    await loadState();
    renderAll();
    closeModal("priceModal");
    toast(`Precio de ${product.name} registrado.`, "success");
  }

  async function addProductToShoppingList(productId, quantity = 1) {
    const amount = Number(quantity);
    const existing = state.shoppingItems.find(
      (item) => item.productId === productId && !item.completed
    );

    if (existing) {
      existing.quantity = Number(existing.quantity) + amount;
      existing.updatedAt = Date.now();
      await put("shoppingItems", existing);
      return { item: existing, increased: true };
    }

    const item = {
      id: uid("shopping"),
      productId,
      quantity: amount,
      completed: false,
      createdAt: Date.now()
    };

    await put("shoppingItems", item);
    return { item, increased: false };
  }

  async function handleShoppingSubmit(event) {
    event.preventDefault();

    const productId = $("#shoppingProduct").value;
    const product = getProduct(productId);

    if (!product) {
      toast("Selecciona un producto válido.", "error");
      return;
    }

    await addProductToShoppingList(productId, $("#shoppingQuantity").value);
    await loadState();
    renderAll();
    closeModal("shoppingModal");
    toast(`${product.name} añadido a la lista.`, "success");
  }

  async function handleStoreSubmit(event) {
    event.preventDefault();
    const name = $("#storeName").value.trim();
    if (state.stores.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      toast("Esa tienda ya existe.", "error");
      return;
    }
    await put("stores", { id: uid("store"), name });
    await loadState();
    renderAll();
    event.target.reset();
    closeModal("storeModal");
    toast("Tienda guardada.", "success");
  }

  async function handleCategorySubmit(event) {
    event.preventDefault();
    const name = $("#categoryName").value.trim();
    if (state.categories.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      toast("Esa categoría ya existe.", "error");
      return;
    }
    await put("categories", { id: uid("cat"), name });
    await loadState();
    renderAll();
    event.target.reset();
    closeModal("categoryModal");
    toast("Categoría guardada.", "success");
  }

  async function handleDelegatedAction(event) {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === "edit-product") {
      const p = getProduct(id);
      if (!p) return;
      $("#productId").value = p.id;
      $("#productName").value = p.name;
      $("#productBrand").value = p.brand || "";
      $("#productPresentation").value = p.presentation || "";
      $("#productCategory").value = p.categoryId || "";
      $("#productBarcode").value = p.barcode || "";
      $("#productModalTitle").textContent = "Editar producto";
      productEditingImage = p.imageData || "";
      if (productEditingImage) {
        $("#productImagePreview").src = productEditingImage;
        $("#productImagePreview").classList.remove("hidden");
      } else {
        $("#productImagePreview").classList.add("hidden");
      }
      $("#productModal").showModal();
    }

    if (action === "price-product") {
      openModal("priceModal", { productId: id });
    }

    if (action === "add-product-list") {
      const product = getProduct(id);
      if (!product) return;

      const result = await addProductToShoppingList(id, 1);
      toast(
        result.increased
          ? `${product.name}: cantidad aumentada en la lista.`
          : `${product.name} añadido a la lista.`,
        "success"
      );
    }

    if (action === "delete-product") {
      const relatedPrices = state.prices.filter((x) => x.productId === id);
      const relatedItems = state.shoppingItems.filter((x) => x.productId === id);
      if (!confirmAction(`Se borrará el producto y también ${relatedPrices.length} precio(s) y ${relatedItems.length} elemento(s) de la lista. ¿Continuar?`)) return;
      await remove("products", id);
      for (const p of relatedPrices) await remove("prices", p.id);
      for (const item of relatedItems) await remove("shoppingItems", item.id);
    }

    if (action === "delete-price") {
      if (!confirmAction("¿Borrar este precio?")) return;
      await remove("prices", id);
    }

    if (action === "toggle-shopping") {
      const item = state.shoppingItems.find((x) => x.id === id);
      if (!item) return;
      item.completed = !item.completed;
      item.updatedAt = Date.now();
      await put("shoppingItems", item);
    }

    if (action === "change-quantity") {
      const item = state.shoppingItems.find((x) => x.id === id);
      if (!item) return;
      const value = Number(prompt("Nueva cantidad:", item.quantity));
      if (!Number.isFinite(value) || value <= 0) return;
      item.quantity = value;
      item.updatedAt = Date.now();
      await put("shoppingItems", item);
    }

    if (action === "delete-shopping") {
      if (!confirmAction("¿Borrar este artículo de la lista?")) return;
      await remove("shoppingItems", id);
    }

    if (action === "delete-store") {
      const used = state.prices.some((x) => x.storeId === id);
      if (used) {
        toast("No puedes borrar una tienda que tiene precios registrados.", "error");
        return;
      }
      if (!confirmAction("¿Borrar esta tienda?")) return;
      await remove("stores", id);
    }

    if (action === "print-history") {
      const record=state.purchaseHistory.find(x=>x.id===id); if(record) printPurchaseReport(record);
    }
    if (action === "reuse-history") {
      const record=state.purchaseHistory.find(x=>x.id===id);
      if(record && confirm("Esto reemplazará la lista activa. ¿Continuar?")) await replaceActiveList(record.items);
    }
    if (action === "delete-history") {
      if(confirm("¿Borrar este registro histórico?")) await remove("purchaseHistory",id);
    }
    if (action === "activate-shared") {
      const list=state.sharedLists.find(x=>x.id===id);
      if(list && confirm("Esto reemplazará la lista activa. ¿Continuar?")) await replaceActiveList(list.items);
    }
    if (action === "merge-shared") {
      const list=state.sharedLists.find(x=>x.id===id);
      if(list){ for(const row of list.items){ let p=state.products.find(x=>x.id===row.productId)||state.products.find(x=>x.name.toLowerCase()===String(row.name).toLowerCase());
        if(!p){p={id:uid("product"),name:row.name,brand:row.brand||"",presentation:"",categoryId:state.categories.find(c=>c.name===row.category)?.id||state.categories[0]?.id||"",barcode:"",imageData:"",createdAt:Date.now(),updatedAt:Date.now()};await put("products",p);}
        const ex=state.shoppingItems.find(x=>x.productId===p.id&&!x.completed); if(ex){ex.quantity=Number(ex.quantity)+Number(row.quantity||1);await put("shoppingItems",ex);}else await put("shoppingItems",{id:uid("shopping"),productId:p.id,quantity:Number(row.quantity||1),completed:false,createdAt:Date.now()});
      }}
    }
    if (action === "delete-shared") {
      if(confirm("¿Borrar esta lista importada?")) await remove("sharedLists",id);
    }

    if (action === "delete-category") {
      const used = state.products.some((x) => x.categoryId === id);
      if (used) {
        toast("No puedes borrar una categoría que contiene productos.", "error");
        return;
      }
      if (!confirmAction("¿Borrar esta categoría?")) return;
      await remove("categories", id);
    }

    await loadState();
    renderAll();
  }

  async function startCamera() {
    try {
      stopCamera();
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false
      });
      $("#cameraVideo").srcObject = currentStream;
      $("#cameraVideo").classList.remove("hidden");
      $("#imagePreview").classList.add("hidden");
      $("#cameraPlaceholder").classList.add("hidden");
      $("#captureBtn").disabled = false;
      $("#analyzeBtn").disabled = true;
      capturedImageData = "";
    } catch (error) {
      const message = !isSecureAppOrigin()
        ? "La cámara en vivo requiere HTTPS o localhost. Usa Elegir imagen para tomar una foto desde el teléfono."
        : "No se pudo abrir la cámara. Revisa los permisos o usa Elegir imagen.";
      toast(message, "error");
    }
  }

  function stopCamera() {
    if (currentStream) {
      currentStream.getTracks().forEach((track) => track.stop());
      currentStream = null;
    }
  }

  function captureCameraImage() {
    const video = $("#cameraVideo");
    const canvas = $("#cameraCanvas");
    if (!video.videoWidth) return;
    const max = 1200;
    const ratio = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * ratio);
    canvas.height = Math.round(video.videoHeight * ratio);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    capturedImageData = canvas.toDataURL("image/jpeg", .82);
    $("#imagePreview").src = capturedImageData;
    $("#imagePreview").classList.remove("hidden");
    $("#cameraVideo").classList.add("hidden");
    $("#analyzeBtn").disabled = false;
    stopCamera();
  }

  async function loadScanImage(file) {
    capturedImageData = await fileToDataURL(file, 1400, .82);
    $("#imagePreview").src = capturedImageData;
    $("#imagePreview").classList.remove("hidden");
    $("#cameraVideo").classList.add("hidden");
    $("#cameraPlaceholder").classList.add("hidden");
    $("#analyzeBtn").disabled = false;
    stopCamera();
  }

  async function detectBarcode(dataUrl) {
    if (!("BarcodeDetector" in window)) return null;
    try {
      const detector = new BarcodeDetector({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"]
      });
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const codes = await detector.detect(img);
      return codes[0]?.rawValue || null;
    } catch {
      return null;
    }
  }

  function setOCRProgress(message, progress = 0) {
    $("#ocrProgressWrap").classList.remove("hidden");
    $("#ocrProgressText").textContent = message;
    const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    $("#ocrProgressPercent").textContent = `${pct}%`;
    $("#ocrProgressBar").style.width = `${pct}%`;
  }

  function setScanMethod(message, local = false) {
    const box = $("#scanMethodStatus");
    box.textContent = message;
    box.className = `scan-method-status${local ? " local" : ""}`;
  }

  function inferCategory(text) {
    const t = text.toLowerCase();
    const rules = [
      ["Bebidas", ["agua","jugo","bebida","gaseosa","leche","café","cafe","té","refresco"]],
      ["Limpieza", ["detergente","cloro","desinfectante","lavavajilla","suavizante","limpiador"]],
      ["Higiene personal", ["shampoo","champú","jabon","jabón","crema dental","desodorante","pañal","toalla sanitaria"]],
      ["Medicamentos", ["tabletas","capsulas","cápsulas","jarabe","ibuprofeno","paracetamol"]],
      ["Mascotas", ["perro","gato","mascota","croquetas"]],
      ["Hogar", ["papel aluminio","servilleta","bolsa","foco","esponja"]],
      ["Alimentos", ["arroz","azucar","azúcar","sal","harina","aceite","galleta","cereal","yogur","atún","atun","pasta","salsa","papas","snack","chips","crema y cebolla"]]
    ];
    return rules.find(([, words]) => words.some(word => t.includes(word)))?.[0] || "Otros";
  }

  function normalizeOCRLine(text) {
    return String(text || "")
      .replace(/[|_~`^]/g, " ")
      .replace(/[^\p{L}\p{N}\s.,%+-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractProductData(ocr) {
    const rawText = String(ocr.text || "").replace(/\r/g, "");
    const promoNoise = /\b(paket[oó]n|oferta|promoci[oó]n|gratis|nuevo|ahorro|pack|precio|super|extra|informaci[oó]n|nutricional|ingredientes|contenido neto|elaborado|registro sanitario|lote|vence|conservar|distribuido|servicio al cliente|c[oó]digo|www\.|calor[ií]as)\b/i;

    const rawLines = ocr.lines?.length
      ? ocr.lines.map((line, index) => ({
          text: normalizeOCRLine(line.text),
          confidence: Number(line.confidence || 0),
          index,
          bbox: line.bbox || {}
        }))
      : rawText.split("\n").map((text, index) => ({
          text: normalizeOCRLine(text),
          confidence: 35,
          index,
          bbox: {}
        }));

    const candidates = rawLines
      .filter(line => {
        const letters = (line.text.match(/\p{L}/gu) || []).length;
        return line.text.length >= 3 &&
          line.text.length <= 60 &&
          letters >= 3 &&
          !promoNoise.test(line.text) &&
          !/^\d[\d\s.,%-]*$/.test(line.text);
      })
      .map(line => {
        const words = line.text.split(/\s+/).length;
        const height = Math.max(0, Number(line.bbox?.y1 || 0) - Number(line.bbox?.y0 || 0));
        const width = Math.max(0, Number(line.bbox?.x1 || 0) - Number(line.bbox?.x0 || 0));
        const letters = (line.text.match(/\p{L}/gu) || []).length;
        const uppercase = (line.text.match(/\p{Lu}/gu) || []).length / Math.max(1, letters);

        let score = line.confidence;
        score += Math.min(40, height * 0.8);
        score += Math.min(20, width * 0.025);
        score += uppercase * 10;
        if (words >= 1 && words <= 5) score += 12;
        if (line.text.length >= 5 && line.text.length <= 35) score += 10;

        return { ...line, score };
      })
      .sort((a, b) => b.score - a.score);

    const presentation =
      rawText.match(/\b\d+(?:[.,]\d+)?\s?(?:kg|g|gr|mg|l|lt|litros?|ml|cc|oz|unidades?|und)\b/i)?.[0] || "";

    const barcode =
      rawText.replace(/\s/g, "").match(/\b\d{8,14}\b/)?.[0] || "";

    const best = candidates[0];
    const second = candidates.find(item => item.text !== best?.text);

    let brand = "";
    let name = "";

    if (best && best.confidence >= 45) {
      brand = best.text;
      name = best.text;

      if (second && second.confidence >= 40 && second.text.length <= 35) {
        name = `${best.text} ${second.text}`.trim();
      }
    }

    const averageConfidence = candidates.length
      ? candidates.slice(0, 3).reduce((sum, item) => sum + item.confidence, 0) / Math.min(3, candidates.length)
      : 0;

    if (averageConfidence < 42 || name.length < 3) {
      name = "";
      brand = "";
    }

    return {
      name,
      brand,
      presentation,
      category: inferCategory(rawText),
      barcode,
      rawText,
      confidence: Math.round(averageConfidence),
      source: "ocr"
    };
  }

  function imageToCanvas(imageData, options = {}) {
    return new Promise((resolve, reject) => {
      const image = new Image();

      image.onload = () => {
        const crop = options.crop || { x: 0, y: 0, width: 1, height: 1 };
        const sourceX = Math.round(image.naturalWidth * crop.x);
        const sourceY = Math.round(image.naturalHeight * crop.y);
        const sourceWidth = Math.round(image.naturalWidth * crop.width);
        const sourceHeight = Math.round(image.naturalHeight * crop.height);
        const maxDimension = options.maxDimension || 1800;
        const scale = Math.min(3, maxDimension / Math.max(sourceWidth, sourceHeight));

        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));

        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(
          image,
          sourceX, sourceY, sourceWidth, sourceHeight,
          0, 0, canvas.width, canvas.height
        );

        if (options.enhance) {
          const imageDataObject = context.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageDataObject.data;

          for (let i = 0; i < data.length; i += 4) {
            const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.9 + 128));
            data[i] = contrasted;
            data[i + 1] = contrasted;
            data[i + 2] = contrasted;
          }

          context.putImageData(imageDataObject, 0, 0);
        }

        resolve(canvas.toDataURL("image/jpeg", 0.9));
      };

      image.onerror = reject;
      image.src = imageData;
    });
  }

  async function runLocalOCR(imageData) {
    if (!window.Tesseract) {
      throw new Error("No se pudo cargar el OCR local. Verifica la conexión.");
    }

    const worker = await Tesseract.createWorker("spa+eng", 1, {
      logger: message => {
        const labels = {
          "loading tesseract core": "Cargando OCR local",
          "initializing tesseract": "Inicializando OCR",
          "loading language traineddata": "Descargando idiomas",
          "initializing api": "Preparando reconocimiento",
          "recognizing text": "Leyendo texto impreso"
        };

        setOCRProgress(
          labels[message.status] || "Analizando texto",
          Number(message.progress || 0)
        );
      }
    });

    try {
      const variants = [
        await imageToCanvas(imageData, {
          crop: { x: 0.08, y: 0.08, width: 0.84, height: 0.84 },
          maxDimension: 1900,
          enhance: false
        }),
        await imageToCanvas(imageData, {
          crop: { x: 0.08, y: 0.08, width: 0.84, height: 0.84 },
          maxDimension: 1900,
          enhance: true
        }),
        await imageToCanvas(imageData, {
          crop: { x: 0.15, y: 0.18, width: 0.70, height: 0.58 },
          maxDimension: 1900,
          enhance: true
        })
      ];

      const results = [];

      await worker.setParameters({
        tessedit_pageseg_mode: "11",
        preserve_interword_spaces: "1"
      });

      for (let index = 0; index < variants.length; index++) {
        setOCRProgress(`OCR local: intento ${index + 1} de ${variants.length}`, index / variants.length);
        results.push((await worker.recognize(variants[index])).data);
      }

      const mergedText = results.map(result => result.text || "").join("\n");
      const mergedLines = results.flatMap(result => result.lines || []);

      return {
        text: mergedText,
        lines: mergedLines
      };
    } finally {
      await worker.terminate();
    }
  }

  async function callVisualAI(imageData) {
    const endpoint = String(state.settings.aiEndpoint || "").trim();

    if (!endpoint) {
      throw new Error("La IA visual todavía no está configurada.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          image: imageData,
          categories: state.categories.map(category => category.name)
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || `Error del servidor (${response.status})`);
      }

      if (!data?.name && !data?.brand) {
        throw new Error("La IA no encontró un producto reconocible.");
      }

      return {
        name: String(data.name || "").trim(),
        brand: String(data.brand || "").trim(),
        presentation: String(data.presentation || "").trim(),
        category: String(data.category || "Otros").trim(),
        barcode: String(data.barcode || "").trim(),
        rawText: String(data.visibleText || data.notes || "Reconocimiento visual completado."),
        confidence: Math.round(Number(data.confidence || 0) * 100),
        source: "ai",
        notes: String(data.notes || "").trim()
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function renderOCRResult(result) {
    const categories = [...state.categories].sort((a, b) => a.name.localeCompare(b.name));
    const selected =
      categories.find(category =>
        category.name.toLowerCase() === String(result.category || "").toLowerCase()
      )?.id || "";

    const confidence = Math.max(0, Math.min(100, Number(result.confidence || 0)));
    const lowConfidence = result.source === "ocr" && (!result.name || confidence < 50);

    $("#scanResult").className = "scan-result";
    $("#scanResult").innerHTML = `
      <div class="ocr-fields">
        <div class="scan-confidence">
          <span>Método utilizado</span>
          <strong>${result.source === "ai" ? "IA visual" : "OCR local"} · ${confidence}%</strong>
        </div>

        <label>Nombre del producto detectado *
          <input id="ocrName" value="${escapeHTML(result.name || "")}"
            placeholder="${lowConfidence ? "No reconocido: escribe el nombre o configura IA visual" : "Corrige o escribe el nombre"}">
        </label>

        <label>Marca
          <input id="ocrBrand" value="${escapeHTML(result.brand || "")}" placeholder="Marca detectada">
        </label>

        <label>Presentación
          <input id="ocrPresentation" value="${escapeHTML(result.presentation || "")}" placeholder="Ej. 68 g">
        </label>

        <label>Categoría
          <select id="ocrCategory">${optionList(categories, "Selecciona una categoría", selected)}</select>
        </label>

        <label>Código de barras
          <input id="ocrBarcode" value="${escapeHTML(result.barcode || "")}" inputmode="numeric">
        </label>
      </div>

      ${lowConfidence ? `
        <div class="scan-warning">
          El OCR local no pudo interpretar correctamente el logo o el texto decorativo.
          Para reconocer productos como Ruffles, Coca-Cola o marcas con letras estilizadas,
          configura el endpoint de IA visual en Ajustes.
        </div>` : ""}

      ${result.notes ? `<div class="scan-warning">${escapeHTML(result.notes)}</div>` : ""}

      <details class="ocr-raw">
        <summary>Ver texto o detalles detectados</summary>
        <pre>${escapeHTML(result.rawText || "No se detectó texto adicional.")}</pre>
      </details>`;
  }

  async function analyzeImage() {
    if (!capturedImageData) return;

    $("#analyzeBtn").disabled = true;
    $("#createFromScanBtn").classList.add("hidden");
    $("#scanMethodStatus").classList.add("hidden");
    $("#scanResult").className = "scan-result";
    $("#scanResult").textContent = "Preparando reconocimiento…";
    setOCRProgress("Preparando análisis", 0);

    try {
      const barcode = await detectBarcode(capturedImageData);
      const known = barcode && state.products.find(product => product.barcode === barcode);

      if (known) {
        scanData = {
          name: known.name,
          brand: known.brand || "",
          presentation: known.presentation || "",
          category: getCategory(known.categoryId)?.name || "",
          barcode,
          existingProductId: known.id,
          rawText: "Producto identificado mediante el código de barras guardado.",
          imageData: capturedImageData,
          confidence: 100,
          source: "barcode"
        };

        setScanMethod("Producto identificado mediante código de barras.");
      } else if (state.settings.aiEndpoint && navigator.onLine) {
        setScanMethod("Analizando la fotografía con IA visual…");
        setOCRProgress("Interpretando producto y etiqueta", 0.35);

        try {
          scanData = {
            ...(await callVisualAI(capturedImageData)),
            barcode: barcode || "",
            imageData: capturedImageData
          };

          setScanMethod("Resultado obtenido mediante IA visual.");
        } catch (aiError) {
          setScanMethod("La IA visual falló; usando OCR local como respaldo.", true);
          toast(aiError.message, "error");

          const local = extractProductData(await runLocalOCR(capturedImageData));
          scanData = {
            ...local,
            barcode: barcode || local.barcode,
            imageData: capturedImageData,
            notes: "La IA visual no estuvo disponible. Se utilizó OCR local."
          };
        }
      } else {
        setScanMethod(
          "Usando OCR local. Para logos y empaques decorativos configura la IA visual en Ajustes.",
          true
        );

        const local = extractProductData(await runLocalOCR(capturedImageData));
        scanData = {
          ...local,
          barcode: barcode || local.barcode,
          imageData: capturedImageData
        };
      }

      setOCRProgress("Análisis completado", 1);
      renderOCRResult(scanData);

      $("#createFromScanBtn").textContent =
        scanData.existingProductId
          ? "Registrar precio para este producto"
          : "Crear producto nuevo";

      $("#createFromScanBtn").dataset.mode =
        scanData.existingProductId ? "price" : "product";

      $("#createFromScanBtn").classList.remove("hidden");
    } catch (error) {
      $("#scanResult").innerHTML = `
        <div class="notice">
          <strong>No se pudo completar el reconocimiento.</strong><br>
          ${escapeHTML(error.message || "Intenta con otra fotografía.")}
        </div>`;

      toast("No se pudo reconocer el producto.", "error");
    } finally {
      $("#analyzeBtn").disabled = false;
      setTimeout(() => $("#ocrProgressWrap").classList.add("hidden"), 1300);
    }
  }

  function createFromScan() {
    if (!scanData) return;
    if ($("#createFromScanBtn").dataset.mode === "price" && scanData.existingProductId) {
      openModal("priceModal", { productId: scanData.existingProductId });
      navigate("prices");
      return;
    }
    const name = $("#ocrName")?.value.trim() || scanData.name || "";
    if (!name) {
      toast("Confirma o escribe el nombre del producto.","error");
      $("#ocrName")?.focus();
      return;
    }
    resetProductForm();
    $("#productName").value = name;
    $("#productBrand").value = $("#ocrBrand")?.value.trim() || "";
    $("#productPresentation").value = $("#ocrPresentation")?.value.trim() || "";
    $("#productBarcode").value = $("#ocrBarcode")?.value.trim() || "";
    $("#productCategory").value = $("#ocrCategory")?.value || "";
    productEditingImage = scanData.imageData || "";
    if (productEditingImage) {
      $("#productImagePreview").src = productEditingImage;
      $("#productImagePreview").classList.remove("hidden");
    }
    $("#productModal").showModal();
  }

  async function saveAISettings(event) {
    event.preventDefault();

    const endpoint = $("#aiEndpoint").value.trim().replace(/\/$/, "");
    await put("settings", { id: "aiEndpoint", value: endpoint });

    await loadState();
    updateAIStatus();
    showEndpointMessage(
      endpoint
        ? "Endpoint guardado. Usa “Probar conexión” para verificarlo."
        : "Se eliminó la configuración de IA visual.",
      endpoint ? "success" : ""
    );
    toast("Configuración guardada.", "success");
  }

  function exportData() {
    const payload = {
      app: "Mi Compra Inteligente",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        products: state.products,
        stores: state.stores,
        categories: state.categories,
        prices: state.prices,
        shoppingItems: state.shoppingItems,
        settings: Object.entries(state.settings).map(([id, value]) => ({ id, value }))
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mi-compra-inteligente-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importData(file) {
    try {
      const payload = JSON.parse(await file.text());
      if (!payload?.data) throw new Error("Formato inválido");
      if (!confirmAction("La importación reemplazará los datos actuales. ¿Continuar?")) return;

      for (const store of STORE_NAMES) await clearStore(store);
      for (const name of STORE_NAMES) {
        const rows = payload.data[name] || [];
        for (const row of rows) await put(name, row);
      }
      await loadState();
      await seedDefaults();
      renderAll();
      toast("Respaldo importado correctamente.", "success");
    } catch (error) {
      toast("No se pudo importar el archivo.", "error");
    }
  }

  async function clearAllData() {
    if (!confirmAction("Se borrarán todos los productos, precios y listas de este dispositivo. ¿Continuar?")) return;
    for (const store of STORE_NAMES) await clearStore(store);
    await loadState();
    await seedDefaults();
    renderAll();
    toast("Datos borrados.", "success");
  }

  function isHostedProtocol() {
    return location.protocol === "http:" || location.protocol === "https:";
  }

  function isSecureAppOrigin() {
    return location.protocol === "https:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  }

  function updateConnectionStatus() {
    if (!isHostedProtocol()) {
      $("#connectionStatus").textContent = `Vista local · guardado ${storageBackend === "memory" ? "temporal" : "activo"}`;
      $("#localModeBanner").classList.remove("hidden");
      $("#installBtn").classList.add("hidden");
      return;
    }

    $("#localModeBanner").classList.add("hidden");
    $("#connectionStatus").textContent = navigator.onLine
      ? "En línea · guardado local activo"
      : "Sin conexión · modo local activo";
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator && isSecureAppOrigin()) {
      navigator.serviceWorker.register("sw.js").catch(() => {
        toast("No se pudo activar el modo sin conexión.", "error");
      });
    }
  }

  function bindEvents() {
    $$(".nav-btn").forEach((btn) => btn.addEventListener("click", () => navigate(btn.dataset.view)));
    $$("[data-view-target]").forEach((btn) => btn.addEventListener("click", () => navigate(btn.dataset.viewTarget)));
    $$("[data-open]").forEach((btn) => btn.addEventListener("click", () => openModal(btn.dataset.open)));
    $$("[data-close]").forEach((btn) => btn.addEventListener("click", () => closeModal(btn.dataset.close)));

    $("#quickAddBtn").addEventListener("click", () => openModal("priceModal"));
    $("#productForm").addEventListener("submit", handleProductSubmit);
    $("#priceForm").addEventListener("submit", handlePriceSubmit);
    $("#shoppingForm").addEventListener("submit", handleShoppingSubmit);
    $("#storeForm").addEventListener("submit", handleStoreSubmit);
    $("#categoryForm").addEventListener("submit", handleCategorySubmit);
    $("#aiSettingsForm").addEventListener("submit", saveAISettings);
    $("#testAIEndpointBtn").addEventListener("click", testAIEndpoint);

    document.addEventListener("click", handleDelegatedAction);

    $("#productSearch").addEventListener("input", renderProducts);
    $("#productCategoryFilter").addEventListener("change", renderProducts);
    $("#priceSearch").addEventListener("input", renderPrices);
    $("#priceStoreFilter").addEventListener("change", renderPrices);
    $("#compareSearch").addEventListener("input", renderCompare);
    $("#compareCategoryFilter").addEventListener("change", renderCompare);
    $("#showCompleted").addEventListener("change", renderShopping);

    $("#productImage").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      productEditingImage = await fileToDataURL(file);
      $("#productImagePreview").src = productEditingImage;
      $("#productImagePreview").classList.remove("hidden");
    });

    $("#startCameraBtn").addEventListener("click", startCamera);
    $("#captureBtn").addEventListener("click", captureCameraImage);
    $("#imageInput").addEventListener("change", (e) => e.target.files[0] && loadScanImage(e.target.files[0]));
    $("#analyzeBtn").addEventListener("click", analyzeImage);
    $("#createFromScanBtn").addEventListener("click", createFromScan);

    $("#exportBtn").addEventListener("click", exportData);
    $("#importInput").addEventListener("change", (e) => e.target.files[0] && importData(e.target.files[0]));
    $("#clearDataBtn").addEventListener("click", clearAllData);
    $("#finishPurchaseBtn").addEventListener("click", finishPurchase);
    $("#newListBtn").addEventListener("click", async()=>{if(!state.shoppingItems.length||confirm("¿Limpiar la lista activa y comenzar una nueva?")){for(const i of state.shoppingItems)await remove("shoppingItems",i.id);await loadState();renderAll();}});
    $("#exportSharedListBtn").addEventListener("click", exportSharedList);
    $("#sharedListInput").addEventListener("change", e=>e.target.files[0]&&importSharedList(e.target.files[0]));


    window.addEventListener("online", updateConnectionStatus);
    window.addEventListener("offline", updateConnectionStatus);
    window.addEventListener("beforeinstallprompt", (event) => {
      if (!isHostedProtocol()) return;
      event.preventDefault();
      deferredInstallPrompt = event;
      $("#installBtn").classList.remove("hidden");
    });
    $("#installBtn").addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      $("#installBtn").classList.add("hidden");
    });
    window.addEventListener("appinstalled", () => toast("Aplicación instalada.", "success"));
    window.addEventListener("pagehide", stopCamera);
  }

  async function init() {
    try {
      db = await openDB();
      await loadState();
      await seedDefaults();
      bindEvents();
      renderAll();
      updateConnectionStatus();
      registerServiceWorker();
      $("#priceDate").value = today();
    } catch (error) {
      console.error(error);
      toast("No se pudo iniciar la base de datos local.", "error");
      $("#connectionStatus").textContent = "Error de almacenamiento";
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
