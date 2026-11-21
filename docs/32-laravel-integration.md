# 32 - Laravel Integration

This guide connects a Laravel application to OpenWA so it can send WhatsApp messages from its own
code (an order confirmation, an OTP, a reminder) and react to inbound messages. It assumes the
gateway is already running with at least one paired session — see [07 - API Collection](./07-api-collection.md)
and [06 - API Specification](./06-api-specification.md) for the routes themselves.

Nothing here is Laravel-specific on the gateway side: the same key and the same two calls work from
any PHP application. The Laravel part is where the credential lives, how the HTTP client is wrapped,
and how a webhook is received without breaking CSRF or blocking a worker.

---

## 32.1 How the two sides fit together

```
Laravel app                          OpenWA gateway                    WhatsApp
───────────                          ──────────────                    ────────
Order paid ──► POST /messages/send-text ──► session (paired) ──► recipient
                     ▲
                     │  X-API-Key: owa_k1_…
                     │
Inbound message ◄── webhook POST ──► event dispatch
      │                                   ▲
      └── verify X-OpenWA-Signature ──────┘
```

Two directions, two credentials:

| Direction | Credential                     | Where it lives                     |
| --------- | ------------------------------ | ---------------------------------- |
| Outbound  | API key (`X-API-Key`)          | Laravel `.env`, never in the repo  |
| Inbound   | Webhook `secret` (HMAC-SHA256) | Laravel `.env`, verified per request |

A **dashboard account** (email + password) is for people, not for this. The application gets its own
API key, scoped to the one session it is allowed to send from, so a leak of the Laravel `.env` cannot
reach the rest of the gateway.

---

## 32.2 Create the application's key

In the dashboard: **API Keys → Create for an application**. The preset fills in:

| Field             | Preset                            | Why                                                                     |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------- |
| Name              | you type it (`Laravel — toko`)    | Shows up in the audit log as the actor of every send                    |
| Role              | `operator`                        | Enough to send and read; not enough to mint keys or change settings     |
| Allowed sessions  | the first paired session          | The key cannot send from any other session, even if it names one        |
| Allowed chats     | empty (every chat)                | Narrow it later if the app must only talk to its own customers          |
| Expires           | one year from creation            | Forces a rotation instead of a key that lives forever                   |

The name is left for you to type; the preset only decides what the key may do. Adjust the session
scope or the expiry before creating it if the app needs a different one.

The key is shown **once**, at creation. Copy it into the Laravel `.env` before leaving the page; the
gateway stores only its hash and cannot show it again. The same dialog carries a Laravel snippet with
the key already in place — the `.env` lines, the `config/services.php` entry and the `Http` call —
and a **Copy snippet** button, so the first send needs no hand-written cURL.

The equivalent call, if you prefer cURL:

```bash
curl -s -X POST "$BASE/api/auth/api-keys" \
  -H "X-API-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Laravel — toko",
        "role": "operator",
        "allowedSessions": ["8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a"],
        "expiresAt": "2027-11-21T00:00:00.000Z"
      }'
```

The response carries the plaintext `key` exactly once. `allowedSessions` takes the session **UUID**,
not the session name.

> [!NOTE]
> A key scoped to a session is also refused by the routes that act on the whole deployment (key
> management, `/api/infra`, plugin management, `POST /api/sessions`, the proxy setter). That is the
> point of the preset: the application key can send, and nothing else.

---

## 32.3 Configure Laravel

`.env`:

```dotenv
OPENWA_URL=https://wa.example.com
OPENWA_API_KEY=owa_k1_your-application-key
OPENWA_SESSION_ID=8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a
OPENWA_WEBHOOK_SECRET=the-same-secret-you-set-on-the-webhook
```

`config/services.php`:

```php
'openwa' => [
    'url'        => env('OPENWA_URL'),
    'key'        => env('OPENWA_API_KEY'),
    'session_id' => env('OPENWA_SESSION_ID'),
    'secret'     => env('OPENWA_WEBHOOK_SECRET'),
],
```

`OPENWA_URL` is the gateway root, **without** `/api` — the client below adds the prefix. If the
dashboard is served from the same origin, that is the same host you open in the browser.

> [!TIP]
> Cache the config after editing `.env` (`php artisan config:cache`) on production. A cached config
> that still holds an old key is the usual cause of a sudden `401` after a rotation.

---

## 32.4 A small client

`app/Services/WhatsApp.php`:

