# Mi Compra Inteligente v2.0.1

Corrección de mantenimiento para los campos de fecha de Firebase.

## Cambios

- Conserva correctamente `serverTimestamp()` y los objetos especiales de Firestore.
- Detecta documentos migrados donde la fecha quedó como un mapa `_methodName`.
- Repara automáticamente categorías, tiendas, productos, precios, usuario y subcolecciones privadas.
- Registra el mantenimiento en `users/{uid}/maintenance/timestampRepairV201`.
- Ejecuta la reparación una sola vez por dispositivo.
- No repite la migración ni modifica fotografías locales.

La siguiente fase funcional continúa siendo la v2.1 administrativa.
