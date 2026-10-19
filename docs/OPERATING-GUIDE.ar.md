# دليل التشغيل — aam/laravel-document-scanner

[English version](OPERATING-GUIDE.en.md)

هذا الدليل يجمع خطوات التشغيل العملية من البداية إلى النهاية. التفاصيل الكاملة في بقية ملفات `docs/`.

---

## 1. كيف تعمل المنظومة

```
[ المتصفح: واجهة المكتبة ] ──HTTP على 127.0.0.1──▶ [ Scanner Agent على جهاز المستخدم ] ──WinRT/WIA/SANE──▶ [ الماسح ]
            │
            └──HTTPS + جلسة + CSRF──▶ [ Laravel: جلسات الرفع، التحقق، التخزين، الصلاحيات ]
```

| المكوّن | أين يعمل | دوره |
|---|---|---|
| حزمة Laravel | الخادم | المسارات، التحقق من الملفات، التخزين الخاص، الصلاحيات، توقيع توكن الاقتران |
| واجهة المتصفح | صفحة التطبيق | فحص الـ Agent، اختيار الإعدادات، معاينة الصفحات وترتيبها، إنشاء PDF، الرفع |
| Scanner Agent | جهاز كل مستخدم لديه ماسح | الوصول إلى الماسح عبر نظام التشغيل |

الخادم لا يتصل بالـ Agent أبدًا، فالمتصفح هو من يتصل به. لذلك يعمل الحل حتى لو كان Laravel على خادم بعيد.

## 2. المتطلبات

| المكوّن | المتطلب |
|---|---|
| الخادم | PHP ‎8.2+‎، Laravel 11 أو 12 أو 13، امتداد `fileinfo`، HTTPS في الإنتاج |
| جهاز المستخدم | Node.js ‎20.10+‎ |
| Windows 10/11 | تعريف WIA للماسح، وWindows PowerShell 5.1 (مدمج) |
| Linux | `sane-utils` (`scanimage -L` يعرض الجهاز) |
| المتصفح | Chrome أو Edge حديث |

ما اختُبر فعليًا: Laravel 13.37 وPHP 8.3، وWindows 11 مع ماسح Canon MF645C (السطح الزجاجي، ووحدة التغذية بعدة أوراق، والوجهان). لم يُختبر Linux على جهاز حقيقي، وmacOS غير مدعوم.

## 3. تثبيت الحزمة في مشروع Laravel

نفّذ الأوامر التالية **داخل مجلد مشروع Laravel** (حيث يوجد `composer.json` و`artisan`).

**1) عرّف مستودع الحزمة** (الحزمة غير منشورة على Packagist، فلا يجدها Composer دون هذه الخطوة). النوع `git` مع رابط HTTPS لا يحتاج GitHub API ولا مفاتيح SSH:

```bash
composer config repositories.document-scanner git https://github.com/aam-laravel/laravel-document-scanner.git
```

**2) ثبّت وانشر وشغّل الترحيل:**

```bash
composer require "aam/laravel-document-scanner:~1.0"
php artisan vendor:publish --tag=document-scanner-config
php artisan migrate
```

**3) ولّد سر الاقتران:**

```bash
php artisan document-scanner:secret
```

**4) أضف إلى `.env`:**

```dotenv
DOCUMENT_SCANNER_AGENT_SECRET=<الناتج من الخطوة 3>
DOCUMENT_SCANNER_AGENT_URL=http://127.0.0.1:47115
DOCUMENT_SCANNER_DISK=local
DOCUMENT_SCANNER_AGENT_DOWNLOAD_URL=     # رابط حقيقي لحزمة الـ Agent عند نشرها
```

**5) افحص التثبيت:**

```bash
php artisan document-scanner:check
```

**6) جدولة التنظيف (في `routes/console.php`):**

```php
Schedule::command('document-scanner:prune')->hourly();
```

> تأكد أن `upload_max_filesize` و`post_max_size` في PHP لا يقلان عن الحد الأقصى للملف (20 MB افتراضيًا).