```php
<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

class WhatsApp
{
    private function http(): PendingRequest
    {
        return Http::baseUrl(rtrim(config('services.openwa.url'), '/') . '/api')
            ->withHeaders(['X-API-Key' => config('services.openwa.key')])
            ->acceptJson()
            ->timeout(15);
        // No retry() here on purpose: a 429 must honour Retry-After and a 409 may clear in a second,
        // so the caller (usually a queued job) decides. See 32.5.
    }

    /** @param string $chatId  phone JID, e.g. 628123456789@c.us */
    public function sendText(string $chatId, string $text, ?string $idempotencyKey = null): Response
    {
        return $this->http()
            ->withHeaders($idempotencyKey ? ['Idempotency-Key' => $idempotencyKey] : [])
            ->post('/sessions/' . config('services.openwa.session_id') . '/messages/send-text', [
                'chatId' => $chatId,
                'text'   => $text,
            ]);
    }

    public function sendTemplate(string $chatId, string $templateName, array $vars = []): Response
    {
        return $this->http()
            ->post('/sessions/' . config('services.openwa.session_id') . '/messages/send-template', [
                'chatId'       => $chatId,
                'templateName' => $templateName,
                'vars'         => $vars,
            ]);
    }

    /** Normalises an Indonesian phone number to the JID form the API expects. */
    public static function chatId(string $phone): string
    {
        $digits = preg_replace('/\D+/', '', $phone);
        if (str_starts_with($digits, '0')) {
            $digits = '62' . substr($digits, 1);
        }
        return $digits . '@c.us';
    }
}
```

Three details that matter more than they look:

- **`chatId` is a JID, not a phone number.** `628123456789@c.us` for a person, `<id>@g.us` for a
  group. A bare number is rejected (`400`), and a group cannot be addressed by its phone-like digits.
- **`Idempotency-Key` makes a retry safe.** Generate one per logical message (`Str::uuid()` or the
  order id) and reuse it on every retry. A second request with the same key returns the first
  response instead of sending twice; a *different* body under the same key is refused with `422`.
- **`timeout(15)` is a client-side budget, not a delivery guarantee.** On a timeout the message may
  have been sent. That is exactly the case the idempotency key exists for.

---

## 32.5 Sending from a job

Sending inside an HTTP request couples the user's page load to WhatsApp's latency. Queue it:

```php
<?php

namespace App\Jobs;

use App\Services\WhatsApp;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

class SendOrderConfirmation implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 5;
    public array $backoff = [10, 30, 60, 120];

    public function __construct(
        public string $phone,
        public string $orderNumber,
        public string $total,
    ) {}

    public function handle(WhatsApp $wa): void
    {
        $response = $wa->sendText(
            WhatsApp::chatId($this->phone),
            "Terima kasih! Pesanan {$this->orderNumber} ({$this->total}) sudah kami terima.",
            // Stable per order: a queue retry cannot send the confirmation twice.
            idempotencyKey: "order-{$this->orderNumber}-confirmation",
        );

        if ($response->status() === 429) {
            $this->release((int) ($response->header('Retry-After') ?: 30));
            return;
        }

        if ($response->failed()) {
            // 400/403/404 are permanent: throwing only burns the retry budget.
            if (in_array($response->status(), [400, 403, 404], true)) {
                report(new \RuntimeException('OpenWA refused the send: ' . $response->body()));
                return;
            }
            $response->throw();
        }
    }
}
```

```php
SendOrderConfirmation::dispatch($order->phone, $order->number, $order->formatted_total);
```

The send routes are paced by the gateway itself: a burst from one session is throttled and the
response carries `Retry-After`. Honouring that header is what keeps a queue worker from turning a
rate limit into a retry storm.

---

## 32.6 Receiving inbound messages

### Register the webhook

```bash
curl -s -X POST "$BASE/api/sessions/$SESSION_ID/webhooks" \
  -H "X-API-Key: $OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "url": "https://app.example.com/webhooks/openwa",
        "events": ["message.received"],
        "secret": "a-random-string-of-at-least-16-characters",
        "retryCount": 3
      }'
```

`secret` is write-only: no route returns it, and it is not included in a data export. Without it the
delivery carries no `X-OpenWA-Signature` header at all.

### Exclude the route from CSRF

`bootstrap/app.php` (Laravel 11+):

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->validateCsrfTokens(except: [
        'webhooks/openwa',
    ]);
})
```

On Laravel 10 and earlier, add the path to `$except` in `app/Http/Middleware/VerifyCsrfToken.php`.

### Route and controller

`routes/api.php`:

```php
Route::post('/webhooks/openwa', [OpenWaWebhookController::class, 'handle']);
```

`app/Http/Controllers/OpenWaWebhookController.php`:

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\Response;

class OpenWaWebhookController extends Controller
{
    public function handle(Request $request): Response
    {
        $secret = (string) config('services.openwa.secret');
        $expected = 'sha256=' . hash_hmac('sha256', $request->getContent(), $secret);

        // hash_equals, not ===: a byte-by-byte early return leaks the correct prefix.
        if ($secret === '' || ! hash_equals($expected, (string) $request->header('X-OpenWA-Signature'))) {
            return response()->noContent(401);
        }

        $event = $request->json()->all();

        if (($event['event'] ?? null) === 'message.received') {
            // Queue it: the gateway retries a delivery that answers slowly or with 5xx.
            ProcessInboundWhatsApp::dispatch($event['data'] ?? []);
        }

        // 2xx means "delivered". Anything else makes the gateway retry this event.
        return response()->noContent();
    }
}
```

