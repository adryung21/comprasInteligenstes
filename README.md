# Mi Compra Inteligente v2.0.2

Corrección de estabilidad antes del panel administrativo.

## Cambios

- Firestore se convierte en fuente de verdad para el estado de migración.
- Bloqueo remoto que evita migraciones repetidas.
- Restauración automática de la marca de migración local.
- Sincronización local con control de productos duplicados.
- Auditoría de duplicados en el catálogo remoto.
- No elimina automáticamente documentos de Firebase.
- No modifica fotografías locales.

La limpieza y unión segura de duplicados se realizará desde el panel
administrativo de la próxima fase.
