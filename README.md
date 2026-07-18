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