> **ملاحظة Windows:** استخدم `~1.0` لا `^1.0`. في PowerShell يُحذف الرمز `^` قبل وصوله إلى Composer (لأن `composer.bat` يمر عبر cmd)، فيصبح القيد `1.0` ويظهر تحذير «appears too strict». القيدان متكافئان: كلاهما يعني أي إصدار 1.x.

## 4. تثبيت الـ Agent على جهاز المستخدم

انسخ مجلد `agent/` من هذا المستودع إلى الجهاز، ثم:

```bash
cd agent
node bin/scanner-agent.js init-config --origin https://app.example.com --secret "<نفس DOCUMENT_SCANNER_AGENT_SECRET>"
node bin/scanner-agent.js diagnose     # يجب أن يظهر الماسح
node bin/scanner-agent.js run
```

- `--origin`: عنوان موقعك كما يظهر في المتصفح بالضبط (المخطط + النطاق + المنفذ إن وجد).
- يعمل الـ Agent على `127.0.0.1:47115` فقط، ولا يقبل إلا المواقع المذكورة في إعداده.

**التشغيل التلقائي على Windows** (يطلب موافقتك ولا يحتاج صلاحيات مسؤول):

```powershell
powershell -ExecutionPolicy Bypass -File agent\install\windows\install-autostart.ps1
powershell -ExecutionPolicy Bypass -File agent\install\windows\agent-control.ps1 status
powershell -ExecutionPolicy Bypass -File agent\install\windows\uninstall-autostart.ps1
```

**على Linux:**

```bash
./agent/install/linux/install.sh          # خدمة systemd للمستخدم
./agent/install/linux/install.sh --uninstall
```

## 5. الاستخدام داخل أي فورم

### الطريقة A (الموصى بها): المكتبة ترفع الملف، والفورم يرسل المعرّف

```blade
<form method="POST" action="{{ route('contracts.store') }}">
    @csrf
    <input name="title" required>
    <x-document-scanner name="scanned_document_id" :required="true" />
    <button type="submit">حفظ</button>
</form>
```

بعد المسح والضغط على «رفع إلى الخادم» يتحقق الخادم من الملف ويخزّنه، ثم يُكتب معرّف المستند في الحقل المخفي `scanned_document_id`.

```php
use Aam\DocumentScanner\Models\ScannedDocument;

public function store(Request $request)
{
    $data = $request->validate([
        'title' => ['required', 'string', 'max:150'],
        'scanned_document_id' => ['required', 'ulid'],
    ]);

    // تحقّق دائمًا من أن المستند يخص المستخدم الحالي
    $document = ScannedDocument::query()
        ->ownedBy($request->user())
        ->findOrFail($data['scanned_document_id']);

    Contract::create(['title' => $data['title'], 'scanned_document_id' => $document->id]);
}
```

### الطريقة B: الملف نفسه يُرسل مع الفورم

```blade
<form method="POST" action="{{ route('documents.store') }}" enctype="multipart/form-data">
    @csrf
    <x-document-scanner name="document" output="form-file" :required="true" />
    <button type="submit">إرسال</button>
</form>
```

```php
use Aam\DocumentScanner\Support\PdfInspector;
use Illuminate\Support\Str;

public function store(Request $request, PdfInspector $inspector)
{
    $request->validate(['document' => ['required', 'file', 'mimetypes:application/pdf', 'max:20480']]);

    $info = $inspector->inspect($request->file('document')->getRealPath());
    abort_unless($info['valid'] && $info['active_content'] === [], 422);

    $path = $request->file('document')->storeAs('scanned-documents', Str::ulid().'.pdf', 'local');
}
```

### خيارات المكوّن

| الخيار | الوظيفة |
|---|---|
| `name` | اسم الحقل في الفورم |
| `output` | `upload` (افتراضي) أو `form-file` |
| `:required` | يمنع الإرسال قبل وجود مستند |
| `title` و`category` | بيانات وصفية تُحفظ مع المستند |
| `:max-pages` | حد أقصى للصفحات أقل من حد الإعدادات |

### عبر JavaScript

