# الاستخدام والتضمين

## 1. مكوّن Blade

```blade
<x-document-scanner
    name="scanned_document_id"   {{-- اسم الحقل في النموذج --}}
    output="upload"              {{-- upload | form-file --}}
    :required="true"             {{-- يمنع إرسال النموذج قبل وجود مستند --}}
    title="عقد"                  {{-- اختياري: يُحفظ في metadata.title وفي عنوان PDF --}}
    category="contracts"         {{-- اختياري: metadata.category --}}
    :max-pages="20"              {{-- اختياري: حد أدنى من حد الإعدادات --}}
/>
```

المكوّن يعرض الواجهة كاملة (حالة الـ Agent، الأجهزة، الإعدادات، الصفحات، PDF، الرفع)، ويضبط الاتجاه تلقائيًا (RTL للعربية). يُعرض إشعار «المسح الضوئي غير متاح» إذا كان المستخدم غير مسجّل أو الميزة معطلة.

### الوضع A: `output="upload"` (الافتراضي)

الواجهة ترفع PDF إلى مسار الحزمة، وبعد **رد الخادم الناجح فقط** تضع معرّف المستند (ULID) في `<input type="hidden" name="scanned_document_id">`. النموذج يرسل المعرّف لا الملف.

```blade
<form method="POST" action="{{ route('documents.store') }}">
    @csrf
    <input name="subject" required>
    <x-document-scanner name="scanned_document_id" :required="true" />
    <button type="submit">حفظ</button>
</form>
```

```php
use Aam\DocumentScanner\Models\ScannedDocument;

public function store(Request $request)
{
    $data = $request->validate([
        'subject' => ['required', 'string', 'max:150'],
        'scanned_document_id' => ['required', 'ulid'],
    ]);

    // لا تثق بالمعرّف القادم من المتصفح: تحقق من الملكية.
    $document = ScannedDocument::query()->ownedBy($request->user())->findOrFail($data['scanned_document_id']);

    // اربطه بسجلك، مثلًا: $contract->scanned_document_id = $document->id;
}
```

### الوضع B: `output="form-file"`

الواجهة تنشئ PDF وتضعه في `<input type="file" name="document">` حقيقي (عبر `DataTransfer`)، فيُرسل مع النموذج كأي رفع عادي. لا يُستدعى مسار الرفع في الحزمة. يلزم `enctype="multipart/form-data"`:

```blade
<form method="POST" action="{{ route('documents.store-file') }}" enctype="multipart/form-data">
    @csrf
    <x-document-scanner name="document" output="form-file" :required="true" />
    <button type="submit">إرسال</button>
</form>
```

