# الرفع والتحقق والتخزين

## التدفق (الوضع A)

1. المتصفح يمسح الصفحات عبر الـ Agent ويحتفظ بها في الذاكرة.
2. «إنشاء PDF»: كل صفحة تُرسم مع التدوير وتُرمَّز JPEG (`pdf.jpeg_quality`) ثم تُجمع في PDF 1.4 بأحجام صفحات فعلية (`بكسل ÷ dpi × 72` نقطة)، فتُدعم صفحات بمقاسات واتجاهات مختلفة. يُتحقق من البنية وعدد الصفحات قبل العرض.
3. «رفع إلى الخادم»:
   - `POST /document-scanner/sessions` ينشئ جلسة رفع (مرة واحدة، وتُعاد لكل محاولة).
   - `POST /document-scanner/sessions/{id}/preflight` فحص سريع للحجم والصفحات والنوع.
   - `POST /document-scanner/sessions/{id}/upload` (`multipart/form-data`) مع مؤشر تقدم حقيقي (XHR).
4. الخادم يتحقق ثم يخزّن ويعيد `201` مع المستند. الواجهة تعلن النجاح وتملأ الحقل المخفي **بعد** هذا الرد فقط.
5. عند الفشل: تبقى الصفحات وPDF في الذاكرة، ويظهر الخطأ مع «إعادة المحاولة». المحاولة تعيد استخدام نفس الجلسة.

### المسارات

| الطريقة | المسار | الاسم | الوصف |
|---|---|---|---|
| GET | `/document-scanner` | `document-scanner.page` | صفحة مسح مستقلة |
| GET | `/document-scanner/config` | `.config` | إعداد العميل غير السري + `csrfToken` |
| POST | `/document-scanner/agent-token` | `.agent-token` | توكن اقتران قصير العمر |
| POST | `/document-scanner/sessions` | `.sessions.store` | إنشاء جلسة رفع |
| GET | `/document-scanner/sessions/{id}` | `.sessions.show` | حالة الجلسة |
| DELETE | `/document-scanner/sessions/{id}` | `.sessions.destroy` | إلغاء الجلسة |
| POST | `/document-scanner/sessions/{id}/preflight` | `.sessions.preflight` | فحص مسبق |
| POST | `/document-scanner/sessions/{id}/upload` | `.sessions.upload` | الرفع |
| GET | `/document-scanner/documents/{id}` | `.documents.show` | بيانات المستند |
| GET | `/document-scanner/documents/{id}/download` | `.documents.download` | تنزيل (رابط موقّع + المالك فقط) |
| DELETE | `/document-scanner/documents/{id}` | `.documents.destroy` | حذف المستند وملفه |
| GET | `/document-scanner/assets/{file}` | `.assets` | ملفات JS/CSS من قائمة ثابتة |

كل المسارات (عدا الأصول) خلف `web` + `auth` + Gate اختياري `use-document-scanner`، ومسارات الرفع والجلسات والتوكن عليها حدود معدل.

### رد الرفع الناجح

```json
{
  "document": {
    "id": "01M59R3HB1G434FZN8DQR57HEH",
    "filename": "scan-20261019-123404.pdf",
    "mimeType": "application/pdf",
    "size": 125691,
    "pages": 6,
    "sha256": "…",
    "metadata": { "title": "Demo", "category": "demo" },
    "createdAt": "2026-10-19T09:31:02+00:00",
    "downloadUrl": "https://app.example.com/document-scanner/documents/…/download?expires=…&signature=…"
  },
  "session": { "id": "…", "status": "completed", "documentId": "…" },
  "duplicate": false
}
```

لا يحتوي الرد على القرص أو المسار الداخلي أو معرّف المالك.

## ما يتحقق منه الخادم

| الفحص | الرمز عند الفشل |
|---|---|
| مستخدم مسجّل ومالك للجلسة | `401 UNAUTHENTICATED` / `403 FORBIDDEN` |
| CSRF (جلسة الويب) | `419` |
| الجلسة مفتوحة وغير منتهية | `409 SESSION_CLOSED` / `409 SESSION_EXPIRED` |
| الملف غير فارغ | `422 FILE_EMPTY` |
| الحجم ≤ `limits.max_file_size_kb` | `413 FILE_TOO_LARGE` |
| النوع من **المحتوى** (`finfo`) ضمن `accepted_types` | `422 FILE_TYPE_NOT_ALLOWED` |
| PDF: الترويسة، `startxref`/`%%EOF`، شجرة الصفحات متسقة | `422 FILE_CORRUPT` |
| PDF: لا JavaScript ولا Launch ولا ملفات مضمنة ولا XFA ولا تشفير | `422 FILE_ACTIVE_CONTENT` |
| عدد الصفحات = العدد الذي أعلنه العميل | `422 PDF_PAGE_MISMATCH` |
| عدد الصفحات ≤ `limits.max_pages` | `422 TOO_MANY_PAGES` |
| نجاح الكتابة على القرص | `507 STORAGE_FAILED` (لا يُنشأ سجل ولا يُطلق حدث) |