```html
<div id="scanner"></div>
<script type="module">
  import '/document-scanner/assets/document-scanner.js';
  const el = document.getElementById('scanner');
  el.addEventListener('document-scanner:uploaded', (e) => console.log(e.detail.document.id));
  await window.DocumentScanner.mountFromUrl(el, '/document-scanner/config', { output: 'upload', name: 'scanned_document_id' });
</script>
```

## 6. تجربة المستخدم خطوة بخطوة

1. يفتح المستخدم الصفحة، فتظهر حالة البرنامج «متصل» وقائمة الماسحات.
2. يختار الماسح ومصدر الورق (السطح الزجاجي، أو وحدة التغذية بوجه واحد أو بالوجهين) والألوان والدقة والمقاس. القوائم تعرض ما يدعمه الجهاز فعلًا.
3. يضغط «مسح»، فتظهر الصفحات صورًا مصغرة.
4. يستطيع التدوير، وإعادة الترتيب (بالسحب أو بالأزرار أو `Alt+↑/↓`)، والحذف، وإعادة مسح صفحة، وإضافة صفحات.
5. يضغط «رفع إلى الخادم». لا تظهر رسالة النجاح إلا بعد رد الخادم الناجح، وعند الفشل تبقى الصفحات وتظهر «إعادة المحاولة».

## 7. المشكلات الشائعة

| ما يظهر | الحل |
|---|---|
| «غير مشغّل أو غير مثبّت» | شغّل الـ Agent: `node bin/scanner-agent.js status` |
| «يعمل، لكن هذا الموقع غير مسموح» | أضف عنوان الموقع حرفيًا إلى `sites` في إعداد الـ Agent وأعد تشغيله |
| «تعذّر الاقتران» | تطابق `DOCUMENT_SCANNER_AGENT_SECRET` مع `pairingSecret`، وتقارب ساعة الجهازين |
| «لم نجد ماسحًا» | شغّل الماسح ووصّله؛ Windows: `Get-PnpDevice -Class Image` |
| `HARDWARE_ERROR` مع HTTP 500 | افحص شاشة الماسح (انحشار أو مهمة عالقة) أو أعد تشغيله |
| Chrome يطلب إذن «الشبكة المحلية» | اسمح به، فهو مطلوب للوصول إلى 127.0.0.1 |
| Composer: `could not be found in any version` | نفّذ الأمر داخل مجلد المشروع، وعرّف المستودع أولًا (الخطوة 1 في القسم 3) |
| Composer: `The "1.0" constraint ... appears too strict` | PowerShell حذف `^`؛ استخدم `~1.0` |
| Composer: `Host key verification failed` / `git@github.com` | المستودع معرّف بالنوع `vcs` وتجاوزت حد GitHub API؛ أعد تعريفه بالنوع `git` كما في الخطوة 1 |

زر «نسخ تقرير التشخيص» أسفل الواجهة ينسخ تقريرًا خاليًا من الأسرار، ومعرّف `correlationId` يربط الخطأ بين المتصفح والـ Agent والخادم. القائمة الكاملة في [troubleshooting.md](troubleshooting.md).

## 8. قبل الإنتاج

- [ ] HTTPS، و`APP_DEBUG=false`، و`php artisan document-scanner:check` بلا أخطاء.
- [ ] سر اقتران عشوائي يُوزَّع إلى الأجهزة بقناة آمنة.
- [ ] `sites` في الـ Agent تحتوي عنوان الإنتاج فقط، و`DOCUMENT_SCANNER_ALLOW_SIMULATOR=false`.
- [ ] قرص تخزين خاص.
- [ ] حزمة Agent موقّعة ورابط تنزيل رسمي في `DOCUMENT_SCANNER_AGENT_DOWNLOAD_URL`.

## 9. الوثائق التفصيلية

[installation.md](installation.md) · [agent.md](agent.md) · [agent-protocol.md](agent-protocol.md) · [usage.md](usage.md) · [uploading.md](uploading.md) · [troubleshooting.md](troubleshooting.md) · [security.md](security.md) · [development.md](development.md)
