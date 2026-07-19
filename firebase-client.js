import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAIL, APP_VERSION } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
auth.useDeviceLanguage();

try {
  await setPersistence(auth, browserLocalPersistence);
} catch (error) {
  console.warn("No se pudo activar persistencia de sesión:", error);
}

const cloudDb = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

let currentProfile = null;
const authSubscribers = new Set();

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);

  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);

    // Firestore FieldValue, Timestamp, Date y otros objetos especiales
    // deben conservarse intactos. Convertirlos a objetos planos provoca
    // que serverTimestamp() se guarde como {_methodName: "serverTimestamp"}.
    if (
      value._methodName ||
      value instanceof Date ||
      (prototype && prototype !== Object.prototype)
    ) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)])
    );
  }

  return value;
}

function publicProduct(product) {
  const { imageData, ...rest } = product || {};
  return withoutUndefined({
    ...rest,
    name: clean(rest.name, 100),
    brand: clean(rest.brand, 80),
    description: clean(rest.description, 500),
    presentation: clean(rest.presentation, 80),
    barcode: clean(rest.barcode, 30),
    imageType: imageData ? "local-only" : "none",
    updatedAtCloud: serverTimestamp()
  });
}

function publicPrice(price) {
  return withoutUndefined({
    id: price.id,
    productId: price.productId,
    storeId: price.storeId,
    price: Number(price.price),
    date: clean(price.date, 20),
    note: clean(price.note, 300),
    createdAt: Number(price.createdAt || Date.now())
  });
}

function normalizeSnapshot(snapshot) {
  return snapshot.docs.map(item => {
    const data = item.data();
    return {
      id: item.id,
      ...data,
      createdAtCloud: data.createdAtCloud?.toMillis?.() || data.createdAtCloud || null,
      updatedAtCloud: data.updatedAtCloud?.toMillis?.() || data.updatedAtCloud || null,
      verifiedAt: data.verifiedAt?.toMillis?.() || data.verifiedAt || null
    };
  });
}

async function ensureProfile(user) {
  if (!user) return null;

  const ref = doc(cloudDb, "users", user.uid);
  const snapshot = await getDoc(ref);
  const isInitialAdmin = user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  if (!snapshot.exists()) {
    const profile = {
      uid: user.uid,
      email: user.email || "",
      displayName: user.displayName || user.email?.split("@")[0] || "Usuario",
      role: isInitialAdmin ? "admin" : "user",
      active: true,
      createdAtCloud: serverTimestamp(),
      updatedAtCloud: serverTimestamp(),
      appVersion: APP_VERSION
    };
    await setDoc(ref, profile);
    currentProfile = {
      ...profile,
      createdAtCloud: Date.now(),
      updatedAtCloud: Date.now()
    };
  } else {
    currentProfile = { id: snapshot.id, ...snapshot.data() };
    await setDoc(ref, {
      email: user.email || "",
      displayName: user.displayName || currentProfile.displayName || "",
      updatedAtCloud: serverTimestamp(),
      appVersion: APP_VERSION
    }, { merge: true });
  }

  return currentProfile;
}

async function notifyAuthSubscribers(user) {
  try {
    const profile = user ? await ensureProfile(user) : null;
    for (const subscriber of authSubscribers) {
      await subscriber({ user, profile });
    }
  } catch (error) {
    console.error("Error preparando perfil:", error);
    for (const subscriber of authSubscribers) {
      await subscriber({ user, profile: null, error });
    }
  }
}

onAuthStateChanged(auth, notifyAuthSubscribers);

async function chunkedSet(operations, chunkSize = 350) {
  for (let index = 0; index < operations.length; index += chunkSize) {
    const batch = writeBatch(cloudDb);
    for (const operation of operations.slice(index, index + chunkSize)) {
      batch.set(
        operation.ref,
        withoutUndefined(operation.data),
        operation.options || {}
      );
    }
    await batch.commit();
  }
}

