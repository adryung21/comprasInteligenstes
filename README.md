# Mi Compra Inteligente — PWA v1.7 Quick Share

## Compartir sin buscar archivos

El botón **Compartir por Quick Share** genera un paquete completo y abre el menú nativo de Android. Desde allí puede elegirse Quick Share, WhatsApp, correo, Bluetooth u otra aplicación compatible.

El paquete incluye:

- Lista y cantidades.
- Productos completos.
- Nombre, marca, descripción y presentación.
- Categoría y código de barras.
- Fotografía guardada del producto.
- Tiendas vinculadas.
- Todos los precios registrados de los productos de la lista.
- Fecha y nota de cada precio.

## Recibir

La PWA está registrada como destino de contenido compartido. En un dispositivo compatible e instalada desde HTTPS:

1. Acepta el paquete mediante Quick Share.
2. Abre o comparte el archivo con **Mi Compra Inteligente**.
3. La aplicación muestra una vista previa.
4. Elige:
   - **Guardar como lista recibida**, o
   - **Combinar con lista activa**.

En ambos casos, los productos y precios se incorporan al catálogo del dispositivo receptor sin borrar los datos existentes.

## Duplicados

- Primero compara el código de barras.
- Si no existe, compara nombre, marca y presentación.
- Conserva la descripción más completa.
- No repite un precio idéntico de la misma tienda, fecha y valor.
- Conserva la fotografía local y usa la recibida si el producto local no tiene una.

## Compatibilidad

Quick Share depende del menú de compartir y del navegador/sistema operativo. Cuando el navegador no admite archivos mediante Web Share, la PWA descarga el paquete como alternativa. La importación manual continúa disponible dentro de **Listas recibidas → Importación manual de compatibilidad**.

# Mi Compra Inteligente v1.6

Incluye finalización de compra, historial local, informes imprimibles/PDF, listas compartidas separadas y creación de nueva lista.

# Mi Compra Inteligente — PWA v1.5 IA visual

Esta versión corrige el reconocimiento de productos con logos, letras decorativas, reflejos y empaques inclinados.

Cambios:
- La IA visual se ejecuta primero cuando existe un endpoint configurado.
- El OCR local queda como respaldo.
- El OCR ya no rellena nombre y marca con texto de baja confianza.
- Se realizan tres intentos OCR con recorte, ampliación y contraste.
- Se muestra el método utilizado y la confianza.
- Se añadió prueba de conexión del endpoint.
- Se incluye un backend Cloudflare Worker separado para conectar una API visual de forma segura.

Para una fotografía como la de ejemplo, el resultado esperado es:
- Nombre: Ruffles Crema y Cebolla
- Marca: Ruffles
- Presentación: 68 g
- Categoría: Alimentos

# Mi Compra Inteligente — PWA v1.4 Productos

Novedades:
- Al pulsar **+ Precio** dentro de una tarjeta, el producto queda seleccionado y bloqueado automáticamente.
- Ya no es necesario volver a elegir el producto en el formulario.
- El botón general **+ Precio** mantiene el selector para registrar precios de cualquier producto.
- Cada tarjeta incluye **+ Lista**.
- **+ Lista** añade una unidad directamente.
- Si el producto ya está pendiente, aumenta su cantidad en una unidad sin duplicarlo.
- El flujo desde Cámara también abre el precio vinculado al producto reconocido.

# Mi Compra Inteligente — PWA v1.3 Lista de compra

Novedades:
- Barra de progreso de artículos recolectados.
- Porcentaje comprado, por ejemplo: 5 de 10 = 50%.
- Total general estimado de toda la lista.
- Total recolectado.
- Total pendiente por comprar.
- Conteo de artículos sin precio registrado.
- Subtotal visible en cada artículo.

# Mi Compra Inteligente — PWA v1.2 OCR

Esta versión incorpora OCR real en el navegador con Tesseract.js. En Cámara: toma o elige una foto, pulsa **Analizar imagen**, revisa el nombre, marca, presentación, categoría y código sugeridos, y pulsa **Crear producto nuevo**.

La primera lectura requiere conexión para descargar el motor y los modelos español/inglés. Para mejores resultados, fotografía la etiqueta de frente, con buena iluminación, sin reflejos y ocupando la mayor parte de la imagen.

# Mi Compra Inteligente — PWA v1.1

## Corrección para Android

Esta versión corrige la visualización al abrir `index.html` desde el administrador de archivos de Android. El CSS y JavaScript principal están incluidos dentro de `index.html`, por lo que la interfaz ya no depende de que Android permita cargar archivos auxiliares mediante una dirección `content://`.

Abrirla de esa forma permite probarla, pero **no permite instalarla como PWA**. Para que el navegador ofrezca instalación debe servirse mediante HTTPS o desde `localhost`/`127.0.0.1`.

# Mi Compra Inteligente — PWA

Aplicación web progresiva para:

- Registrar productos, categorías y tiendas.
- Guardar precios por fecha y establecimiento.
- Comparar el mejor precio disponible.
- Crear una lista de compra interactiva.
- Ocultar automáticamente los artículos marcados como comprados.
- Calcular la distribución de compra más económica.
- Tomar fotografías o seleccionar imágenes.
- Detectar códigos de barras cuando el navegador admite `BarcodeDetector`.
- Conectar opcionalmente un servicio propio de IA visual.
- Exportar e importar respaldos JSON.
- Funcionar sin internet después de la primera carga.

## Inicio rápido en PC

No abras `index.html` directamente con doble clic porque las PWA necesitan ejecutarse desde un servidor local.

### Opción A: Python

1. Abre una terminal dentro de esta carpeta.
2. Ejecuta:

```bash
python -m http.server 8080
```

3. Abre en Chrome o Edge:

```text
http://localhost:8080
```

4. Usa el botón **Instalar** o la opción de instalación del navegador.

### Opción B: Visual Studio Code

Instala la extensión **Live Server**, abre esta carpeta y selecciona **Open with Live Server**.

## Abrirla en el móvil dentro de la misma red

1. Ejecuta en la PC:

```bash
python -m http.server 8080 --bind 0.0.0.0
```

2. Averigua la IP local de la PC.
3. En el teléfono abre:

```text
http://IP-DE-LA-PC:8080
```

Nota: el acceso a cámara y la instalación PWA completa normalmente requieren HTTPS, excepto en `localhost`. Para uso real en el móvil, publícala en un alojamiento HTTPS como GitHub Pages, Netlify, Cloudflare Pages o Firebase Hosting.

## Datos y privacidad

Los productos, precios, tiendas, imágenes y listas se guardan en IndexedDB dentro de cada dispositivo. Para pasar información de un dispositivo a otro puedes usar **Exportar JSON** e **Importar JSON**.

La sincronización automática entre PC y teléfono requiere una base de datos en línea, que puede añadirse sin reconstruir la interfaz.

## IA visual opcional

En **Ajustes** puedes indicar un endpoint HTTPS propio. La PWA enviará:

```json
{
  "image": "data:image/jpeg;base64,..."
}
```

El endpoint debe responder:

```json
{
  "name": "Arroz extra",
  "brand": "Marca",
  "presentation": "1 kg",
  "category": "Alimentos",
  "barcode": "1234567890123"
}
```

No guardes claves secretas dentro de `app.js`; usa un servidor intermediario seguro.

## Archivos principales

- `index.html`: interfaz.
- `styles.css`: diseño responsivo.
- `app.js`: lógica, IndexedDB, cámara y comparaciones.
- `manifest.webmanifest`: instalación PWA.
- `sw.js`: funcionamiento sin conexión.
- `icons/`: iconos de instalación.
