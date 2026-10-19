# عقد الـ API المحلي (Protocol v1)

النقل: HTTP على `127.0.0.1:<port>` (افتراضيًا 47115). اخترنا HTTP مع Polling بدل WebSocket لأن المتصفحات لا تسمح بترويسة `Authorization` في `EventSource`/WebSocket، ولأن طلبات HTTP تمر عبر CORS وPrivate Network Access بوضوح.

## فحوص تُطبَّق على كل طلب

1. ترويسة `Host` يجب أن تكون `127.0.0.1:<port>` أو `localhost:<port>` أو `[::1]:<port>` (حماية من DNS Rebinding) وإلا `403 HOST_NOT_ALLOWED`.
2. ترويسة `Origin` يجب أن تكون ضمن `sites[].origin` حرفيًا؛ وإلا `403 ORIGIN_NOT_ALLOWED` **دون ترويسات CORS**، فلا يستطيع موقع غريب قراءة أي رد.
3. استجابات Preflight تعيد `Access-Control-Allow-Private-Network: true` للأصول المسموح بها فقط.
4. حد معدل لكل أصل (`maxRequestsPerMinute`) و10-20 طلب اقتران في الدقيقة.
5. كل الأوامر عدا الصحة والاقتران تتطلب `Authorization: Bearer <session>`، والجلسة مربوطة بالأصل الذي أنشأها.
6. الأوامر المغيِّرة (`POST /v1/jobs`، الإلغاء) تحمل `requestId` فريدًا؛ التكرار يعيد `409 REPLAYED_REQUEST`.
7. جسم JSON بحد أقصى 16 KB.
8. `X-Correlation-Id` (اختياري، 8-64 حرفًا) يُعاد في الرد ويظهر في السجل.

## نقاط النهاية

| الطريقة والمسار | المصادقة | الوصف |
|---|---|---|
| `GET /` | بلا Origin فقط | صفحة حالة للمستخدم المحلي (تعرض رمز الاقتران في وضع `code`). `X-Frame-Options: DENY`. |
| `GET /v1/health` | لا | `{name, version, protocol, buildDate, pairingMode, adapters, simulator, platform, adapterStatus}` |
| `POST /v1/pair` | لا | `{token}` → `{session, expiresAt}` (وضع signed) |
| `POST /v1/pair/request` | لا | → `{requestId, expiresAt, codeLocation}` (وضع code) |
| `POST /v1/pair/confirm` | لا | `{requestId, code}` → `{session, expiresAt}`؛ عند الخطأ `details.reason` = `wrong_code` أو `expired` |
| `DELETE /v1/session` | نعم | إنهاء الجلسة |
| `GET /v1/devices` | نعم | `{devices:[{id, name, manufacturer, adapter, simulated, busy}], problems:[...]}` |
| `GET /v1/devices/{id}/capabilities` | نعم | نموذج القدرات أدناه |
| `POST /v1/jobs` | نعم | `{requestId, deviceId, settings}` → `202` + المهمة |
| `GET /v1/jobs/{id}` | نعم | حالة المهمة (Polling) |
| `POST /v1/jobs/{id}/cancel` | نعم | `{requestId}` |
| `DELETE /v1/jobs/{id}` | نعم | حذف المهمة وملفاتها المؤقتة |
| `GET /v1/jobs/{id}/pages/{n}` | نعم | بايتات الصورة (`image/png` عادة، أو `image/bmp`) |
| `GET /v1/diagnostics` | نعم | تقرير منقّح |

## توكن الاقتران الموقّع

```
v1.<base64url(JSON {"o": origin, "n": nonce(16 bytes), "e": unix-expiry})>.<base64url(HMAC-SHA256(secret, "v1." + payload))>
```

يرفض الـ Agent التوكن إذا: التوقيع خطأ، `o` ≠ ترويسة `Origin`، انتهى، صلاحيته أطول من 300 ثانية، أو استُخدم الـ nonce من قبل.

## نموذج القدرات

```json
{
  "device": { "id": "win:...", "name": "...", "adapter": "winrt", "simulated": false },
  "status": { "state": "ready", "reportedByDriver": true, "feederReady": true, "coverOpen": false, "paperJam": false },
  "sources": [{
    "id": "flatbed", "kind": "flatbed|feeder|duplex|other", "label": "Flatbed", "duplex": false,
    "colorModes": ["color", "gray"],
    "resolutions": [300] ,
    "defaultResolution": 300,
    "maxArea": { "widthMm": 216, "heightMm": 355.6 },
    "minArea": null,
    "customArea": true,
    "paperSizes": [{ "id": "a4", "label": "A4", "widthMm": 210, "heightMm": 297 }, { "id": "max", ... }],
    "brightness": null,
    "contrast": null
  }],
  "notes": ["..."]
}
```

- `resolutions` إما قائمة أو `{min, max, step}` كما أعلنها التعريف.
- `paperSizes`: في وحدة التغذية مع `winrt` هي المقاسات التي أعلنها التعريف نفسه. في غير ذلك هي مقاسات قياسية (A3–A6، Letter، Legal) **تتسع** لأقصى مساحة أعلنها التعريف لهذا المصدر، إضافة إلى `max`.
- بادئات معرّف الجهاز: `win:` (winrt)، `wia:`، `sane:`، `sim:`.
- `brightness`/`contrast` = `null` إذا لم يكن المدى قابلًا للضبط (مثلًا 0..0).

## إعدادات المهمة

```json
{ "source": "feeder", "colorMode": "gray", "resolution": 300,
  "paper": { "id": "a4" } | { "id": "custom", "widthMm": 100, "heightMm": 150 },
  "brightness": 10, "contrast": 0, "maxPages": 50 }
```

كل قيمة تُتحقق مقابل القدرات المعلنة، وإلا `422 UNSUPPORTED_SETTING` مع `details.setting` و`details.supported`. الـ Flatbed يمسح صفحة واحدة دائمًا.

## المهمة

```json
{ "id": "uuid", "state": "scanning|completed|failed|cancelled", "simulated": false,
  "progress": { "stage": "scanning", "page": 2 },
  "pages": [{ "index": 1, "mime": "image/png", "width": 2480, "height": 3508, "dpi": 300, "colorMode": "gray", "side": "front|back|null", "url": "/v1/jobs/<id>/pages/1" }],
  "error": { "code": "PAPER_JAM", "message": "...", "action": "clear_jam", "details": {...}, "correlationId": "..." } }
```

المهمة الفاشلة تحتفظ بالصفحات الممسوحة قبل الخطأ. مهمة واحدة نشطة لكل جهاز (`409 DEVICE_BUSY`). المهام المنتهية تُحذف بعد `jobTtlSeconds`.

## شكل الخطأ

```json
{ "error": { "code": "FEEDER_EMPTY", "message": "The document feeder is empty.", "action": "load_paper", "details": {}, "correlationId": "..." } }
```

قائمة الرموز في [troubleshooting.md](troubleshooting.md).