async function migrateLocalData(snapshot) {
  const user = auth.currentUser;
  if (!user) throw new Error("Debes iniciar sesión antes de migrar.");

  const profile = currentProfile || await ensureProfile(user);
  const isAdmin = profile?.role === "admin";
  const operations = [];
  const latestPrices = new Map();

  for (const category of snapshot.categories || []) {
    if (!isAdmin) continue;
    operations.push({
      ref: doc(cloudDb, "categories", category.id),
      data: {
        ...category,
        name: clean(category.name, 80),
        updatedAtCloud: serverTimestamp()
      },
      options: { merge: true }
    });
  }

  for (const store of snapshot.stores || []) {
    if (!isAdmin) continue;
    operations.push({
      ref: doc(cloudDb, "stores", store.id),
      data: {
        ...store,
        name: clean(store.name, 100),
        updatedAtCloud: serverTimestamp()
      },
      options: { merge: true }
    });
  }

  for (const product of snapshot.products || []) {
    if (isAdmin) {
      operations.push({
        ref: doc(cloudDb, "products", product.id),
        data: {
          ...publicProduct(product),
          status: "approved",
          verifiedBy: user.uid,
          verifiedAt: serverTimestamp()
        },
        options: { merge: true }
      });
    } else {
      operations.push({
        ref: doc(
          cloudDb,
          "submissions",
          `migration_product_${user.uid}_${product.id}`
        ),
        data: {
          type: "product",
          status: "pending",
          createdBy: user.uid,
          createdByEmail: user.email || "",
          payload: publicProduct(product),
          createdAtCloud: serverTimestamp()
        },
        options: { merge: true }
      });
    }
  }

  for (const price of snapshot.prices || []) {
    const priceData = publicPrice(price);

    operations.push({
      ref: doc(cloudDb, "users", user.uid, "privatePrices", price.id),
      data: {
        ...priceData,
        ownerUid: user.uid,
        updatedAtCloud: serverTimestamp()
      },
      options: { merge: true }
    });

    const key = `${price.productId}__${price.storeId}`;
    const previous = latestPrices.get(key);
    const currentOrder = `${price.date || ""}_${price.createdAt || 0}`;
    const previousOrder = previous
      ? `${previous.date || ""}_${previous.createdAt || 0}`
      : "";

    if (!previous || currentOrder >= previousOrder) {
      latestPrices.set(key, priceData);
    }

    if (isAdmin) {
      operations.push({
        ref: doc(cloudDb, "priceHistory", price.id),
        data: {
          ...priceData,
          verifiedBy: user.uid,
          verifiedAt: serverTimestamp(),
          source: "admin-migration"
        },
        options: { merge: true }
      });
    }
  }

  if (isAdmin) {
    for (const [key, price] of latestPrices.entries()) {
      operations.push({
        ref: doc(cloudDb, "verifiedPrices", key),
        data: {
          ...price,
          id: key,
          status: "verified",
          verifiedBy: user.uid,
          verifiedAt: serverTimestamp(),
          updatedAtCloud: serverTimestamp()
        },
        options: { merge: true }
      });
    }
  }

  for (const item of snapshot.shoppingItems || []) {
    operations.push({
      ref: doc(cloudDb, "users", user.uid, "shoppingItems", item.id),
      data: {
        ...item,
        ownerUid: user.uid,
        updatedAtCloud: serverTimestamp()
      },
      options: { merge: true }
    });
  }

  for (const record of snapshot.purchaseHistory || []) {
    operations.push({
      ref: doc(cloudDb, "users", user.uid, "purchaseHistory", record.id),
      data: {
        ...record,
        ownerUid: user.uid,
        updatedAtCloud: serverTimestamp()
      },
      options: { merge: true }
    });
  }

  for (const shared of snapshot.sharedLists || []) {
    operations.push({
      ref: doc(cloudDb, "users", user.uid, "sharedLists", shared.id),
      data: {
        ...shared,
        ownerUid: user.uid,
        updatedAtCloud: serverTimestamp()
      },
      options: { merge: true }
    });
  }

  operations.push({
    ref: doc(cloudDb, "users", user.uid, "migration", "v2"),
    data: {
      completed: true,
      completedAtCloud: serverTimestamp(),
      sourceVersion: "1.7",
      targetVersion: APP_VERSION,
      counts: {
        products: snapshot.products?.length || 0,
        stores: snapshot.stores?.length || 0,
        categories: snapshot.categories?.length || 0,
        prices: snapshot.prices?.length || 0,
        shoppingItems: snapshot.shoppingItems?.length || 0,
        purchaseHistory: snapshot.purchaseHistory?.length || 0
      },
      localImagesExcluded: true,
      adminMigration: isAdmin
    },
    options: { merge: true }
  });

  await chunkedSet(operations);

  return {
    role: profile?.role || "user",
    operations: operations.length,
    counts: {
      products: snapshot.products?.length || 0,
      stores: snapshot.stores?.length || 0,
      categories: snapshot.categories?.length || 0,
      prices: snapshot.prices?.length || 0,
      shoppingItems: snapshot.shoppingItems?.length || 0,
      purchaseHistory: snapshot.purchaseHistory?.length || 0
    }
  };
}


function isBrokenServerTimestamp(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value._methodName === "serverTimestamp"
  );
}

