# Arquitectura Técnica: Cabina de Billetes

Este documento detalla las decisiones de ingeniería, el modelo matemático de simulación determinista, el protocolo de serialización de entradas, el control de concurrencia en base de datos y las garantías de seguridad e idempotencia implementadas en **Cabina de Billetes**.

---

## 1. Visión general de la arquitectura

El sistema sigue un modelo de **cliente autoritativo en renderizado y servidor autoritativo en estado y economía**, desacoplado mediante **re-simulación determinista**:

```
┌──────────────────────┐       1. POST /api/orders        ┌──────────────────────┐
│                      │ ───────────────────────────────► │                      │
│   Cliente (Canvas)   │       2. Pago + Webhook / API    │   Servidor Node.js   │
│                      │ ◄──────────────────────────────► │   (Express + SQLite) │
│  - Loop 60 Hz fijo   │       3. POST /start -> {seed}   │                      │
│  - Captura ptr/taps  │ ◄─────────────────────────────── │  - Valida inputs     │
│  - Renderizado 2D    │       4. POST /finish {ptr,taps} │  - Sim.replay()      │
│                      │ ───────────────────────────────► │  - Reembolso MP      │
└──────────────────────┘                                  └──────────────────────┘
           │                                                         │
           └──────────────► Módulo compartido: sim.js ◄──────────────┘
```

El objetivo central de este diseño es evitar una conexión persistente de baja latencia (como WebSockets) durante los 30 segundos de partida, manteniendo al mismo tiempo una verificación estricta en el servidor antes de ejecutar movimientos de dinero real.

---

## 2. Motor de simulación determinista (`sim.js`)

Para que `Sim.replay()` en Node.js produzca exactamente el mismo resultado que la ejecución en V8/SpiderMonkey/JavaScriptCore del navegador, el módulo `sim.js` evita funciones matemáticas trascendentes nativas (`Math.sin`, `Math.cos`, `Math.exp`, `Math.hypot`, `Math.pow`), ya que la especificación ECMAScript permite pequeñas diferencias de redondeo (ULP) entre implementaciones de motores JS.

### 2.1. Aritmética compatible IEEE 754
* **Operaciones permitidas:** `+`, `-`, `*`, `/`, `Math.sqrt`, `Math.floor`, `Math.abs`, `Math.min`, `Math.max` (todas definidas con precisión exacta por el estándar IEEE 754).
* **Coseno por serie de Taylor (`cos(x)`):** Reducción de rango al intervalo $[-\pi, \pi]$ mediante `x = x - TAU * Math.floor(x / TAU + 0.5)`, seguida de un polinomio de grado 16 evaluado mediante esquema de Horner:
  $$\cos(x) \approx 1 + x^2\left(-\frac{1}{2} + x^2\left(\frac{1}{24} - \dots + \frac{x^2}{20922789888000}\right)\right)$$
* **Exponencial negativa (`expNeg(u)`):** Para $u \ge 0$, aproxima $e^{-u}$ escalando $t = -u/8$, calculando un polinomio de Taylor de orden 5 y elevando al cuadrado tres veces consecutivas ($e^t \to e^{2t} \to e^{4t} \to e^{8t}$).
* **PRNG determinista:** Generador **Mulberry32** sembrado con un entero de 31 bits (`crypto.randomInt(1, 2**31 - 1)`).

### 2.2. Modelo físico de la cabina
La cabina tiene dimensiones lógicas constantes de $360 \times 520$ unidades (`W = 360, H = 520`) y avanza en pasos discretos fijos de $\Delta t = \frac{1}{60}\text{ s}$ durante $1800$ frames (`FRAMES = 1800`).

