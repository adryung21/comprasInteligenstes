(() => {
  "use strict";

  const DB_NAME = "mi-compra-inteligente-db";
  const DB_VERSION = 1;
  const STORE_NAMES = ["products", "stores", "categories", "prices", "shoppingItems", "settings"];

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
    const [products, stores, categories, prices, shoppingItems, settingsRows] =
      await Promise.all(STORE_NAMES.map(getAll));

    state.products = products;
    state.stores = stores;
    state.categories = categories;
    state.prices = prices;
    state.shoppingItems = shoppingItems;
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
    const all = [...state.shoppingItems].sort((a, b) => Number(a.completed) - Number(b.completed) || Number(b.createdAt || 0) - Number(a.createdAt || 0));
    const visible = showCompleted ? all : all.filter((x) => !x.completed);
    const pending = all.filter((x) => !x.completed);

    $("#shoppingPendingCount").textContent = pending.length;
    let total = 0;
    pending.forEach((item) => {
      const best = getBestPrice(item.productId);
      if (best) total += Number(best.price) * Number(item.quantity);
    });
    $("#shoppingBestTotal").textContent = money(total);

    const container = $("#shoppingList");
    container.className = visible.length ? "shopping-list" : "shopping-list empty-state";
    container.innerHTML = visible.length ? visible.map((item) => {
      const product = getProduct(item.productId);
      const best = product ? getBestPrice(product.id) : null;
      return `<article class="shopping-item ${item.completed ? "completed" : ""}">
        <button class="check-btn" data-action="toggle-shopping" data-id="${item.id}" aria-label="${item.completed ? "Restaurar" : "Marcar comprado"}">${item.completed ? "✓" : ""}</button>
        <div>
          <h4>${escapeHTML(product?.name || "Producto eliminado")}</h4>
          <p>Cantidad: ${item.quantity} · ${best ? `${money(Number(best.price) * Number(item.quantity))} en ${escapeHTML(getStore(best.storeId)?.name || "—")}` : "Sin precio registrado"}</p>
        </div>
        <div class="inline-actions">
          <button class="btn btn-secondary btn-sm" data-action="change-quantity" data-id="${item.id}">Cantidad</button>
          <button class="btn btn-danger btn-sm" data-action="delete-shopping" data-id="${item.id}">Borrar</button>
        </div>
      </article>`;
    }).join("") : (showCompleted ? "Tu lista está vacía." : "No hay artículos pendientes.");

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
  }

  function renderAll() {
    refreshSelects();
    renderDashboard();
    renderProducts();
    renderPrices();
    renderCompare();
    renderShopping();
    renderSettings();
  }

  function openModal(id) {
    if (id === "priceModal") {
      if (!state.products.length || !state.stores.length) {
        toast("Primero debes tener al menos un producto y una tienda.", "error");
        return;
      }
      $("#priceDate").value = today();
      $("#priceForm").reset();
      $("#priceDate").value = today();
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
    const price = {
      id: uid("price"),
      productId: $("#priceProduct").value,
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
    toast("Precio registrado.", "success");
  }

  async function handleShoppingSubmit(event) {
    event.preventDefault();
    const productId = $("#shoppingProduct").value;
    const existing = state.shoppingItems.find((x) => x.productId === productId && !x.completed);
    if (existing) {
      existing.quantity = Number(existing.quantity) + Number($("#shoppingQuantity").value);
      existing.updatedAt = Date.now();
      await put("shoppingItems", existing);
    } else {
      await put("shoppingItems", {
        id: uid("shopping"),
        productId,
        quantity: Number($("#shoppingQuantity").value),
        completed: false,
        createdAt: Date.now()
      });
    }
    await loadState();
    renderAll();
    closeModal("shoppingModal");
    toast("Artículo añadido a la lista.", "success");
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
      openModal("priceModal");
      $("#priceProduct").value = id;
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

  function inferCategory(text) {
    const t = text.toLowerCase();
    const rules = [
      ["Bebidas", ["agua","jugo","bebida","gaseosa","leche","café","cafe","té","te","refresco"]],
      ["Limpieza", ["detergente","cloro","desinfectante","lavavajilla","suavizante","limpiador"]],
      ["Higiene personal", ["shampoo","champú","jabon","jabón","crema dental","desodorante","pañal","toalla sanitaria"]],
      ["Medicamentos", ["tabletas","capsulas","cápsulas","jarabe","ibuprofeno","paracetamol"]],
      ["Mascotas", ["perro","gato","mascota","croquetas"]],
      ["Hogar", ["papel aluminio","servilleta","bolsa","foco","esponja"]],
      ["Alimentos", ["arroz","azucar","azúcar","sal","harina","aceite","galleta","cereal","yogur","atún","atun","pasta","salsa"]]
    ];
    return rules.find(([, words]) => words.some(w => t.includes(w)))?.[0] || "Otros";
  }

  function extractProductData(ocr) {
    const rawText = String(ocr.text || "").replace(/\r/g, "");
    const sourceLines = ocr.lines?.length
      ? ocr.lines.map(x => ({text:x.text, confidence:x.confidence || 0}))
      : rawText.split("\n").map(text => ({text, confidence:50}));
    const noise = /(informaci[oó]n|nutricional|ingredientes|contenido neto|elaborado|registro sanitario|lote|vence|conservar|distribuido|servicio al cliente|c[oó]digo|www\.|precio|calor[ií]as)/i;
    const candidates = sourceLines
      .map((x,index) => ({...x,index,text:x.text.replace(/[|_~]/g," ").replace(/\s+/g," ").trim()}))
      .filter(x => {
        const letters = (x.text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g)||[]).length;
        return x.text.length >= 3 && x.text.length <= 70 && letters >= 3 &&
          !noise.test(x.text) && !/^\d[\d\s.,%-]*$/.test(x.text);
      })
      .map(x => {
        const words = x.text.split(" ").length;
        const letters = (x.text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g)||[]).length;
        const upper = (x.text.match(/[A-ZÁÉÍÓÚÜÑ]/g)||[]).length / Math.max(1, letters);
        let score = x.confidence + Math.max(0,35-x.index*3) + upper*18;
        if (words >= 2 && words <= 6) score += 18;
        if (x.text.length >= 5 && x.text.length <= 40) score += 12;
        return {...x,score};
      }).sort((a,b)=>b.score-a.score);

    const presentation = rawText.match(/\b\d+(?:[.,]\d+)?\s?(?:kg|g|gr|mg|l|lt|ml|cc|oz|unidades?|und)\b/i)?.[0] || "";
    const barcode = rawText.replace(/\s/g,"").match(/\b\d{8,14}\b/)?.[0] || "";
    const first = candidates[0]?.text || "";
    const second = candidates.find(x => x.text !== first)?.text || "";
    let brand = "";
    let name = first;
    if (first && second && first.split(" ").length <= 2 && first.length <= 22) {
      brand = first;
      name = second;
    }
    name = name.replace(/\b\d+(?:[.,]\d+)?\s?(?:kg|g|gr|mg|l|lt|ml|cc|oz)\b/ig,"").trim();
    return {name,brand,presentation,category:inferCategory(rawText),barcode,rawText};
  }

  async function runLocalOCR(imageData) {
    if (!window.Tesseract) throw new Error("No se pudo cargar el motor OCR. Verifica la conexión.");
    const worker = await Tesseract.createWorker("spa+eng", 1, {
      logger: m => {
        const labels = {
          "loading tesseract core":"Cargando motor OCR",
          "initializing tesseract":"Inicializando OCR",
          "loading language traineddata":"Descargando idioma",
          "initializing api":"Preparando reconocimiento",
          "recognizing text":"Leyendo texto de la etiqueta"
        };
        setOCRProgress(labels[m.status] || "Analizando imagen", Number(m.progress || 0));
      }
    });
    try {
      return (await worker.recognize(imageData)).data;
    } finally {
      await worker.terminate();
    }
  }

  function renderOCRResult(result) {
    const categories = [...state.categories].sort((a,b)=>a.name.localeCompare(b.name));
    const selected = categories.find(c => c.name.toLowerCase() === String(result.category||"").toLowerCase())?.id || "";
    $("#scanResult").className = "scan-result";
    $("#scanResult").innerHTML = `
      <div class="ocr-fields">
        <label>Nombre del producto detectado *
          <input id="ocrName" value="${escapeHTML(result.name || "")}" placeholder="Corrige o escribe el nombre">
        </label>
        <label>Marca
          <input id="ocrBrand" value="${escapeHTML(result.brand || "")}" placeholder="Marca detectada">
        </label>
        <label>Presentación
          <input id="ocrPresentation" value="${escapeHTML(result.presentation || "")}" placeholder="Ej. 500 g">
        </label>
        <label>Categoría
          <select id="ocrCategory">${optionList(categories,"Selecciona una categoría",selected)}</select>
        </label>
        <label>Código de barras
          <input id="ocrBarcode" value="${escapeHTML(result.barcode || "")}" inputmode="numeric">
        </label>
      </div>
      <details class="ocr-raw"><summary>Ver texto completo detectado</summary><pre>${escapeHTML(result.rawText || "No se detectó texto.")}</pre></details>`;
  }

  async function analyzeImage() {
    if (!capturedImageData) return;
    $("#analyzeBtn").disabled = true;
    $("#createFromScanBtn").classList.add("hidden");
    $("#scanResult").className = "scan-result";
    $("#scanResult").textContent = "Preparando reconocimiento de texto…";
    setOCRProgress("Preparando OCR",0);
    try {
      const barcode = await detectBarcode(capturedImageData);
      const known = barcode && state.products.find(p => p.barcode === barcode);
      if (known) {
        scanData = {name:known.name,brand:known.brand||"",presentation:known.presentation||"",
          category:getCategory(known.categoryId)?.name||"",barcode,existingProductId:known.id,
          rawText:"Producto identificado por código de barras.",imageData:capturedImageData};
      } else {
        const extracted = extractProductData(await runLocalOCR(capturedImageData));
        scanData = {...extracted,barcode:barcode||extracted.barcode,imageData:capturedImageData};
      }
      const endpoint = state.settings.aiEndpoint;
      if (endpoint && navigator.onLine && !scanData.existingProductId) {
        try {
          const response = await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({image:capturedImageData,ocrText:scanData.rawText})});
          if (response.ok) {
            const ai = await response.json();
            scanData = {...scanData,name:ai.name||scanData.name,brand:ai.brand||scanData.brand,
              presentation:ai.presentation||scanData.presentation,category:ai.category||scanData.category,
              barcode:ai.barcode||scanData.barcode};
          }
        } catch {}
      }
      setOCRProgress("Análisis completado",1);
      renderOCRResult(scanData);
      $("#createFromScanBtn").textContent = scanData.existingProductId ? "Registrar precio para este producto" : "Crear producto nuevo";
      $("#createFromScanBtn").dataset.mode = scanData.existingProductId ? "price" : "product";
      $("#createFromScanBtn").classList.remove("hidden");
    } catch (error) {
      $("#scanResult").innerHTML = `<div class="notice"><strong>No se pudo completar el OCR.</strong><br>${escapeHTML(error.message || "Intenta con una foto más cercana y bien iluminada.")}</div>`;
      toast("No se pudo leer el texto de la imagen.","error");
    } finally {
      $("#analyzeBtn").disabled = false;
      setTimeout(()=>$("#ocrProgressWrap").classList.add("hidden"),1300);
    }
  }

  function createFromScan() {
    if (!scanData) return;
    if ($("#createFromScanBtn").dataset.mode === "price" && scanData.existingProductId) {
      openModal("priceModal");
      $("#priceProduct").value = scanData.existingProductId;
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
    await put("settings", { id: "aiEndpoint", value: $("#aiEndpoint").value.trim() });
    await loadState();
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