function collectTimestampRepairs(snapshot, fields, operations) {
  for (const documentSnapshot of snapshot.docs) {
    const data = documentSnapshot.data();
    const patch = {};

    for (const field of fields) {
      if (isBrokenServerTimestamp(data[field])) {
        patch[field] = serverTimestamp();
      }
    }

    if (Object.keys(patch).length) {
      operations.push({
        ref: documentSnapshot.ref,
        data: patch,
        options: { merge: true }
      });
    }
  }
}

async function repairCloudTimestamps() {
  const user = auth.currentUser;
  if (!user) throw new Error("Debes iniciar sesión para reparar las fechas.");

  const profile = currentProfile || await ensureProfile(user);
  if (profile?.role !== "admin") {
    return { repairedDocuments: 0, skipped: true };
  }

  const operations = [];

  const collectionsToRepair = [
    {
      reference: collection(cloudDb, "categories"),
      fields: ["createdAtCloud", "updatedAtCloud"]
    },
    {
      reference: collection(cloudDb, "stores"),
      fields: ["createdAtCloud", "updatedAtCloud"]
    },
    {
      reference: collection(cloudDb, "products"),
      fields: ["createdAtCloud", "updatedAtCloud", "verifiedAt"]
    },
    {
      reference: collection(cloudDb, "verifiedPrices"),
      fields: ["createdAtCloud", "updatedAtCloud", "verifiedAt"]
    },
    {
      reference: collection(cloudDb, "priceHistory"),
      fields: ["createdAtCloud", "updatedAtCloud", "verifiedAt"]
    },
    {
      reference: collection(cloudDb, "submissions"),
      fields: ["createdAtCloud", "updatedAtCloud", "reviewedAt"]
    },
    {
      reference: collection(cloudDb, "users"),
      fields: ["createdAtCloud", "updatedAtCloud"]
    },
    {
      reference: collection(cloudDb, "users", user.uid, "privatePrices"),
      fields: ["createdAtCloud", "updatedAtCloud", "verifiedAt"]
    },
    {
      reference: collection(cloudDb, "users", user.uid, "shoppingItems"),
      fields: ["createdAtCloud", "updatedAtCloud"]
    },
    {
      reference: collection(cloudDb, "users", user.uid, "purchaseHistory"),
      fields: ["createdAtCloud", "updatedAtCloud", "finishedAtCloud"]
    },
    {
      reference: collection(cloudDb, "users", user.uid, "sharedLists"),
      fields: ["createdAtCloud", "updatedAtCloud", "importedAtCloud"]
    }
  ];

  for (const descriptor of collectionsToRepair) {
    const snapshot = await getDocs(descriptor.reference);
    collectTimestampRepairs(snapshot, descriptor.fields, operations);
  }

  const migrationRef = doc(cloudDb, "users", user.uid, "migration", "v2");
  const migrationSnapshot = await getDoc(migrationRef);

  if (migrationSnapshot.exists()) {
    const migrationData = migrationSnapshot.data();
    const migrationPatch = {};

    for (const field of ["completedAtCloud", "updatedAtCloud"]) {
      if (isBrokenServerTimestamp(migrationData[field])) {
        migrationPatch[field] = serverTimestamp();
      }
    }

    if (Object.keys(migrationPatch).length) {
      operations.push({
        ref: migrationRef,
        data: migrationPatch,
        options: { merge: true }
      });
    }
  }

  if (operations.length) {
    await chunkedSet(operations);
  }

  await setDoc(
    doc(cloudDb, "users", user.uid, "maintenance", "timestampRepairV201"),
    {
      completed: true,
      repairedDocuments: operations.length,
      completedAtCloud: serverTimestamp(),
      appVersion: APP_VERSION
    },
    { merge: true }
  );

  return {
    repairedDocuments: operations.length,
    skipped: false
  };
}

async function loadCloudData() {
  const user = auth.currentUser;
  if (!user) return null;

  const [
    products,
    stores,
    categories,
    verifiedPrices,
    shoppingItems,
    purchaseHistory,
    privatePrices,
    sharedLists
  ] = await Promise.all([
    getDocs(collection(cloudDb, "products")),
    getDocs(collection(cloudDb, "stores")),
    getDocs(collection(cloudDb, "categories")),
    getDocs(collection(cloudDb, "verifiedPrices")),
    getDocs(collection(cloudDb, "users", user.uid, "shoppingItems")),
    getDocs(collection(cloudDb, "users", user.uid, "purchaseHistory")),
    getDocs(collection(cloudDb, "users", user.uid, "privatePrices")),
    getDocs(collection(cloudDb, "users", user.uid, "sharedLists"))
  ]);

  return {
    products: normalizeSnapshot(products),
    stores: normalizeSnapshot(stores),
    categories: normalizeSnapshot(categories),
    verifiedPrices: normalizeSnapshot(verifiedPrices),
    shoppingItems: normalizeSnapshot(shoppingItems),
    purchaseHistory: normalizeSnapshot(purchaseHistory),
    privatePrices: normalizeSnapshot(privatePrices),
    sharedLists: normalizeSnapshot(sharedLists)
  };
}

