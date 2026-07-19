const CACHE_NAME = "mi-compra-inteligente-v2-0-1-fechas";
const SHARE_INBOX_CACHE = "mi-compra-inteligente-share-inbox-v1";

const APP_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-client.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png"
];

function inboxRequest() {
  return new Request(new URL("./__share_inbox__", self.registration.scope).href);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== SHARE_INBOX_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (
    event.request.method === "POST" &&
    url.pathname.endsWith("/share-target")
  ) {
    event.respondWith((async () => {
      try {
        const formData = await event.request.formData();
        const sharedFile = formData.get("shared_list");

        if (!(sharedFile instanceof File)) {
          throw new Error("No se recibió un archivo compatible.");
        }

        const text = await sharedFile.text();
        JSON.parse(text);

        const inbox = await caches.open(SHARE_INBOX_CACHE);
        await inbox.put(
          inboxRequest(),
          new Response(text, {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store"
            }
          })
        );

        return Response.redirect(
          new URL("./index.html?receivedShare=1", self.registration.scope).href,
          303
        );
      } catch {
        return Response.redirect(
          new URL("./index.html?receivedShare=error", self.registration.scope).href,
          303
        );
      }
    })());
    return;
  }

  if (
    event.request.method === "GET" &&
    url.pathname.endsWith("/__share_inbox__")
  ) {
    event.respondWith((async () => {
      const inbox = await caches.open(SHARE_INBOX_CACHE);
      const cached = await inbox.match(inboxRequest());

      if (!cached) {
        return new Response(
          JSON.stringify({ error: "No hay un paquete pendiente." }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      const response = cached.clone();
      await inbox.delete(inboxRequest());
      return response;
    })());
    return;
  }

  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (
            response &&
            response.status === 200 &&
            response.type === "basic"
          ) {
            const clone = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached || caches.match("./index.html"));

      return cached || network;
    })
  );
});