The signature is an HMAC-SHA256 over the **raw body bytes**, with the header shaped
`sha256=<hex>`. Always verify against `$request->getContent()` — never against a re-encoded array;
`json_encode(json_decode($body))` can differ byte for byte and will never match. The PHP SDK ships
the same check as `OpenWA\WebhookSignature::verify($rawBody, $header, $secret)`.

A useful part of the payload:

```json
{
  "event": "message.received",
  "timestamp": "2026-11-21T09:14:02.481Z",
  "sessionId": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "idempotencyKey": "msg_…",
  "deliveryId": "dlv_…",
  "data": {
    "id": "3EB0ABC123",
    "chatId": "628123456789@c.us",
    "from": "628123456789@c.us",
    "body": "Pesanan saya kapan dikirim?",
    "type": "chat",
    "timestamp": 1763716442,
    "fromMe": false,
    "isGroup": false,
    "kind": "individual"
  }
}
```

`data.timestamp` is epoch **seconds** here (the envelope's `timestamp` is ISO-8601). `deliveryId` is
stable per delivery attempt-group, so it makes a good idempotency key on your side:
`Cache::add("openwa:{$event['deliveryId']}", true, now()->addDay())` is enough to drop a duplicate.

> [!NOTE]
> The webhook URL is checked against the SSRF guard at **registration** time, not just at delivery.
> A private or loopback host is refused with `400` unless it is listed in `SSRF_ALLOWED_HOSTS`. That
> is why `http://localhost:8000/webhooks/openwa` fails from a gateway on another host — and why a
> local development setup usually points the webhook at a tunnel or runs both on one machine.

### Answering quickly

The gateway's delivery timeout is short by design. Do the verification and the enqueue, then answer
`204`; anything slower becomes a retry. If the endpoint is down, deliveries are retried up to
`retryCount` and then recorded in `GET /api/webhooks/delivery-failures`, from where an admin can
redrive them.

---

## 32.7 Errors the app must handle

| Status | Meaning                                                              | What to do                                                    |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `400`  | Bad body, bad `chatId`, unknown field, or a session not active        | Fix the call; do not retry                                    |
| `401`  | Missing or invalid key (rotated? wrong env?)                          | Do not retry; alert                                          |
| `403`  | Key role too low, or the session/chat is outside the key's scope      | Fix the key; do not retry                                     |
| `404`  | Session or template not found                                         | Fix the id; do not retry                                      |
| `409`  | Session not ready (not paired, reconnecting) or engine busy           | Retry with backoff — this is the normal "just started" answer |
| `413`  | Media over the size cap                                               | Send a link instead of the file                               |
| `422`  | `Idempotency-Key` reused with a different body                        | Bug in key generation; do not retry                           |
| `429`  | Rate limited                                                          | Honour `Retry-After`, then retry                              |
| `503`  | Transient: engine/WhatsApp timeout, recipient lookup failed           | Retry with backoff; keep the idempotency key                  |
| `501`  | The active engine cannot do this (e.g. a location to a channel)        | Do not retry; fall back                                     |

A `503` does not always mean "nothing was sent": on Baileys a WhatsApp-side timeout can leave the
outcome unknown. That is the case where reusing the `Idempotency-Key` is not optional — it is what
prevents the customer from receiving the same message twice.

---

## 32.8 Optional: the PHP SDK

If you would rather not hand-roll the HTTP layer, the repository ships a PHP SDK
(`sdk/php`, package `rmyndharis/openwa`) with typed resources and no Laravel dependency:

```bash
composer require rmyndharis/openwa
```

```php
use OpenWA\Client;
use OpenWA\WebhookSignature;

$client = new Client([
    'baseUrl' => config('services.openwa.url'),
    'apiKey'  => config('services.openwa.key'),
]);

$result = $client->messages->sendText(config('services.openwa.session_id'), [
    'chatId' => '628123456789@c.us',
    'text'   => 'Halo dari Laravel!',
]);

// in the webhook controller
if (! WebhookSignature::verify($request->getContent(), $request->header('X-OpenWA-Signature'), $secret)) {
    return response()->noContent(401);
}
```

The SDK covers the documented REST surface; the dashboard-account routes (`auth/login`,
`auth/users`, …) are deliberately not exposed through it, because those are for people, not
applications.

---

## 32.9 Checklist

- [ ] A dedicated API key per application, role `operator`, scoped to one session, with an expiry.
- [ ] The key is in `.env` only — not in a committed config file, not in a log line.
- [ ] `OPENWA_URL` has no `/api` suffix; the client adds it.
- [ ] Every send carries a stable `Idempotency-Key`.
- [ ] `409`/`429`/`503` are retried with backoff; `400`/`403`/`404` are not.
- [ ] The webhook route is CSRF-exempt and verifies `X-OpenWA-Signature` over the raw body.
- [ ] The webhook answers `2xx` fast and does the work in a queue.
- [ ] `php artisan config:cache` was re-run after the last `.env` change.
- [ ] Key rotation is scheduled before `expiresAt`, not discovered when sends start failing.