async function mirrorPut(storeName, value) {
  const user = auth.currentUser;
  if (!user || !value?.id) return;

  const profile = currentProfile || await ensureProfile(user);
  const isAdmin = profile?.role === "admin";

  if (storeName === "shoppingItems") {
    return setDoc(
      doc(cloudDb, "users", user.uid, "shoppingItems", value.id),
      { ...value, ownerUid: user.uid, updatedAtCloud: serverTimestamp() },
      { merge: true }
    );
  }

  if (storeName === "purchaseHistory") {
    return setDoc(
      doc(cloudDb, "users", user.uid, "purchaseHistory", value.id),
      { ...value, ownerUid: user.uid, updatedAtCloud: serverTimestamp() },
      { merge: true }
    );
  }

  if (storeName === "sharedLists") {
    return setDoc(
      doc(cloudDb, "users", user.uid, "sharedLists", value.id),
      { ...value, ownerUid: user.uid, updatedAtCloud: serverTimestamp() },
      { merge: true }
    );
  }

  if (storeName === "prices") {
    await setDoc(
      doc(cloudDb, "users", user.uid, "privatePrices", value.id),
      {
        ...publicPrice(value),
        ownerUid: user.uid,
        updatedAtCloud: serverTimestamp()
      },
      { merge: true }
    );

    if (isAdmin) {
      const key = `${value.productId}__${value.storeId}`;
      await setDoc(
        doc(cloudDb, "verifiedPrices", key),
        {
          ...publicPrice(value),
          id: key,
          status: "verified",
          verifiedBy: user.uid,
          verifiedAt: serverTimestamp(),
          updatedAtCloud: serverTimestamp()
        },
        { merge: true }
      );
    }
    return;
  }

  if (storeName === "products") {
    if (isAdmin) {
      return setDoc(
        doc(cloudDb, "products", value.id),
        {
          ...publicProduct(value),
          status: "approved",
          verifiedBy: user.uid,
          verifiedAt: serverTimestamp()
        },
        { merge: true }
      );
    }

    return setDoc(
      doc(cloudDb, "submissions", `product_${user.uid}_${value.id}`),
      {
        type: "product",
        status: "pending",
        createdBy: user.uid,
        createdByEmail: user.email || "",
        payload: publicProduct(value),
        createdAtCloud: serverTimestamp(),
        updatedAtCloud: serverTimestamp()
      },
      { merge: true }
    );
  }

  if ((storeName === "stores" || storeName === "categories") && isAdmin) {
    return setDoc(
      doc(cloudDb, storeName, value.id),
      {
        ...value,
        name: clean(value.name, 100),
        updatedAtCloud: serverTimestamp()
      },
      { merge: true }
    );
  }
}

async function mirrorDelete(storeName, id) {
  const user = auth.currentUser;
  if (!user || !id) return;

  if (["shoppingItems", "purchaseHistory", "sharedLists"].includes(storeName)) {
    return deleteDoc(doc(cloudDb, "users", user.uid, storeName, id));
  }

  if (storeName === "prices") {
    return deleteDoc(doc(cloudDb, "users", user.uid, "privatePrices", id));
  }

  // Eliminar localmente un producto no borra el catálogo comunitario.
}

window.MCIFirebase = {
  config: firebaseConfig,
  adminEmail: ADMIN_EMAIL,
  version: APP_VERSION,

  get currentUser() {
    return auth.currentUser;
  },

  get currentProfile() {
    return currentProfile;
  },

  onAuthChange(callback) {
    authSubscribers.add(callback);

    if (auth.currentUser) {
      ensureProfile(auth.currentUser)
        .then(profile => callback({ user: auth.currentUser, profile }))
        .catch(error => callback({ user: auth.currentUser, profile: null, error }));
    } else {
      callback({ user: null, profile: null });
    }

    return () => authSubscribers.delete(callback);
  },

  loginGoogle() {
    return signInWithPopup(auth, googleProvider);
  },

  loginEmail(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
  },

  registerEmail(email, password) {
    return createUserWithEmailAndPassword(auth, email, password);
  },

  resetPassword(email) {
    return sendPasswordResetEmail(auth, email);
  },

  async logout() {
    currentProfile = null;
    return signOut(auth);
  },

  ensureProfile,
  migrateLocalData,
  repairCloudTimestamps,
  loadCloudData,
  mirrorPut,
  mirrorDelete
};

window.dispatchEvent(new CustomEvent("mci-firebase-ready"));