En cada paso `step(S, dt, ptr)`:
1. **Ráfagas del ventilador (`gust`):** Modulación temporal producto de dos ondas armónicas desfasadas (`S.t * 0.9 + S.g1` y `S.t * 0.37 + S.g2`), acotada a un mínimo de `0.12`.
2. **Separación entre billetes (`sep`):** Fuerza de repulsión elástica por pares ($O(n^2)$ con $n \le 150$) cuando la distancia entre centros es menor a `sd = 40` px, evitando apilamientos artificiales.
3. **Campo de turbulencia incompresible:** Superposición de 5 modos espaciales donde la velocidad $(u, v)$ se deriva como el rotacional de una función de corriente $\psi(x, y, t)$:
   $$u = \frac{\partial \psi}{\partial y}, \quad v = -\frac{\partial \psi}{\partial x}$$
   Esto genera remolinos fluidos sin puntos de acumulación artificiales.
4. **Chorro ascendente (`jet`):** Perfil gaussiano centrado en $x = W/2$ (`expNeg(q * q)`) cuya intensidad crece con la profundidad vertical (`0.35 + 0.65 * b.y / H`), contrarrestando una gravedad constante de `70`.
5. **Repulsión aerodinámica de la mano:** Si existe puntero activo (`ptr`), todo billete dentro de un radio `rr = 100` px recibe un impulso radial hacia afuera proporcional a $1 - d/r_r$.
6. **Mecánica de agarre (`gr`):**
   * Al recibir un `tap` con cooldown agotado (`cd <= 0`), se inicia un cierre de mano de duración `close = 0.2 s` (`12` frames) en la coordenada fija del toque, activando un cooldown de `cool = 0.45 s` (`27` frames).
   * Al cumplirse los `0.2 s`, se captura **como máximo un billete** (el más cercano dentro de un radio `grab = 16` px), sumando `$10`.

---

## 3. Protocolo de entradas y validación anti-trampas

### 3.1. Empaquetado binario en enteros (`pack` / `unpack`)
Para minimizar el payload enviado en `POST /api/games/:id/finish` (1800 frames), cada coordenada $(x, y)$ se cuantiza a décimas de píxel y se empaqueta en un único entero seguro de JavaScript:

$$\text{packed} = \lfloor x \cdot 10 \rfloor \cdot 8192 + \lfloor y \cdot 10 \rfloor$$

* Si el puntero está fuera del canvas o no hay toque activo, se envía `-1`.
* El array `ptr` contiene exactamente `1800` enteros (~10–15 KB en JSON).
* El array `taps` contiene únicamente los índices de frame (`0 <= f < 1800`) donde el jugador intentó cerrar la mano (máximo 200 elementos estrictamente crecientes).

### 3.2. Reglas de validación en el servidor (`validInputs`)
Antes de ejecutar `Sim.replay()`, `server.js` audita los datos recibidos:
* **Duración real de pared:** `Date.now() - g.started_at >= MIN_PLAY_MS` (por defecto `28000 ms`), impidiendo envíos instantáneos automatizados (HTTP `425 Too Early`).
* **Integridad estructural:** `ptr.length === 1800`, valores enteros dentro de `[0, W*10]` y `[0, H*10]`.
* **Límite cinemático (`maxJump = 150` px/frame):** Si entre dos frames consecutivos con puntero activo la distancia euclidiana supera `150 px` (equivalente a `9000 px/s`), la partida se rechaza con `ptr_jump`. Esto impide que un bot teletransporte el cursor de un billete a otro entre frames.
* **Consistencia de `taps`:** Cada frame en `taps` debe ser estrictamente mayor al anterior y corresponder a un frame donde `ptr[f] >= 0`.

---

## 4. Ciclo de vida de la partida y persistencia (`SQLite`)

El estado se persiste mediante `node:sqlite` (`DatabaseSync`) con `PRAGMA journal_mode=WAL`. Todas las transiciones críticas de dinero y estado se ejecutan dentro de transacciones `BEGIN IMMEDIATE` para serializar escrituras concurrentes.

```
[pending] ──(Webhook / Confirm MP)──► [paid] ──(POST /start)──► [started] ──(POST /finish / Expiración)──► [finished]
```