مثال الاستقبال في [uploading.md](uploading.md#الوضع-b).

## 2. واجهة JavaScript

الوحدة `document-scanner.js` (ES Module) تُركّب تلقائيًا كل عنصر يحمل `data-document-scanner`، وتوفّر `window.DocumentScanner`:

```html
<link rel="stylesheet" href="{{ route('document-scanner.assets', 'document-scanner.css') }}">
<div id="scanner"></div>
<script type="module">
  import '{{ route('document-scanner.assets', 'document-scanner.js') }}';

  const el = document.getElementById('scanner');
  el.addEventListener('document-scanner:uploaded', (e) => console.log(e.detail.document.id));
  el.addEventListener('document-scanner:error', (e) => console.warn(e.detail.code));

  // يجلب الإعداد غير السري من الخادم (مصادقة الجلسة) ثم يركّب الواجهة
  await window.DocumentScanner.mountFromUrl(el, '{{ route('document-scanner.config') }}', {
    output: 'upload', name: 'scanned_document_id', title: 'JS', maxPages: 10,
  });
</script>
```

| الدالة | الوصف |
|---|---|
| `DocumentScanner.mount(el, {config, options})` | تركيب بإعداد جاهز |
| `DocumentScanner.mountFromUrl(el, url, options)` | جلب `config` ثم التركيب |
| `DocumentScanner.instance(el)` | الوصول إلى المثيل (لأغراض متقدمة/اختبار) |
| `DocumentScanner.autoMount()` | إعادة البحث عن عناصر جديدة |

الأحداث (CustomEvent تنتشر للأعلى):

| الحدث | `detail` |
|---|---|
| `document-scanner:uploaded` | `{document: {id, filename, mimeType, size, pages, sha256, metadata, createdAt, downloadUrl}}` |
| `document-scanner:attached` | `{pages, size}` (وضع form-file) |
| `document-scanner:error` | `{code}` عند فشل الرفع |

`downloadUrl` رابط موقّع مؤقت (10 دقائق افتراضيًا) **ويتطلب أيضًا** أن يكون المستخدم هو المالك.

## 3. الاستخدام في صفحة أخرى داخل التطبيق

أي صفحة في **نفس أصل** تطبيق Laravel تستطيع تركيب الماسح (الوضعان أعلاه). شروط ذلك:

- المستخدم مسجّل الدخول (المسارات خلف `web` + `auth`).
- أصل الصفحة مضاف إلى `sites` في إعداد الـ Agent على جهاز المستخدم.

**التضمين في موقع خارجي (أصل مختلف)** غير مدعوم افتراضيًا: مسارات الحزمة تعتمد على كوكي الجلسة وCSRF وليست مهيأة لـ CORS. لو احتجت ذلك فأضف الأصل الخارجي صراحة إلى `sites` في الـ Agent، ووفّر في تطبيقك مسارًا مصادقًا عليه (مثلًا Sanctum) لإصدار توكن الاقتران والرفع، ولا تضع `*` في أي إعداد CORS.

## 4. ما يعرضه الماسح وما لا يعرضه

- القوائم (المصادر، الألوان، الدقة، المقاسات) تأتي من قدرات الجهاز الفعلية لكل مصدر.
- عنصر غير مدعوم يُعطَّل مع السبب (مثل «غير قابل للضبط في هذا الماسح»).
- «أبيض وأسود (يُحوَّل بعد المسح)» يظهر فقط عندما لا يدعم الجهاز هذا النمط؛ وهو تحويل برمجي في المتصفح وليس نمطًا عتاديًا.
- الدقة فوق `limits.warn_dpi` تُظهر تحذيرًا؛ الدقة فوق `limits.max_dpi` لا تُعرض. لا تُخفَّض الدقة تلقائيًا؛ الصور التي تتجاوز `pdf.max_image_pixels` تُرفض برسالة واضحة.
- «تبدو فارغة» اقتراح فقط؛ الحذف يتطلب تأكيدًا.

## 5. إدارة الصفحات ولوحة المفاتيح

- كل صورة مصغرة زر قابل للتركيز؛ `Alt+↑` و`Alt+↓` لإعادة الترتيب، إضافة إلى أزرار النقل والسحب والإفلات.
- أدوات لكل صفحة: تدوير يسار/يمين، نقل، إعادة مسح الصفحة (تستبدلها في مكانها)، حذف (بتأكيد)، وإعادة محاولة جلب صفحة فشل تنزيلها من الـ Agent.
- المعاينة: تكبير/تصغير/ملاءمة، مع الأبعاد والدقة والحجم.
- الصور تبقى في ذاكرة الصفحة فقط (لا `localStorage`)، وتُحرَّر عند مغادرة الصفحة. يطلب المتصفح تأكيدًا قبل المغادرة إن وُجدت صفحات غير مرفوعة.

## 6. ما لم يُنفّذ

- **OCR**: غير منفّذ. لا يُرسل أي شيء لخدمات خارجية. يمكن إضافته عبر مستمع لحدث `DocumentUploaded` ووظيفة Queue (مثل Tesseract مع حزمة اللغة العربية `ara`)، مع إبقاء فشل OCR منفصلًا عن PDF الأصلي.
- تصحيح الميل (Deskew) وقص الحواف التلقائي وكشف التكرار: غير منفّذة.
- ملفات تعريف الإعدادات المحفوظة (Profiles)، PDF/A، استئناف الرفع المجزأ: مؤجلة (انظر CHANGELOG).
