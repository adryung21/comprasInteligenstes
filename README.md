# Mi Compra Inteligente v2.1

## Funciones nuevas

- Panel visible únicamente para administradores.
- Bandeja de productos y precios pendientes.
- Corrección administrativa antes de aprobar.
- Aprobación y rechazo con motivo.
- Precio personal separado del precio oficial.
- Botón **Enviar** para solicitar verificación de un precio.
- Sección **Mis envíos** para cada usuario.
- Historial de precios verificados.
- Alertas cuando cambia el precio oficial de un producto en una tienda.
- Productos comunitarios protegidos: los usuarios proponen cambios.
- Auditoría visible de duplicados remotos.

## Datos e imágenes

Las fotografías continúan únicamente en IndexedDB. Firebase almacena texto,
precios, tiendas, productos, propuestas y alertas.

## Seguridad

Esta versión requiere publicar el archivo `firestore.rules` incluido.