1. **`pending`:** Se crea al generar la preferencia de pago (`POST /api/orders`). Se asigna `seed` aleatoria, pero **no se envía al cliente**.
2. **`paid`:** Se alcanza únicamente tras consultar `GET /v1/payments/:id` en la API oficial de Mercado Pago y verificar `status === 'approved'`, `transaction_amount === 500`, `currency_id === 'ARS'` y `external_reference === gameId`. La columna `payment_id` tiene restricción `UNIQUE` para impedir reutilizar un comprobante en dos partidas.
3. **`started`:** En `POST /api/games/:id/start`, la transacción atómica:
   * Descuenta hasta `$1000` del `pozo` global (`take = Math.min(pozo, 1000)`) y lo bloquea dentro de `g.total = 500 + take`.
   * Entrega `seed` y `total` al cliente **una única vez**. Recargar la página no permite reintentar ni conocer la semilla antes de comprometer la partida.
4. **`finished`:** En `finishTx(id, got)`:
   * Calcula `refund = maxRefund > 0 ? Math.min(got, maxRefund) : got`.
   * Calcula el remanente `rest = g.total - refund`.
   * Calcula la comisión de la casa redondeada hacia abajo a múltiplos de `$10`:
     $$\text{casaBase} = \left\lfloor \frac{\text{rest} \cdot \text{casaPct}}{100 \cdot 10} \right\rfloor \cdot 10$$
   * Incorpora `rest - casaBase` al pozo global respetando el techo `POZO_MAX`; cualquier excedente por encima de `POZO_MAX` se asigna a `casa`, garantizando invariante contable exacta:
     $$\text{refund} + \text{toPozo} + \text{casa} = \text{total}$$

---

## 5. Integración con Mercado Pago y tolerancia a fallos

* **Autenticación de Webhooks (`verifySignature`):** Extrae `ts` y `v1` del encabezado `x-signature`, reconstruye el manifiesto `id:{data.id};request-id:{x-request-id};ts:{ts};`, calcula el HMAC-SHA256 con `MP_WEBHOOK_SECRET` y compara en tiempo constante usando `crypto.timingSafeEqual`.
* **Doble canal de confirmación:** Si el webhook se demora cuando el usuario vuelve desde Checkout Pro, el frontend realiza *polling* y dispara `POST /api/games/:id/confirm`, que consulta directamente a Mercado Pago de forma idempotente.
* **Reembolsos parciales idempotentes (`doRefund`):**
  * Envía `POST /v1/payments/{payment_id}/refunds` con el encabezado `X-Idempotency-Key: cabina-refund-{gameId}`.
  * Si la llamada falla por red o timeout de Mercado Pago, `refund_status` queda en `'failed'` y un *worker* en segundo plano (`setInterval` cada 60 s) reintenta automáticamente hasta 10 veces usando la misma clave de idempotencia.
* **Expiración de partidas abandonadas (`expireStale`):** Si una partida en estado `'started'` supera `EXPIRE_MS` (10 minutos) sin recibir `/finish`, el *worker* la cierra automáticamente con `got = 0`, devolviendo el dinero bloqueado al pozo y a la casa.

---

## 6. Herramientas de verificación y calibración

* **`test.js`:** Levanta una instancia efímera del servidor Express y un servidor HTTP que emula los endpoints de Mercado Pago (`/checkout/preferences`, `/v1/payments/:id`, `/v1/payments/:id/refunds`). Ejecuta un bot acoplado a `sim.js` y verifica:
  1. Conservación exacta del dinero (`refund + toPozo + casa === total`).
  2. Idempotencia ante reenvíos de `/finish`.
  3. Transferencia del pozo entre partidas consecutivas.
  4. Rechazo de `taps` falsos, saltos de cursor (`ptr_jump`), envíos prematuros (`425`) y arrays truncados (`ptr_length`).
  5. Validación de firma HMAC en webhooks y rechazo de pagos reutilizados (`payment_reused`).
* **`calibrate.js`:** Ejecuta 80 simulaciones con un bot parametrizado (`speed = 450 px/s`, `jitter = 20 px`, `reactionTime = 0.25 s`) para medir la mediana, percentil 90 y tasa de recuperación del 50%, permitiendo ajustar las constantes físicas en `Sim.P` (`turb`, `fan`, `grab`, `repel`, `cool`).