اسم الملف واسم MIME القادمان من العميل لا يُعتمد عليهما. الاسم المعروض يُنقّى (يُحتفظ بالحروف العربية، وتُحذف أجزاء المسار ومحارف التحكم ومحارف الاتجاه الخفية والمحارف المحجوزة)، أما مسار التخزين فهو دائمًا `scanned-documents/YYYY/MM/<ulid>.pdf`.

### منع التكرار

الجلسة هي مفتاح منع التكرار: مستند واحد لكل جلسة. إعادة رفع البايتات نفسها (مثلًا بعد انقطاع وصل فيه الرفع إلى الخادم ولم يصل الرد) تعيد المستند نفسه بـ `200` و`duplicate: true`. رفع ملف مختلف لجلسة مكتملة يعيد `409`. يُقفل صف الجلسة داخل معاملة لمنع سجلين متزامنين.

### الأحداث

| الحدث | متى |
|---|---|
| `Aam\DocumentScanner\Events\ScanSessionCreated` | إنشاء جلسة رفع |
| `Aam\DocumentScanner\Events\DocumentUploaded` | **بعد** الكتابة على القرص وتثبيت السجل |
| `Aam\DocumentScanner\Events\ScanSessionCancelled` | إلغاء جلسة |
| `Aam\DocumentScanner\Events\DocumentDeleted` | حذف مستند |

لا يوجد حدث `DocumentScanned`: الخادم لا يرى عملية المسح نفسها (تجري على جهاز المستخدم)، فأول حقيقة يعرفها هي وصول ملف صالح.

```php
// معالجة لاحقة ثقيلة (مثل OCR) في Queue
Event::listen(DocumentUploaded::class, fn (DocumentUploaded $e) => RunOcr::dispatch($e->document->id));
```

## التخزين

- القرص `DOCUMENT_SCANNER_DISK` (افتراضيًا `local` الخاص). أي قرص Laravel يعمل، بما فيه S3-compatible، ويُكتب الملف بـ `visibility=private`.
- لا تستخدم `public` إلا عن قصد؛ `document-scanner:check` ينبّه.
- التنزيل عبر `downloadUrl` الموقّع والمؤقت، مع التحقق من الملكية أيضًا.

## الوضع B

عند `output="form-file"` يصل الملف إلى مسارك أنت. مثال واقعي:

```php
use Aam\DocumentScanner\Support\PdfInspector;
use Illuminate\Support\Str;

public function storeFile(Request $request, PdfInspector $inspector)
{
    $request->validate([
        'document' => ['required', 'file', 'mimetypes:application/pdf', 'max:20480'],
    ]);

    $info = $inspector->inspect($request->file('document')->getRealPath());
    if (! $info['valid'] || $info['active_content'] !== []) {
        return back()->withErrors(['document' => 'ملف PDF غير صالح.']);
    }

    // اسم عشوائي على قرص خاص؛ لا تعرض $path للمستخدم كرابط عام.
    $path = $request->file('document')->storeAs('scanned-documents/form', Str::ulid().'.pdf', 'local');

    // ... احفظ $path في سجلك مع صلاحيات الوصول المناسبة
}
```

هذا المثال لا يغني عن سياسات الصلاحيات لديك. لاستخدام التحقق الكامل للحزمة في مسارك الخاص استدعِ الخدمة:

```php
use Aam\DocumentScanner\Facades\DocumentScanner;

$session = DocumentScanner::createSession($request->user());
['document' => $doc] = DocumentScanner::store($session, $request->file('document'), ['filename' => $request->input('name')]);
```

## الاحتفاظ والتنظيف

- الجلسات المفتوحة تنتهي بعد `retention.session_ttl_minutes` (120 دقيقة).
- `document-scanner:prune` يحوّلها إلى `expired` ويحذف الجلسات المنتهية/الملغاة دون مستند بعد `retention.prune_sessions_after_hours`.
- في المتصفح: الصفحات في الذاكرة فقط حتى مغادرة الصفحة. في الـ Agent: ملفات المهمة تُحذف بعد جلبها، أو بعد `jobTtlSeconds`، وتُنظَّف عند الإقلاع.
