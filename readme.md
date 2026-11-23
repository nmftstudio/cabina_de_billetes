# Cabina de Billetes

**Cabina de Billetes** es un juego web de habilidad con estética de gabinete arcade retro-futurista. El jugador abona **$500 ARS** mediante Mercado Pago para entrar en una cabina virtual durante **30 segundos**, donde billetes de **$10** vuelan impulsados por ráfagas de viento y turbulencia mientras el movimiento de la mano desplaza el aire.

Al finalizar la partida, el servidor re-simula las entradas de forma determinista y reembolsa automáticamente al medio de pago original el monto equivalente a los billetes capturados. El dinero no capturado se reparte entre el **pozo acumulado** (que se suma a la siguiente partida) y la **casa**.

---

## Características principales

* **Simulación física determinista (`sim.js`):** Implementada con aritmética compatible IEEE 754 (sin funciones trigonométricas o exponenciales nativas que puedan variar entre motores) para garantizar exactamente el mismo resultado en el navegador y en el servidor.
* **Validación anti-trampas (`server.js`):** El cliente registra la posición del puntero y los intentos de agarre (`taps`) frame a frame (`60 FPS`). El backend verifica duración mínima de partida, velocidad máxima de desplazamiento (`maxJump`), integridad de los frames y re-simula la partida completa antes de emitir el reembolso.
* **Integración con Mercado Pago:**
  * Creación de preferencias de pago (`/api/orders`).
  * Confirmación mediante webhook firmado con HMAC-SHA256 (`/api/mp-webhook`) y verificación directa contra la API de Mercado Pago (`/api/games/:id/confirm`).
  * Reembolsos parciales idempotentes (`/v1/payments/:id/refunds`) con reintentos automáticos en segundo plano ante fallos transitorios.
* **Persistencia atómica con SQLite:** Utiliza el módulo nativo `node:sqlite` (`DatabaseSync`) en modo `WAL` con transacciones `BEGIN IMMEDIATE` para administrar partidas, estados y el pozo acumulado sin condiciones de carrera.
* **Interfaz arcade autocontenida (`index.html`):** Estética retro-futurista con marquesina en neón rosa (`Monoton`), contadores tipo display ámbar, efectos de *scanlines* y viñeta, y adaptación a tema claro/oscuro en el fondo externo.

---

## Estructura del proyecto

```text
.
├── server.js       # Servidor Express, API REST, integración con Mercado Pago y SQLite
├── index.html      # Interfaz del gabinete arcade, renderizado en Canvas y bucle de juego
├── sim.js          # Motor de simulación determinista compartido entre cliente y servidor
├── test.js         # Pruebas de punta a punta con mock de Mercado Pago y bot jugador
├── calibrate.js    # Script de calibración de dificultad y métricas de captura con bot
└── package.json    # Configuración del paquete y scripts de ejecución
```

> **Nota sobre rutas estáticas:** `server.js` sirve los archivos estáticos desde `./public` y carga `./public/sim.js`. Asegúrate de ubicar `index.html` y `sim.js` dentro de una carpeta `public/` antes de iniciar el servidor.

---

## Requisitos

* **Node.js `>= 22.5.0`** (requerido por el módulo nativo `node:sqlite`).
* Una cuenta de **Mercado Pago** con credenciales de prueba o producción (`Access Token` y `Webhook Secret`).

---

## Instalación y uso

1. **Preparar los archivos estáticos:**
   ```bash
   mkdir -p public
   mv index.html sim.js public/
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```

3. **Ejecutar el servidor en modo prueba:**
   ```bash
   MP_ACCESS_TOKEN="TEST-tu-access-token" npm start
   ```
   Por defecto, el servidor levanta en `http://localhost:3000`.

---

## Variables de entorno

| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `PORT` | `3000` | Puerto HTTP en el que escucha el servidor. |
| `BASE_URL` | `http://localhost:3000` | URL pública base (si empieza con `https`, habilita `auto_return` y `notification_url` en Mercado Pago). |
| `MP_ACCESS_TOKEN` | `""` | Token de acceso de Mercado Pago (**obligatorio** en `MODE=live`). |
| `MP_WEBHOOK_SECRET` | `""` | Secreto para validar la firma `x-signature` de los webhooks (**obligatorio** en `MODE=live`). |
| `MP_BASE_URL` | `https://api.mercadopago.com` | URL base de la API de Mercado Pago (útil para mocks o entornos de prueba). |
| `MODE` | `test` | Modo de operación (`test` o `live`). |
| `CASA_PCT` | `10` | Porcentaje del dinero no capturado que retiene la casa (redondeado hacia abajo a múltiplos de $10). |
| `POZO_MAX` | `1000` | Tope máximo del pozo acumulado; cualquier excedente pasa a la casa. |
| `MAX_REFUND` | `0` | Tope máximo de reembolso por partida (`0` = sin tope, se reembolsa todo lo capturado). |
| `MIN_PLAY_MS` | `28000` | Tiempo mínimo transcurrido desde el inicio para aceptar el cierre de una partida (en ms). |
| `EXPIRE_MS` | `600000` | Tiempo tras el cual una partida iniciada y abandonada expira con `$0` capturados (en ms). |
| `DB_PATH` | `cabina.db` | Ruta al archivo de base de datos SQLite. |
| `TRUST_PROXY` | *(vacío)* | Si se define, habilita `trust proxy` en Express para obtener la IP real detrás de un proxy inverso. |

---

## Pruebas y calibración

### Ejecutar pruebas automatizadas
El proyecto incluye un test de integración que levanta un servidor HTTP simulado de Mercado Pago y verifica todo el ciclo de vida (creación de orden, pago, webhook firmado, entrega única de semilla, re-simulación, reembolso parcial, acumulación de pozo y rechazo de trampas):

```bash
npm test
```

### Calibrar dificultad
Para simular 80 partidas con un bot y observar la mediana, percentil 90 y porcentaje de jugadores que recuperan al menos la mitad del valor de entrada:

```bash
node calibrate.js
```

---

## Checklist antes de pasar a producción (`MODE=live`)

1. Completar los datos legales (`[razón social / CUIT]` y `[mail]`) dentro de la sección `<details class="terms">` en `public/index.html`.
2. Configurar `BASE_URL` con dominio `HTTPS` válido para recibir las notificaciones de Mercado Pago.
3. Definir `MP_ACCESS_TOKEN` y `MP_WEBHOOK_SECRET` de producción y establecer `MODE=live`.
4. Configurar respaldos periódicos del archivo SQLite (`DB_PATH`).
