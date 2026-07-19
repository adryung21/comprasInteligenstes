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
  let pendingReceivedPackage = null;
  let firebaseBridge = null;
  let firebaseUser = null;
  let firebaseProfile = null;
  let cloudSyncPaused = false;

  const state = {
    products: [],
    stores: [],
    categories: [],
    prices: [],
    shoppingItems: [],
    purchaseHistory: [],
    sharedLists: [],
    submissions: [],
    priceChanges: [],
    adminDuplicateAudit: { duplicateGroups: [], duplicateDocuments: 0 },
    settings: {}
  };

  const rawLocalData = {
    products: [],
    stores: [],
    categories: [],
    prices: [],
    shoppingItems: [],
    purchaseHistory: [],
    sharedLists: []
  };

  let productAliasMap = new Map();
  let storeAliasMap = new Map();
  let categoryAliasMap = new Map();

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

  function prepareLocalValue(storeName, value) {
    if (!value || !firebaseUser) return value;

    const uid = firebaseUser.uid;
    const isAdmin = firebaseProfile?.role === "admin";
    const prepared = { ...value };

    if (storeName === "products") {
      if (cloudSyncPaused || prepared.cloudPublic || prepared.visibility === "public") {
        return {
          ...prepared,
          visibility: "public",
          cloudPublic: Boolean(prepared.cloudPublic)
        };
      }

      if (isAdmin) {
        return {
          ...prepared,
          visibility: "public",
          ownerUid: "",
          status: prepared.status || "approved"
        };
      }

      const editingPublicProduct =
        prepared.visibility === "public" ||
        prepared.cloudPublic ||
        prepared.status === "approved";

      return {
        ...prepared,
        id: editingPublicProduct && !prepared.ownerUid
          ? `private_${uid}_${prepared.id}`
          : prepared.id,
        baseProductId: editingPublicProduct
          ? (prepared.baseProductId || prepared.id)
          : (prepared.baseProductId || ""),
        ownerUid: uid,
        visibility: "private",
        cloudPublic: false,
        status: "pending-local"
      };
    }

    if (storeName === "stores" || storeName === "categories") {
      if (cloudSyncPaused || prepared.visibility === "public") {
        return { ...prepared, visibility: "public" };
      }

      return isAdmin
        ? { ...prepared, visibility: "public", ownerUid: "" }
        : { ...prepared, visibility: "private", ownerUid: uid };
    }

    if (storeName === "prices") {
      if (
        prepared.cloudVerified ||
        prepared.visibility === "public" ||
        prepared.source === "verified"
      ) {
        return {
          ...prepared,
          visibility: "public",
          source: "verified",
          ownerUid: ""
        };
      }

      return {
        ...prepared,
        visibility: "private",
        source: prepared.source || "private",
        ownerUid: uid
      };
    }

    if (["shoppingItems", "purchaseHistory", "sharedLists"].includes(storeName)) {
      return {
        ...prepared,
        visibility: "private",
        ownerUid: uid
      };
    }

    return prepared;
  }

  function put(storeName, value) {
    const storedValue = prepareLocalValue(storeName, value);

    if (storageBackend !== "indexeddb") {
      const rows = readFallbackStore(storeName);
      const index = rows.findIndex((row) => row.id === storedValue.id);
      if (index >= 0) rows[index] = storedValue;
      else rows.push(storedValue);
      writeFallbackStore(storeName, rows);
      mirrorLocalPut(storeName, storedValue);
      return Promise.resolve(storedValue);
    }

    return new Promise((resolve, reject) => {
      const request = tx(storeName, "readwrite").put(storedValue);
      request.onsuccess = () => resolve(storedValue);
      request.onerror = () => reject(request.error);
    }).then((result) => {
      mirrorLocalPut(storeName, result);
      return result;
    });
  }

  function mirrorLocalPut(storeName, value) {
    if (cloudSyncPaused || !firebaseBridge?.currentUser) return;
    firebaseBridge.mirrorPut(storeName, value).catch((error) => {
      console.warn(`No se pudo sincronizar ${storeName}:`, error);
    });
  }

  function mirrorLocalDelete(storeName, id) {
    if (cloudSyncPaused || !firebaseBridge?.currentUser) return;
    firebaseBridge.mirrorDelete(storeName, id).catch((error) => {
      console.warn(`No se pudo eliminar ${storeName} en Firebase:`, error);
    });
  }

  function remove(storeName, id) {
    if (storageBackend !== "indexeddb") {
      writeFallbackStore(storeName, readFallbackStore(storeName).filter((row) => row.id !== id));
      mirrorLocalDelete(storeName, id);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const request = tx(storeName, "readwrite").delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }).then(() => {
      mirrorLocalDelete(storeName, id);
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

  function normalizeTextKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function productIdentity(product) {
    const barcode = String(product?.barcode || "").trim();
    if (barcode) return `barcode:${barcode}`;

    return [
      product?.name || "",
      product?.brand || "",
      product?.presentation || ""
    ].map(normalizeTextKey).join("|");
  }

  function publicOrOwned(row) {
    if (!firebaseUser) return true;

    return (
      row?.visibility === "public" ||
      row?.cloudPublic === true ||
      row?.cloudVerified === true ||
      row?.source === "verified" ||
      row?.ownerUid === firebaseUser.uid
    );
  }

  function choosePreferredRecord(current, candidate, kind = "generic") {
    if (!current) return candidate;

    const uid = firebaseUser?.uid || "";
    const score = (row) => {
      let points = 0;
      if (row.ownerUid === uid) points += 60;
      if (row.visibility === "public") points += 45;
      if (row.cloudPublic || row.cloudVerified || row.source === "verified") points += 40;
      if (row.status === "approved") points += 20;
      if (row.barcode) points += 8;
      if (kind === "product") points += Math.min(15, String(row.description || "").length / 30);
      points += Math.min(5, Number(row.updatedAt || row.createdAt || 0) / 1e13);
      return points;
    };

    return score(candidate) > score(current) ? candidate : current;
  }

  function dedupeNamedRecords(rows, keyBuilder) {
    const groups = new Map();
    const aliasMap = new Map();

    for (const row of rows) {
      const key = keyBuilder(row);
      if (!key) continue;
      const preferred = choosePreferredRecord(groups.get(key), row);
      groups.set(key, preferred);
    }

    for (const row of rows) {
      const key = keyBuilder(row);
      const canonical = groups.get(key);
      if (canonical) aliasMap.set(row.id, canonical.id);
    }

    return {
      rows: [...groups.values()],
      aliasMap
    };
  }

  function dedupeProducts(rows) {
    const groups = new Map();
    const aliases = new Map();

    for (const product of rows) {
      const key = productIdentity(product);
      if (!key || key === "||") continue;
      const preferred = choosePreferredRecord(groups.get(key), product, "product");
      groups.set(key, preferred);
    }

    for (const product of rows) {
      const canonical = groups.get(productIdentity(product));
      if (canonical) aliases.set(product.id, canonical.id);
    }

    return {
      rows: [...groups.values()],
      aliasMap: aliases
    };
  }

  function canonicalProductId(productId) {
    return productAliasMap.get(productId) || productId;
  }

  function canonicalStoreId(storeId) {
    return storeAliasMap.get(storeId) || storeId;
  }

  function dedupePrices(rows) {
    const groups = new Map();

    for (const original of rows) {
      const price = {
        ...original,
        productId: canonicalProductId(original.productId),
        storeId: canonicalStoreId(original.storeId)
      };

      const key = [
        price.productId,
        price.storeId,
        Number(price.price).toFixed(4),
        String(price.date || "")
      ].join("|");

      const current = groups.get(key);
      groups.set(key, choosePreferredRecord(current, price));
    }

    return [...groups.values()];
  }

  function dedupeShoppingRows(rows) {
    const groups = new Map();

    for (const original of rows) {
      const item = {
        ...original,
        productId: canonicalProductId(original.productId)
      };
      const key = `${item.productId}|${Boolean(item.completed)}`;
      const current = groups.get(key);

      if (!current) {
        groups.set(key, item);
        continue;
      }

      groups.set(key, {
        ...choosePreferredRecord(current, item),
        quantity: Math.max(Number(current.quantity || 1), Number(item.quantity || 1)),
        completed: Boolean(current.completed || item.completed),
        updatedAt: Math.max(Number(current.updatedAt || 0), Number(item.updatedAt || 0))
      });
    }

    return [...groups.values()];
  }

  async function loadState() {
    const [
      products,
      stores,
      categories,
      prices,
      shoppingItems,
      settingsRows,
      purchaseHistory,
      sharedLists
    ] = await Promise.all(STORE_NAMES.map(getAll));

    rawLocalData.products = products;
    rawLocalData.stores = stores;
    rawLocalData.categories = categories;
    rawLocalData.prices = prices;
    rawLocalData.shoppingItems = shoppingItems;
    rawLocalData.purchaseHistory = purchaseHistory;
    rawLocalData.sharedLists = sharedLists;

    const visibleProducts = products.filter(publicOrOwned);
    const visibleStores = stores.filter(publicOrOwned);
    const visibleCategories = categories.filter(publicOrOwned);

    const productResult = dedupeProducts(visibleProducts);
    productAliasMap = productResult.aliasMap;
    state.products = productResult.rows;

    const storeResult = dedupeNamedRecords(
      visibleStores,
      row => normalizeTextKey(row.name)
    );
    storeAliasMap = storeResult.aliasMap;
    state.stores = storeResult.rows;

    const categoryResult = dedupeNamedRecords(
      visibleCategories,
      row => normalizeTextKey(row.name)
    );
    categoryAliasMap = categoryResult.aliasMap;
    state.categories = categoryResult.rows;

    state.prices = dedupePrices(prices.filter(publicOrOwned));

    state.shoppingItems = dedupeShoppingRows(
      shoppingItems.filter(row =>
        !firebaseUser || row.ownerUid === firebaseUser.uid
      )
    );

    state.purchaseHistory = purchaseHistory.filter(row =>
      !firebaseUser || row.ownerUid === firebaseUser.uid
    );

    state.sharedLists = sharedLists.filter(row =>
      !firebaseUser || row.ownerUid === firebaseUser.uid
    );

    state.settings = Object.fromEntries(
      settingsRows.map((row) => [row.id, row.value])
    );
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
      .filter((p) => [p.name, p.brand, p.description, p.presentation, p.barcode].join(" ").toLowerCase().includes(query))
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
            ${p.description ? `<span>${escapeHTML(p.description.length > 110 ? `${p.description.slice(0, 110)}…` : p.description)}</span><br>` : ""}
            ${p.presentation ? `${escapeHTML(p.presentation)}<br>` : ""}
            ${p.barcode ? `Código: ${escapeHTML(p.barcode)}` : "Sin código"}
          </div>
          <div class="product-meta" style="margin-top:8px">
            ${best ? `Mejor precio: <strong>${money(best.price)}</strong> en ${escapeHTML(getStore(best.storeId)?.name || "—")}` : "Sin precios registrados"}
          </div>
          <div class="product-actions">
            <button class="btn btn-secondary btn-sm" data-action="edit-product" data-id="${p.id}">
              ${firebaseProfile?.role === "admin" || p.ownerUid === firebaseUser?.uid
                ? "Editar"
                : "Proponer edición"}
            </button>
            <button class="btn btn-secondary btn-sm" data-action="price-product" data-id="${p.id}">+ Precio</button>
            <button class="btn btn-accent btn-sm" data-action="add-product-list" data-id="${p.id}">+ Lista</button>
            ${firebaseProfile?.role === "admin" || p.ownerUid === firebaseUser?.uid
              ? `<button class="btn btn-danger btn-sm" data-action="delete-product" data-id="${p.id}">Borrar</button>`
              : ""}
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
            <td>
              ${p.source === "verified" || p.cloudVerified
                ? `<span class="price-source verified">Oficial</span>`
                : `<span class="price-source personal">Mi precio</span>`}
              ${p.note ? `<small>${escapeHTML(p.note)}</small>` : ""}
            </td>
            <td>
              ${p.source === "verified" || p.cloudVerified
                ? "—"
                : (() => {
                    const submission = priceSubmissionFor(p);
                    if (submission?.status === "pending") {
                      return `<span class="status-pill pending">En revisión</span>`;
                    }
                    if (submission?.status === "approved") {
                      return `<span class="status-pill approved">Aprobado</span>`;
                    }
                    return `
                      <div class="submission-card-actions">
                        <button class="btn btn-secondary btn-sm"
                          data-action="submit-price-verification" data-id="${p.id}">
                          ${submission?.status === "rejected" ? "Reenviar" : "Enviar"}
                        </button>
                        <button class="btn btn-danger btn-sm"
                          data-action="delete-price" data-id="${p.id}">
                          Borrar
                        </button>
                      </div>`;
                  })()}
            </td>
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
        <p>${s.items.length} artículos · recibida ${new Date(s.importedAt).toLocaleString("es-EC")}</p>
        <div class="shared-package-stats">
          <span>${s.packageStats?.products ?? s.items.length} productos</span>
          <span>${s.packageStats?.prices ?? 0} precios</span>
          <span>${s.packageStats?.stores ?? 0} tiendas</span>
        </div></div></div>
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
          description:row.description||"",presentation:row.presentation||"",categoryId:state.categories.find(c=>c.name===row.category)?.id || state.categories[0]?.id || "",
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

  function normalizedProductKey(product) {
    return [
      product.name || "",
      product.brand || "",
      product.presentation || ""
    ].map(value => String(value).trim().toLowerCase().replace(/\s+/g, " ")).join("|");
  }

  function safeFileName(value) {
    return String(value || "lista-compra")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "lista-compra";
  }

  function buildCompleteSharedPackage(listName) {
    const activeItems = state.shoppingItems.map(item => ({
      productId: item.productId,
      quantity: Number(item.quantity),
      completed: Boolean(item.completed)
    }));

    const productIds = [...new Set(activeItems.map(item => item.productId))];
    const products = state.products
      .filter(product => productIds.includes(product.id))
      .map(product => ({
        id: product.id,
        name: product.name,
        brand: product.brand || "",
        description: product.description || "",
        presentation: product.presentation || "",
        categoryId: product.categoryId || "",
        categoryName: getCategory(product.categoryId)?.name || "Otros",
        barcode: product.barcode || "",
        imageData: product.imageData || "",
        createdAt: product.createdAt || Date.now(),
        updatedAt: product.updatedAt || Date.now()
      }));

    const prices = state.prices
      .filter(price => productIds.includes(price.productId))
      .map(price => ({
        id: price.id,
        productId: price.productId,
        storeId: price.storeId,
        storeName: getStore(price.storeId)?.name || "Tienda importada",
        price: Number(price.price),
        date: price.date || "",
        note: price.note || "",
        createdAt: price.createdAt || Date.now()
      }));

    const storeIds = [...new Set(prices.map(price => price.storeId).filter(Boolean))];
    const stores = state.stores
      .filter(store => storeIds.includes(store.id))
      .map(store => ({ id: store.id, name: store.name }));

    const categoryIds = [...new Set(products.map(product => product.categoryId).filter(Boolean))];
    const categories = state.categories
      .filter(category => categoryIds.includes(category.id))
      .map(category => ({ id: category.id, name: category.name }));

    return {
      type: "mi-compra-complete-package",
      version: 2,
      app: "Mi Compra Inteligente",
      exportedAt: new Date().toISOString(),
      list: {
        id: uid("shared_list"),
        name: listName,
        createdAt: Date.now(),
        items: activeItems
      },
      catalog: {
        products,
        categories,
        stores,
        prices
      }
    };
  }

  function downloadSharedPackage(file) {
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function exportSharedList() {
    if (!state.shoppingItems.length) {
      toast("La lista está vacía.", "error");
      return;
    }

    const defaultName = `Lista de compra ${new Date().toLocaleDateString("es-EC")}`;
    const listName = prompt("Nombre de la lista que vas a compartir:", defaultName);

    if (!listName?.trim()) return;

    const payload = buildCompleteSharedPackage(listName.trim());
    const jsonText = JSON.stringify(payload);
    const file = new File(
      [jsonText],
      `${safeFileName(listName)}.json`,
      { type: "application/json" }
    );

    if (file.size > 25 * 1024 * 1024) {
      const proceed = confirm(
        `El paquete pesa ${(file.size / 1024 / 1024).toFixed(1)} MB porque contiene fotografías. ¿Deseas compartirlo de todas formas?`
      );
      if (!proceed) return;
    }

    try {
      if (
        navigator.share &&
        (!navigator.canShare || navigator.canShare({ files: [file] }))
      ) {
        await navigator.share({
          title: listName.trim(),
          text: "Lista completa de Mi Compra Inteligente con productos y precios.",
          files: [file]
        });
        toast("Lista enviada al menú de compartir del dispositivo.", "success");
        return;
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.warn("No fue posible usar el menú de compartir:", error);
    }

    downloadSharedPackage(file);
    toast(
      "Este navegador no permitió Quick Share directamente. Se descargó el paquete como alternativa.",
      "error"
    );
  }

  function normalizeIncomingPackage(data) {
    if (data?.type === "mi-compra-complete-package" && Number(data.version) >= 2) {
      if (!data.list || !Array.isArray(data.list.items) || !data.catalog) {
        throw new Error("El paquete completo está incompleto.");
      }
      return data;
    }

    if (data?.type === "mi-compra-shared-list" && Array.isArray(data.items)) {
      const products = data.items.map(item => ({
        id: item.productId || uid("remote_product"),
        name: item.name || "Producto importado",
        brand: item.brand || "",
        description: item.description || "",
        presentation: item.presentation || "",
        categoryId: "",
        categoryName: item.category || "Otros",
        barcode: item.barcode || "",
        imageData: item.imageData || ""
      }));

      return {
        type: "mi-compra-complete-package",
        version: 2,
        app: "Mi Compra Inteligente",
        exportedAt: data.exportedAt || new Date().toISOString(),
        list: {
          id: uid("shared_list"),
          name: data.name || "Lista compartida",
          createdAt: Date.now(),
          items: data.items.map(item => ({
            productId: item.productId,
            quantity: Number(item.quantity || 1),
            completed: Boolean(item.completed)
          }))
        },
        catalog: {
          products,
          categories: [],
          stores: [],
          prices: []
        }
      };
    }

    throw new Error("El archivo no corresponde a una lista de Mi Compra Inteligente.");
  }

  function showReceivedPackagePreview(rawData) {
    try {
      const data = normalizeIncomingPackage(rawData);
      pendingReceivedPackage = data;

      $("#receivedShareName").textContent = data.list.name || "Lista compartida";
      $("#receivedItemsCount").textContent = data.list.items.length;
      $("#receivedProductsCount").textContent = data.catalog.products?.length || 0;
      $("#receivedPricesCount").textContent = data.catalog.prices?.length || 0;
      $("#receivedStoresCount").textContent = data.catalog.stores?.length || 0;

      $("#receivedShareModal").showModal();
    } catch (error) {
      pendingReceivedPackage = null;
      toast(error.message || "No se pudo leer el paquete.", "error");
    }
  }

  async function importCompletePackage(rawData, mode = "save") {
    const data = normalizeIncomingPackage(rawData);
    const remoteCategories = Array.isArray(data.catalog.categories) ? data.catalog.categories : [];
    const remoteStores = Array.isArray(data.catalog.stores) ? data.catalog.stores : [];
    const remoteProducts = Array.isArray(data.catalog.products) ? data.catalog.products : [];
    const remotePrices = Array.isArray(data.catalog.prices) ? data.catalog.prices : [];

    const localCategories = [...state.categories];
    const localStores = [...state.stores];
    const localProducts = [...state.products];
    const localPrices = [...state.prices];

    const categoryMap = new Map();
    const storeMap = new Map();
    const productMap = new Map();

    async function ensureCategory(remoteId, name) {
      const categoryName = String(name || "Otros").trim() || "Otros";
      let local = localCategories.find(
        category => category.name.toLowerCase() === categoryName.toLowerCase()
      );

      if (!local) {
        local = { id: uid("cat"), name: categoryName };
        await put("categories", local);
        localCategories.push(local);
      }

      if (remoteId) categoryMap.set(remoteId, local.id);
      return local.id;
    }

    async function ensureStore(remoteId, name) {
      const storeName = String(name || "Tienda importada").trim() || "Tienda importada";
      let local = localStores.find(
        store => store.name.toLowerCase() === storeName.toLowerCase()
      );

      if (!local) {
        local = { id: uid("store"), name: storeName };
        await put("stores", local);
        localStores.push(local);
      }

      if (remoteId) storeMap.set(remoteId, local.id);
      return local.id;
    }

    for (const category of remoteCategories) {
      await ensureCategory(category.id, category.name);
    }

    for (const store of remoteStores) {
      await ensureStore(store.id, store.name);
    }

    for (const remote of remoteProducts) {
      const categoryId = await ensureCategory(
        remote.categoryId,
        remote.categoryName ||
          remoteCategories.find(category => category.id === remote.categoryId)?.name ||
          "Otros"
      );

      const barcode = String(remote.barcode || "").trim();
      const remoteKey = normalizedProductKey(remote);

      let local = barcode
        ? localProducts.find(product => String(product.barcode || "").trim() === barcode)
        : null;

      if (!local) {
        local = localProducts.find(product => normalizedProductKey(product) === remoteKey);
      }

      if (local) {
        const mergedDescription =
          String(remote.description || "").length > String(local.description || "").length
            ? String(remote.description || "")
            : String(local.description || "");

        const updated = {
          ...local,
          brand: local.brand || remote.brand || "",
          description: mergedDescription,
          presentation: local.presentation || remote.presentation || "",
          categoryId: local.categoryId || categoryId,
          barcode: local.barcode || barcode,
          imageData: local.imageData || remote.imageData || "",
          updatedAt: Date.now()
        };

        await put("products", updated);
        Object.assign(local, updated);
      } else {
        local = {
          id: uid("product"),
          name: remote.name || "Producto importado",
          brand: remote.brand || "",
          description: remote.description || "",
          presentation: remote.presentation || "",
          categoryId,
          barcode,
          imageData: remote.imageData || "",
          createdAt: remote.createdAt || Date.now(),
          updatedAt: Date.now()
        };

        await put("products", local);
        localProducts.push(local);
      }

      productMap.set(remote.id, local.id);
    }

    for (const remotePrice of remotePrices) {
      const localProductId = productMap.get(remotePrice.productId);
      if (!localProductId) continue;

      const localStoreId =
        storeMap.get(remotePrice.storeId) ||
        await ensureStore(remotePrice.storeId, remotePrice.storeName);

      const exists = localPrices.some(price =>
        price.productId === localProductId &&
        price.storeId === localStoreId &&
        Number(price.price) === Number(remotePrice.price) &&
        String(price.date || "") === String(remotePrice.date || "") &&
        String(price.note || "") === String(remotePrice.note || "")
      );

      if (exists) continue;

      const importedPrice = {
        id: uid("price"),
        productId: localProductId,
        storeId: localStoreId,
        price: Number(remotePrice.price),
        date: remotePrice.date || today(),
        note: remotePrice.note || "Importado desde lista compartida",
        createdAt: remotePrice.createdAt || Date.now()
      };

      await put("prices", importedPrice);
      localPrices.push(importedPrice);
    }

    const localItems = data.list.items.map(item => {
      const remoteProduct = remoteProducts.find(product => product.id === item.productId);
      const localProductId = productMap.get(item.productId);
      const localProduct = localProducts.find(product => product.id === localProductId);

      return {
        productId: localProductId,
        name: localProduct?.name || remoteProduct?.name || "Producto importado",
        brand: localProduct?.brand || remoteProduct?.brand || "",
        description: localProduct?.description || remoteProduct?.description || "",
        presentation: localProduct?.presentation || remoteProduct?.presentation || "",
        category: localCategories.find(category => category.id === localProduct?.categoryId)?.name || "Otros",
        quantity: Number(item.quantity || 1),
        completed: Boolean(item.completed)
      };
    }).filter(item => item.productId);

    if (mode === "save") {
      await put("sharedLists", {
        id: uid("shared"),
        name: data.list.name || "Lista recibida",
        items: localItems,
        importedAt: Date.now(),
        packageStats: {
          products: remoteProducts.length,
          prices: remotePrices.length,
          stores: remoteStores.length
        }
      });
    }

    if (mode === "merge") {
      for (const row of localItems) {
        const existing = state.shoppingItems.find(
          item => item.productId === row.productId && !item.completed
        );

        if (existing) {
          existing.quantity = Number(existing.quantity) + Number(row.quantity);
          existing.updatedAt = Date.now();
          await put("shoppingItems", existing);
        } else {
          await put("shoppingItems", {
            id: uid("shopping"),
            productId: row.productId,
            quantity: Number(row.quantity),
            completed: false,
            createdAt: Date.now()
          });
        }
      }
    }

    await loadState();
    renderAll();

    return {
      items: localItems.length,
      products: remoteProducts.length,
      prices: remotePrices.length
    };
  }

  async function importSharedList(file) {
    try {
      const data = JSON.parse(await file.text());
      showReceivedPackagePreview(data);
    } catch {
      toast("No se pudo abrir el paquete recibido.", "error");
    }
  }

  async function savePendingReceivedPackage(mode) {
    if (!pendingReceivedPackage) return;

    const button =
      mode === "merge" ? $("#mergeReceivedListBtn") : $("#saveReceivedListBtn");
    const originalText = button.textContent;

    button.disabled = true;
    button.textContent = "Importando…";

    try {
      const result = await importCompletePackage(pendingReceivedPackage, mode);
      closeModal("receivedShareModal");
      pendingReceivedPackage = null;

      toast(
        mode === "merge"
          ? `Lista combinada. Se incorporaron ${result.products} productos y ${result.prices} precios.`
          : `Lista guardada. Se incorporaron ${result.products} productos y ${result.prices} precios.`,
        "success"
      );

      navigate("shopping");
    } catch (error) {
      toast(error.message || "No se pudo importar el paquete.", "error");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function consumeSharedTargetPayload() {
    const params = new URLSearchParams(location.search);
    if (!params.has("receivedShare")) return;

    try {
      if ("serviceWorker" in navigator) {
        await navigator.serviceWorker.ready;
      }

      const response = await fetch("./__share_inbox__", {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error("No se encontró el paquete compartido.");
      }

      const data = await response.json();
      showReceivedPackagePreview(data);
      navigate("shopping");
    } catch (error) {
      toast(error.message || "No se pudo recibir la lista.", "error");
    } finally {
      history.replaceState({}, "", "./index.html");
    }
  }

  function configureFileLaunchReception() {
    if (!("launchQueue" in window)) return;

    launchQueue.setConsumer(async launchParams => {
      const handle = launchParams.files?.[0];
      if (!handle) return;

      try {
        const file = await handle.getFile();
        await importSharedList(file);
        navigate("shopping");
      } catch {
        toast("No se pudo abrir el archivo compartido.", "error");
      }
    });
  }

  function accountIsolationKey(uid) {
    return `accountIsolationV203_${uid}`;
  }

  async function scopeLegacyLocalDataForCurrentUser() {
    if (!firebaseUser || firebaseProfile?.role !== "admin") return;

    const key = accountIsolationKey(firebaseUser.uid);
    if (state.settings[key]?.completed) return;

    cloudSyncPaused = true;

    try {
      const publicStores = ["products", "stores", "categories"];
      const privateStores = ["prices", "shoppingItems", "purchaseHistory", "sharedLists"];

      for (const storeName of publicStores) {
        for (const row of rawLocalData[storeName] || []) {
          if (row.ownerUid || row.visibility) continue;
          await put(storeName, {
            ...row,
            visibility: "public",
            ownerUid: "",
            legacyScopedAt: Date.now()
          });
        }
      }

      for (const storeName of privateStores) {
        for (const row of rawLocalData[storeName] || []) {
          if (row.ownerUid || row.visibility) continue;

          const isPublicPrice =
            storeName === "prices" &&
            (row.cloudVerified || row.source === "verified");

          await put(storeName, isPublicPrice
            ? {
                ...row,
                visibility: "public",
                source: "verified",
                ownerUid: "",
                legacyScopedAt: Date.now()
              }
            : {
                ...row,
                visibility: "private",
                ownerUid: firebaseUser.uid,
                legacyScopedAt: Date.now()
              }
          );
        }
      }

      await put("settings", {
        id: key,
        value: {
          completed: true,
          completedAt: new Date().toISOString()
        }
      });

      await loadState();
    } finally {
      cloudSyncPaused = false;
    }
  }

  function setAuthMessage(message, type = "") {
    const box = $("#authMessage");
    if (!box) return;
    box.textContent = message;
    box.className = `auth-message ${type}`.trim();
  }

  function firebaseErrorMessage(error) {
    const code = String(error?.code || "");
    const messages = {
      "auth/invalid-credential": "Correo o contraseña incorrectos.",
      "auth/user-not-found": "No existe una cuenta con ese correo.",
      "auth/wrong-password": "La contraseña es incorrecta.",
      "auth/email-already-in-use": "Ese correo ya tiene una cuenta.",
      "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
      "auth/popup-closed-by-user": "Se cerró la ventana de Google antes de terminar.",
      "auth/popup-blocked": "El navegador bloqueó la ventana de Google.",
      "auth/network-request-failed": "No se pudo conectar. Revisa el internet.",
      "permission-denied": "Firebase rechazó la operación. Revisa las reglas de Firestore."
    };
    return messages[code] || error?.message || "Ocurrió un error de Firebase.";
  }

  function waitForFirebaseBridge(timeout = 25000) {
    if (window.MCIFirebase) return Promise.resolve(window.MCIFirebase);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("mci-firebase-ready", ready);
        reject(new Error("Firebase tardó demasiado en cargar."));
      }, timeout);

      function ready() {
        clearTimeout(timer);
        resolve(window.MCIFirebase);
      }

      window.addEventListener("mci-firebase-ready", ready, { once: true });
    });
  }

  function migrationKey(uid) {
    return `firebaseMigrationV2_${uid}`;
  }

  function localMigrationSnapshot() {
    return {
      products: state.products,
      stores: state.stores,
      categories: state.categories,
      prices: state.prices,
      shoppingItems: state.shoppingItems,
      purchaseHistory: state.purchaseHistory,
      sharedLists: state.sharedLists,
      settings: state.settings
    };
  }

  function localDataCount() {
    if (firebaseProfile?.role !== "admin") return 0;

    return (
      rawLocalData.products.filter(row => !row.ownerUid && !row.visibility).length +
      rawLocalData.stores.filter(row => !row.ownerUid && !row.visibility).length +
      rawLocalData.categories.filter(row => !row.ownerUid && !row.visibility).length +
      rawLocalData.prices.filter(row =>
        !row.ownerUid && !row.visibility
      ).length +
      rawLocalData.shoppingItems.filter(row =>
        !row.ownerUid || row.ownerUid === firebaseUser?.uid
      ).length +
      rawLocalData.purchaseHistory.filter(row =>
        !row.ownerUid || row.ownerUid === firebaseUser?.uid
      ).length
    );
  }

  function updateAccountUI() {
    const signedIn = Boolean(firebaseUser);
    $("#userChip")?.classList.toggle("hidden", !signedIn);
    if (!signedIn) return;

    const role = firebaseProfile?.role === "admin" ? "Administrador" : "Usuario";
    $("#signedUserName").textContent =
      firebaseUser.displayName || firebaseUser.email || "Usuario";
    $("#signedUserRole").textContent = role;
    $("#settingsUserEmail").textContent = firebaseUser.email || "—";
    $("#settingsUserRole").textContent = role;
    $("#cloudStatusBadge").textContent = "Firebase conectado";
    $("#cloudStatusBadge").className = "cloud-status-badge ready";
    $("#footerStorageStatus").textContent =
      "IndexedDB local + Firebase · Fotografías privadas en este dispositivo";

    const isAdmin = firebaseProfile?.role === "admin";
    $$(".admin-only").forEach(element =>
      element.classList.toggle("hidden", !isAdmin)
    );

    const migrated = Boolean(state.settings[migrationKey(firebaseUser.uid)]);
    $("#settingsMigrationStatus").textContent =
      firebaseProfile?.role === "admin"
        ? (migrated ? "Completada" : "Pendiente")
        : "No requerida";
  }

  function populateMigrationModal() {
    $("#migrationProducts").textContent = state.products.length;
    $("#migrationStores").textContent = state.stores.length;
    $("#migrationCategories").textContent = state.categories.length;
    $("#migrationPrices").textContent = state.prices.length;
    $("#migrationShopping").textContent = state.shoppingItems.length;
    $("#migrationHistory").textContent = state.purchaseHistory.length;
  }

  function openMigrationModal(force = false) {
    if (!firebaseUser) {
      toast("Primero inicia sesión.", "error");
      return;
    }

    if (firebaseProfile?.role !== "admin") {
      toast("Esta cuenta no necesita migración de datos anteriores.", "success");
      return;
    }

    const migrated = Boolean(state.settings[migrationKey(firebaseUser.uid)]);
    if (migrated && !force) return;

    populateMigrationModal();
    $("#migrationProgress").classList.add("hidden");
    $("#startMigrationBtn").disabled = false;
    $("#startMigrationBtn").textContent =
      migrated ? "Migración completada" : "Respaldar y migrar";
    $("#startMigrationBtn").disabled = migrated;
    $("#migrationModal").showModal();
  }

  function setMigrationProgress(message, percent) {
    $("#migrationProgress").classList.remove("hidden");
    $("#migrationProgressText").textContent = message;
    $("#migrationProgressPercent").textContent = `${percent}%`;
    $("#migrationProgressBar").style.width = `${percent}%`;
  }

  function downloadMigrationBackup() {
    const snapshot = {
      app: "Mi Compra Inteligente",
      version: "1.7-backup-before-firebase",
      createdAt: new Date().toISOString(),
      data: localMigrationSnapshot()
    };

    const blob = new Blob(
      [JSON.stringify(snapshot, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mi-compra-respaldo-antes-firebase-${today()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function startFirebaseMigration() {
    if (!firebaseUser || !firebaseBridge) return;

    const button = $("#startMigrationBtn");
    button.disabled = true;

    try {
      const cloudMigration = await firebaseBridge.getMigrationStatus();

      if (cloudMigration.completed) {
        cloudSyncPaused = true;
        await put("settings", {
          id: migrationKey(firebaseUser.uid),
          value: {
            completed: true,
            restoredFromCloud: true,
            completedAtCloud: cloudMigration.completedAtCloud,
            counts: cloudMigration.counts || {}
          }
        });
        cloudSyncPaused = false;
        await loadState();
        updateAccountUI();
        closeModal("migrationModal");
        toast("La migración ya estaba completada en Firebase. No se repitió.", "success");
        return;
      }

      setMigrationProgress("Generando respaldo local", 10);
      downloadMigrationBackup();
      await new Promise((resolve) => setTimeout(resolve, 400));

      const snapshot = localMigrationSnapshot();
      setMigrationProgress("Preparando productos y precios", 30);
      await new Promise((resolve) => setTimeout(resolve, 200));

      setMigrationProgress("Enviando información protegida", 55);
      const result = await firebaseBridge.migrateLocalData(snapshot);

      if (result.skipped) {
        setMigrationProgress("La migración ya estaba completada", 100);
        toast("Firebase bloqueó la migración repetida.", "success");
      } else {
        setMigrationProgress("Confirmando migración", 88);
      }

      await put("settings", {
        id: migrationKey(firebaseUser.uid),
        value: {
          completed: true,
          completedAt: new Date().toISOString(),
          role: result.role,
          counts: result.counts
        }
      });

      await loadState();
      updateAccountUI();
      setMigrationProgress("Migración completada", 100);

      setTimeout(() => closeModal("migrationModal"), 900);
      toast(
        `Migración completada: ${result.counts.products} productos y ${result.counts.prices} precios.`,
        "success"
      );
    } catch (error) {
      console.error(error);
      setMigrationProgress("No se pudo completar", 0);
      toast(firebaseErrorMessage(error), "error");
      button.disabled = false;
    }
  }

  async function mergeCloudData(payload) {
    if (!payload) return;

    cloudSyncPaused = true;
    try {
      for (const category of payload.categories || []) {
        const local = state.categories.find(item => item.id === category.id) || {};
        await put("categories", {
          ...local,
          ...category,
          visibility: "public",
          cloudPublic: true
        });
      }

      for (const store of payload.stores || []) {
        const local = state.stores.find(item => item.id === store.id) || {};
        await put("stores", {
          ...local,
          ...store,
          visibility: "public",
          cloudPublic: true
        });
      }

      const seenProductKeys = new Set();

      for (const product of payload.products || []) {
        const normalizedKey = (() => {
          const barcode = String(product.barcode || "").trim();
          if (barcode) return `barcode:${barcode}`;

          return [
            product.name || "",
            product.brand || "",
            product.presentation || ""
          ].map(value =>
            String(value).trim().toLowerCase().replace(/\s+/g, " ")
          ).join("|");
        })();

        if (seenProductKeys.has(normalizedKey)) continue;
        seenProductKeys.add(normalizedKey);

        const localById = state.products.find(item => item.id === product.id);
        const localByIdentity = state.products.find(item => {
          const itemBarcode = String(item.barcode || "").trim();
          if (itemBarcode && product.barcode) {
            return itemBarcode === String(product.barcode).trim();
          }

          const itemKey = [
            item.name || "",
            item.brand || "",
            item.presentation || ""
          ].map(value =>
            String(value).trim().toLowerCase().replace(/\s+/g, " ")
          ).join("|");

          return itemKey === normalizedKey;
        });

        const local = localById || localByIdentity || {};
        const targetId = local.id || product.id;

        await put("products", {
          ...local,
          ...product,
          id: targetId,
          imageData: local.imageData || "",
          visibility: "public",
          cloudPublic: true
        });
      }

      for (const price of payload.verifiedPrices || []) {
        await put("prices", {
          id: `cloud_${price.id}`,
          productId: price.productId,
          storeId: price.storeId,
          price: Number(price.price),
          date: price.date || today(),
          note: price.note || "Precio oficial verificado",
          createdAt: price.createdAt || price.verifiedAt || Date.now(),
          cloudVerified: true,
          visibility: "public",
          source: "verified"
        });
      }

      for (const price of payload.privatePrices || []) {
        await put("prices", {
          ...price,
          cloudPrivate: true,
          visibility: "private",
          source: "private",
          ownerUid: firebaseUser.uid
        });
      }

      for (const item of payload.shoppingItems || []) {
        await put("shoppingItems", {
          ...item,
          visibility: "private",
          ownerUid: firebaseUser.uid
        });
      }

      for (const record of payload.purchaseHistory || []) {
        await put("purchaseHistory", {
          ...record,
          visibility: "private",
          ownerUid: firebaseUser.uid
        });
      }

      for (const list of payload.sharedLists || []) {
        await put("sharedLists", {
          ...list,
          visibility: "private",
          ownerUid: firebaseUser.uid
        });
      }

      state.submissions = payload.submissions || [];
      state.priceChanges = payload.priceChanges || [];

      await loadState();
      renderAll();
      updateAccountUI();
    } finally {
      cloudSyncPaused = false;
    }
  }

  function timestampRepairKey(uid) {
    return `firebaseTimestampRepairV201_${uid}`;
  }

  async function repairFirebaseDatesIfNeeded() {
    if (
      !firebaseBridge?.currentUser ||
      firebaseProfile?.role !== "admin"
    ) {
      return;
    }

    const key = timestampRepairKey(firebaseUser.uid);
    if (state.settings[key]?.completed) return;

    const badge = $("#cloudStatusBadge");
    if (badge) {
      badge.textContent = "Reparando fechas…";
      badge.className = "cloud-status-badge";
    }

    try {
      const result = await firebaseBridge.repairCloudTimestamps();

      cloudSyncPaused = true;
      await put("settings", {
        id: key,
        value: {
          completed: true,
          completedAt: new Date().toISOString(),
          repairedDocuments: result.repairedDocuments
        }
      });
      cloudSyncPaused = false;

      await loadState();
      updateAccountUI();

      if (result.repairedDocuments > 0) {
        toast(
          `Se repararon ${result.repairedDocuments} documentos con fechas incorrectas.`,
          "success"
        );
      }
    } catch (error) {
      cloudSyncPaused = false;
      console.error("No se pudieron reparar las fechas:", error);
      toast(
        "La aplicación funciona, pero no pudo completar la reparación automática de fechas.",
        "error"
      );
    }
  }

  async function refreshCloudCatalog(showToast = true) {
    if (!firebaseBridge?.currentUser) return;

    try {
      $("#cloudStatusBadge").textContent = "Sincronizando…";
      const payload = await firebaseBridge.loadCloudData();
      await mergeCloudData(payload);
      $("#cloudStatusBadge").textContent = "Firebase conectado";
      $("#cloudStatusBadge").className = "cloud-status-badge ready";
      if (showToast) {
        toast("Catálogo y datos personales actualizados.", "success");
      }
    } catch (error) {
      console.error(error);
      $("#cloudStatusBadge").textContent = "Error de sincronización";
      $("#cloudStatusBadge").className = "cloud-status-badge error";
      if (showToast) toast(firebaseErrorMessage(error), "error");
    }
  }

  async function handleAuthenticatedUser({ user, profile, error }) {
    if (error) {
      setAuthMessage(firebaseErrorMessage(error), "error");
      return;
    }

    firebaseUser = user;
    firebaseProfile = profile;

    if (!user) {
      productAliasMap = new Map();
      storeAliasMap = new Map();
      categoryAliasMap = new Map();
      state.prices = [];
      state.shoppingItems = [];
      state.purchaseHistory = [];
      state.sharedLists = [];

      $("#appShell").classList.add("hidden");
      $("#authScreen").classList.remove("hidden");
      setAuthMessage("Inicia sesión para continuar.");
      return;
    }

    $("#authScreen").classList.add("hidden");
    $("#appShell").classList.remove("hidden");
    setAuthMessage("Sesión iniciada.", "success");

    await loadState();
    await scopeLegacyLocalDataForCurrentUser();
    await loadState();
    renderAll();
    updateAccountUI();

    const cloudMigration = await firebaseBridge.getMigrationStatus();

    if (cloudMigration.completed) {
      cloudSyncPaused = true;
      await put("settings", {
        id: migrationKey(user.uid),
        value: {
          completed: true,
          restoredFromCloud: true,
          completedAtCloud: cloudMigration.completedAtCloud,
          counts: cloudMigration.counts || {}
        }
      });
      cloudSyncPaused = false;
      await loadState();
      updateAccountUI();
    }

    await repairFirebaseDatesIfNeeded();
    await refreshCloudCatalog(false);

    const migrated =
      cloudMigration.completed ||
      Boolean(state.settings[migrationKey(user.uid)]);

    if (!migrated && localDataCount() > 0) {
      setTimeout(() => openMigrationModal(), 450);
    }

    if (firebaseProfile?.role === "admin") {
      const audit = await firebaseBridge.auditCloudProductDuplicates();
      state.adminDuplicateAudit = audit;
      renderAdminPanel();
      if (audit.duplicateDocuments > 0) {
        toast(
          `Firebase contiene ${audit.duplicateDocuments} productos duplicados. No se migrará nuevamente; se revisarán en la próxima herramienta administrativa.`,
          "error"
        );
      }
    }
  }

  async function loginWithGoogle() {
    setAuthMessage("Abriendo acceso con Google…");
    try {
      await firebaseBridge.loginGoogle();
    } catch (error) {
      setAuthMessage(firebaseErrorMessage(error), "error");
    }
  }

  async function loginWithEmail(event) {
    event.preventDefault();
    const email = $("#authEmail").value.trim();
    const password = $("#authPassword").value;
    setAuthMessage("Verificando cuenta…");

    try {
      await firebaseBridge.loginEmail(email, password);
    } catch (error) {
      setAuthMessage(firebaseErrorMessage(error), "error");
    }
  }

  async function registerWithEmail() {
    const email = $("#authEmail").value.trim();
    const password = $("#authPassword").value;

    if (!email || password.length < 6) {
      setAuthMessage(
        "Escribe un correo válido y una contraseña de al menos 6 caracteres.",
        "error"
      );
      return;
    }

    setAuthMessage("Creando cuenta…");
    try {
      await firebaseBridge.registerEmail(email, password);
      setAuthMessage("Cuenta creada correctamente.", "success");
    } catch (error) {
      setAuthMessage(firebaseErrorMessage(error), "error");
    }
  }

  async function resetFirebasePassword() {
    const email = $("#authEmail").value.trim();

    if (!email) {
      setAuthMessage(
        "Escribe tu correo para enviar el enlace de recuperación.",
        "error"
      );
      return;
    }

    try {
      await firebaseBridge.resetPassword(email);
      setAuthMessage(
        "Revisa tu correo. Se envió el enlace de recuperación.",
        "success"
      );
    } catch (error) {
      setAuthMessage(firebaseErrorMessage(error), "error");
    }
  }

  async function logoutFirebase() {
    if (!confirm("¿Cerrar sesión en este dispositivo?")) return;
    await firebaseBridge.logout();
  }

  function submissionStatusLabel(status) {
    return {
      pending: "Pendiente",
      approved: "Aprobado",
      rejected: "Rechazado"
    }[status] || status || "Pendiente";
  }

  function submissionStatusClass(status) {
    return ["pending", "approved", "rejected"].includes(status)
      ? status
      : "pending";
  }

  function priceSubmissionFor(price) {
    return [...state.submissions]
      .filter(submission =>
        submission.type === "price" &&
        submission.payload?.priceId === price.id
      )
      .sort((a, b) =>
        Number(b.createdAtCloud || 0) - Number(a.createdAtCloud || 0)
      )[0] || null;
  }

  function renderPriceAlerts() {
    const panel = $("#priceAlertsPanel");
    if (!panel || !firebaseUser) return;

    const seenKey = `seenPriceChanges_${firebaseUser.uid}`;
    const seen = new Set(state.settings[seenKey] || []);
    const unseen = state.priceChanges.filter(change => !seen.has(change.id));

    panel.classList.toggle("hidden", unseen.length === 0);
    $("#priceAlertsDescription").textContent =
      unseen.length === 1
        ? "Tienes un cambio oficial de precio sin revisar."
        : `Tienes ${unseen.length} cambios oficiales de precio sin revisar.`;

    $("#priceAlertsList").innerHTML = unseen.slice(0, 8).map(change => {
      const amount = Number(change.changeAmount || 0);
      const direction = amount > 0 ? "increase" : "decrease";
      const sign = amount > 0 ? "+" : "";
      return `
        <article class="price-change-alert">
          <div>
            <strong>${escapeHTML(change.productName || getProduct(change.productId)?.name || "Producto")}</strong>
            <p>${escapeHTML(change.storeName || getStore(change.storeId)?.name || "Tienda")} ·
              ${money(change.previousPrice)} → ${money(change.currentPrice)}</p>
          </div>
          <div class="price-change-value">
            <strong class="${direction}">${sign}${money(amount)}</strong>
            <span class="${direction}">${sign}${Number(change.changePercent || 0).toFixed(1)}%</span>
          </div>
        </article>`;
    }).join("");
  }

  async function markPriceAlertsSeen() {
    if (!firebaseUser) return;
    const key = `seenPriceChanges_${firebaseUser.uid}`;
    const ids = state.priceChanges.slice(0, 100).map(change => change.id);

    cloudSyncPaused = true;
    await put("settings", { id: key, value: ids });
    cloudSyncPaused = false;
    await loadState();
    renderPriceAlerts();
  }

  function renderUserSubmissions() {
    const container = $("#userSubmissionsList");
    if (!container) return;

    const rows = [...state.submissions]
      .filter(submission =>
        firebaseProfile?.role === "admin" ||
        submission.createdBy === firebaseUser?.uid
      )
      .sort((a, b) =>
        Number(b.createdAtCloud || 0) - Number(a.createdAtCloud || 0)
      );

    container.className = rows.length
      ? "submission-list"
      : "submission-list empty-state";

    container.innerHTML = rows.length
      ? rows.slice(0, 20).map(submission => {
          const payload = submission.payload || {};
          const title = submission.type === "price"
            ? `${payload.productName || "Producto"} · ${payload.storeName || "Tienda"}`
            : payload.name || "Producto propuesto";
          const detail = submission.type === "price"
            ? `${money(payload.price)} · ${localDate(payload.date)}`
            : [payload.brand, payload.presentation].filter(Boolean).join(" · ");

          return `
            <article class="submission-card">
              <div class="submission-card-head">
                <div>
                  <h4>${escapeHTML(title)}</h4>
                  <p>${escapeHTML(detail || (submission.type === "price" ? "Precio" : "Producto"))}</p>
                </div>
                <span class="status-pill ${submissionStatusClass(submission.status)}">
                  ${submissionStatusLabel(submission.status)}
                </span>
              </div>
              ${submission.rejectionReason
                ? `<div class="submission-card-body"><strong>Motivo:</strong>
                    <span>${escapeHTML(submission.rejectionReason)}</span></div>`
                : ""}
            </article>`;
        }).join("")
      : "Todavía no has enviado información.";
  }

  function renderAdminPanel() {
    const adminView = $("#view-admin");
    const adminNav = $("#adminNavBtn");
    const isAdmin = firebaseProfile?.role === "admin";

    adminView?.classList.toggle("hidden", !isAdmin);
    adminNav?.classList.toggle("hidden", !isAdmin);
    if (!isAdmin) return;

    const filter = $("#adminSubmissionFilter")?.value || "pending";
    const pendingProducts = state.submissions.filter(
      submission => submission.status === "pending" && submission.type === "product"
    );
    const pendingPrices = state.submissions.filter(
      submission => submission.status === "pending" && submission.type === "price"
    );
    const reviewed = state.submissions.filter(
      submission => submission.status !== "pending"
    );

    $("#adminPendingProducts").textContent = pendingProducts.length;
    $("#adminPendingPrices").textContent = pendingPrices.length;
    $("#adminReviewedCount").textContent = reviewed.length;
    $("#adminDuplicateCount").textContent =
      state.adminDuplicateAudit?.duplicateDocuments || 0;

    let rows = [...state.submissions];
    if (filter === "pending") rows = rows.filter(row => row.status === "pending");
    if (filter === "product") rows = rows.filter(row => row.type === "product");
    if (filter === "price") rows = rows.filter(row => row.type === "price");

    rows.sort((a, b) =>
      Number(b.createdAtCloud || 0) - Number(a.createdAtCloud || 0)
    );

    const container = $("#adminSubmissionList");
    container.className = rows.length
      ? "submission-list"
      : "submission-list empty-state";

    container.innerHTML = rows.length
      ? rows.map(submission => {
          const payload = submission.payload || {};
          const isPrice = submission.type === "price";
          const title = isPrice
            ? `${payload.productName || "Producto"} · ${payload.storeName || "Tienda"}`
            : payload.name || "Producto nuevo";
          const detail = isPrice
            ? `${money(payload.price)} · ${localDate(payload.date)}`
            : [payload.brand, payload.presentation, payload.barcode]
                .filter(Boolean).join(" · ");

          return `
            <article class="submission-card">
              <div class="submission-card-head">
                <div>
                  <h4>${escapeHTML(title)}</h4>
                  <p>${escapeHTML(detail || "Sin detalles")}<br>
                    Enviado por ${escapeHTML(submission.createdByEmail || submission.createdBy || "Usuario")}</p>
                </div>
                <span class="status-pill ${submissionStatusClass(submission.status)}">
                  ${submissionStatusLabel(submission.status)}
                </span>
              </div>
              ${submission.status === "pending"
                ? `<div class="submission-card-actions">
                    <button class="btn btn-primary btn-sm"
                      data-action="review-submission" data-id="${submission.id}">
                      Revisar
                    </button>
                  </div>`
                : submission.rejectionReason
                  ? `<div class="submission-card-body">
                      <strong>Motivo de rechazo</strong>
                      <span>${escapeHTML(submission.rejectionReason)}</span>
                    </div>`
                  : ""}
            </article>`;
        }).join("")
      : "No hay propuestas que coincidan.";

    const duplicates = state.adminDuplicateAudit?.duplicateDocuments || 0;
    $("#adminDuplicateSummary").textContent = duplicates
      ? `Firestore contiene ${duplicates} documentos duplicados adicionales. Están ocultos visualmente y no afectan el uso actual.`
      : "No se detectaron duplicados remotos.";
  }

  function openAdminReviewModal(submissionId) {
    const submission = state.submissions.find(item => item.id === submissionId);
    if (!submission || submission.status !== "pending") return;

    const payload = submission.payload || {};
    $("#adminReviewSubmissionId").value = submission.id;
    $("#adminReviewType").value = submission.type;
    $("#adminReviewReason").value = "";

    const productFields = $("#adminProductReviewFields");
    const priceFields = $("#adminPriceReviewFields");
    productFields.classList.toggle("hidden", submission.type !== "product");
    priceFields.classList.toggle("hidden", submission.type !== "price");

    if (submission.type === "product") {
      $("#adminReviewTitle").textContent = "Revisar producto";
      $("#adminProductName").value = payload.name || "";
      $("#adminProductBrand").value = payload.brand || "";
      $("#adminProductDescription").value = payload.description || "";
      $("#adminProductPresentation").value = payload.presentation || "";
      $("#adminProductBarcode").value = payload.barcode || "";
      $("#adminProductCategory").innerHTML = optionList(
        [...state.categories].sort((a, b) => a.name.localeCompare(b.name)),
        "Selecciona una categoría",
        payload.categoryId || ""
      );
    } else {
      $("#adminReviewTitle").textContent = "Revisar precio";
      $("#adminPriceProductName").textContent =
        payload.productName || getProduct(payload.productId)?.name || "Producto";
      $("#adminPriceStoreName").textContent =
        payload.storeName || getStore(payload.storeId)?.name || "Tienda";
      $("#adminPriceValue").value = Number(payload.price || 0).toFixed(2);
      $("#adminPriceDate").value = payload.date || today();
      $("#adminPriceNote").value = payload.note || "";
    }

    $("#adminReviewModal").showModal();
  }

  function adminCorrectedPayload() {
    const type = $("#adminReviewType").value;

    if (type === "product") {
      return {
        name: $("#adminProductName").value.trim(),
        brand: $("#adminProductBrand").value.trim(),
        description: $("#adminProductDescription").value.trim(),
        presentation: $("#adminProductPresentation").value.trim(),
        categoryId: $("#adminProductCategory").value,
        barcode: $("#adminProductBarcode").value.trim()
      };
    }

    return {
      price: Number($("#adminPriceValue").value),
      date: $("#adminPriceDate").value,
      note: $("#adminPriceNote").value.trim()
    };
  }

  async function completeSubmissionReview(decision) {
    const submissionId = $("#adminReviewSubmissionId").value;
    const reason = $("#adminReviewReason").value.trim();

    if (decision === "reject" && !reason) {
      toast("Escribe el motivo del rechazo.", "error");
      return;
    }

    const approveButton = $("#approveSubmissionBtn");
    const rejectButton = $("#rejectSubmissionBtn");
    approveButton.disabled = true;
    rejectButton.disabled = true;

    try {
      await firebaseBridge.reviewSubmission(
        submissionId,
        decision,
        adminCorrectedPayload(),
        reason
      );

      closeModal("adminReviewModal");
      await refreshCloudCatalog(false);
      toast(
        decision === "approve"
          ? "Información aprobada y publicada."
          : "Propuesta rechazada.",
        "success"
      );
    } catch (error) {
      toast(firebaseErrorMessage(error), "error");
    } finally {
      approveButton.disabled = false;
      rejectButton.disabled = false;
    }
  }

  async function submitPriceVerification(priceId) {
    const price = state.prices.find(item => item.id === priceId);
    if (!price || price.source === "verified" || price.cloudVerified) return;

    const product = getProduct(price.productId);
    const store = getStore(price.storeId);

    if (!product || !store) {
      toast("No se encontró el producto o la tienda.", "error");
      return;
    }

    try {
      await firebaseBridge.submitPriceForVerification(price, product, store);
      await refreshCloudCatalog(false);
      toast("Precio enviado para verificación.", "success");
    } catch (error) {
      toast(firebaseErrorMessage(error), "error");
    }
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
    renderPriceAlerts();
    renderUserSubmissions();
    renderAdminPanel();
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
      description: $("#productDescription").value.trim(),
      presentation: $("#productPresentation").value.trim(),
      categoryId: $("#productCategory").value,
      barcode: $("#productBarcode").value.trim(),
      imageData,
      createdAt: state.products.find((x) => x.id === id)?.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    const normalizedProduct = [
      product.name,
      product.brand,
      product.presentation
    ].map((value) =>
      String(value || "").trim().toLowerCase().replace(/\s+/g, " ")
    ).join("|");

    const duplicate = state.products.find((candidate) => {
      if (candidate.id === id) return false;

      const barcodeMatch =
        product.barcode &&
        String(candidate.barcode || "").trim() === product.barcode;

      const normalizedCandidate = [
        candidate.name,
        candidate.brand,
        candidate.presentation
      ].map((value) =>
        String(value || "").trim().toLowerCase().replace(/\s+/g, " ")
      ).join("|");

      return barcodeMatch || normalizedCandidate === normalizedProduct;
    });

    if (duplicate) {
      toast(`Ese producto ya existe: ${duplicate.name}.`, "error");
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
      $("#productDescription").value = p.description || "";
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

    if (action === "submit-price-verification") {
      await submitPriceVerification(id);
    }

    if (action === "review-submission") {
      openAdminReviewModal(id);
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
        if(!p){p={id:uid("product"),name:row.name,brand:row.brand||"",description:row.description||"",presentation:row.presentation||"",categoryId:state.categories.find(c=>c.name===row.category)?.id||state.categories[0]?.id||"",barcode:"",imageData:"",createdAt:Date.now(),updatedAt:Date.now()};await put("products",p);}
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

  async function registerServiceWorker() {
    if ("serviceWorker" in navigator && isSecureAppOrigin()) {
      try {
        return await navigator.serviceWorker.register("sw.js");
      } catch {
        toast("No se pudo activar el modo sin conexión.", "error");
      }
    }
    return null;
  }

  function bindEvents() {
    $("#googleLoginBtn").addEventListener("click", loginWithGoogle);
    $("#authForm").addEventListener("submit", loginWithEmail);
    $("#emailRegisterBtn").addEventListener("click", registerWithEmail);
    $("#resetPasswordBtn").addEventListener("click", resetFirebasePassword);
    $("#logoutBtn").addEventListener("click", logoutFirebase);
    $("#startMigrationBtn").addEventListener("click", startFirebaseMigration);
    $("#openMigrationBtn").addEventListener("click", () => openMigrationModal(true));
    $("#refreshCloudBtn").addEventListener("click", () => refreshCloudCatalog(true));
    $("#refreshSubmissionsBtn").addEventListener("click", () => refreshCloudCatalog(true));
    $("#refreshAdminBtn").addEventListener("click", () => refreshCloudCatalog(true));
    $("#adminSubmissionFilter").addEventListener("change", renderAdminPanel);
    $("#approveSubmissionBtn").addEventListener("click", () => completeSubmissionReview("approve"));
    $("#rejectSubmissionBtn").addEventListener("click", () => completeSubmissionReview("reject"));
    $("#markAlertsSeenBtn").addEventListener("click", markPriceAlertsSeen);

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
    $("#sharedListInput").addEventListener("change", event => {
      const file = event.target.files[0];
      if (file) importSharedList(file);
      event.target.value = "";
    });
    $("#saveReceivedListBtn").addEventListener("click", () => savePendingReceivedPackage("save"));
    $("#mergeReceivedListBtn").addEventListener("click", () => savePendingReceivedPackage("merge"));


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

      cloudSyncPaused = true;
      await seedDefaults();
      cloudSyncPaused = false;

      bindEvents();
      renderAll();
      updateConnectionStatus();
      await registerServiceWorker();
      configureFileLaunchReception();
      await consumeSharedTargetPayload();
      $("#priceDate").value = today();

      setAuthMessage("Conectando con Firebase…");
      firebaseBridge = await waitForFirebaseBridge();
      firebaseBridge.onAuthChange(handleAuthenticatedUser);
    } catch (error) {
      console.error(error);
      setAuthMessage(firebaseErrorMessage(error), "error");
      $("#connectionStatus").textContent = "Error de inicio";
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
