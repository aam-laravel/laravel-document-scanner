# التثبيت

## 1. حزمة Laravel

### من GitHub أو مسار محلي

```json
// composer.json في تطبيقك
"repositories": [
    { "type": "path", "url": "../laravel-document-scanner", "options": { "symlink": true } }
]
```

أو من GitHub:

```json
"repositories": [
    { "type": "vcs", "url": "https://github.com/aam-laravel/laravel-document-scanner" }
]
```

ثم:

```bash
composer require "aam/laravel-document-scanner:dev-main"   # أو رقم إصدار بعد وسم المستودع (git tag v1.0.0)
```

يُسجَّل `DocumentScannerServiceProvider` والواجهة `DocumentScanner` تلقائيًا (Package Discovery). إن عطّلت الاكتشاف، أضف المزوّد يدويًا إلى `bootstrap/providers.php`:

```php
Aam\DocumentScanner\DocumentScannerServiceProvider::class,
```

### نشر الملفات

| الأمر | ما ينشره |
|---|---|
| `php artisan vendor:publish --tag=document-scanner-config` | `config/document-scanner.php` |
| `php artisan vendor:publish --tag=document-scanner-migrations` | ملف الترحيل (اختياري؛ يُحمَّل تلقائيًا دون نشر) |
| `php artisan vendor:publish --tag=document-scanner-lang` | الترجمات `lang/vendor/document-scanner/{ar,en}` |
| `php artisan vendor:publish --tag=document-scanner-views` | قوالب Blade للتخصيص |
| `php artisan vendor:publish --tag=document-scanner-assets` | ملفات JS/CSS إلى `public/vendor/document-scanner` (اختياري) |

```bash
php artisan migrate
```

ينشئ الترحيل جدولين:

- `document_scanner_sessions`: جلسة رفع لكل عملية مسح، مملوكة لمستخدم، وتعمل مفتاحَ منع التكرار (Idempotency).
- `document_scanner_documents`: المستندات المخزّنة (القرص، المسار الداخلي، الاسم المنقّى، الحجم، عدد الصفحات، SHA-256).

### متغيرات `.env`

| المتغير | الافتراضي | الشرح |
|---|---|---|
| `DOCUMENT_SCANNER_ENABLED` | `true` | تعطيل الميزة كلها (المسارات تعيد 404). |
| `DOCUMENT_SCANNER_AGENT_URL` | `http://127.0.0.1:47115` | عنوان الـ Agent كما يراه **متصفح المستخدم**. يجب أن يكون loopback. |
| `DOCUMENT_SCANNER_PAIRING_MODE` | `signed` | `signed` (توكن يوقّعه Laravel) أو `code` (رمز يظهر للمستخدم على صفحة الـ Agent). |
| `DOCUMENT_SCANNER_AGENT_SECRET` | — | سر HMAC المشترك مع الـ Agent (32 حرفًا على الأقل). لا يُرسل إلى المتصفح أبدًا. |
| `DOCUMENT_SCANNER_ORIGIN` | — | الأصل الذي يراه الـ Agent إن اختلف عن أصل الطلب (خلف Proxy). |
| `DOCUMENT_SCANNER_AGENT_DOWNLOAD_URL` | — | رابط تنزيل حقيقي للـ Agent. إن تُرك فارغًا تقول الواجهة إنه لا يوجد تنزيل منشور بعد. |
| `DOCUMENT_SCANNER_AGENT_HELP_URL` | — | صفحة تعليمات التثبيت لديكم. |
| `DOCUMENT_SCANNER_ALLOW_SIMULATOR` | `false` | إظهار أجهزة المحاكي. اتركه `false` في الإنتاج. |
| `DOCUMENT_SCANNER_DISK` | `local` | قرص Laravel للتخزين (خاص افتراضيًا). |
| `DOCUMENT_SCANNER_MAX_KB` | `20480` | الحد الأقصى للملف بالكيلوبايت. |
| `DOCUMENT_SCANNER_MAX_PAGES` | `100` | الحد الأقصى للصفحات. |
| `DOCUMENT_SCANNER_ROUTE_PREFIX` | `document-scanner` | بادئة المسارات. |
| `DOCUMENT_SCANNER_LOG_CHANNEL` | — | قناة السجل (الافتراضية إن تُرك فارغًا). |

بقية الخيارات (المهل، جودة JPEG في PDF، كشف الصفحات الفارغة، الاحتفاظ، حدود المعدل) في `config/document-scanner.php` مع شرح لكل خيار.

> تأكد أن `upload_max_filesize` و`post_max_size` في PHP لا يقلان عن `DOCUMENT_SCANNER_MAX_KB`. الأمر `document-scanner:check` ينبّهك.

### التحقق

```bash
php artisan document-scanner:check
```

يفحص: السر، عنوان loopback، قابلية الكتابة على القرص وخصوصيته، الترحيل، المسارات، وجود `web` و`auth`، و`APP_DEBUG`/HTTPS في الإنتاج. **لا يستطيع** فحص الـ Agent لأن الـ Agent على جهاز المستخدم؛ الفحص يجري من صفحة المسح في المتصفح.

### المهام المجدولة

```php
// routes/console.php
use Illuminate\Support\Facades\Schedule;

Schedule::command('document-scanner:prune')->hourly();
```

يُنهي الجلسات المنتهية ويحذف الجلسات الملغاة/المنتهية دون مستند بعد مدة الاحتفاظ. لا يحذف المستندات المخزّنة.

## 2. الـ Agent على جهاز المستخدم

مختصر (التفاصيل في [agent.md](agent.md)):

```bash
cd agent
node bin/scanner-agent.js init-config --origin https://app.example.com --secret "<DOCUMENT_SCANNER_AGENT_SECRET>"
node bin/scanner-agent.js diagnose
node bin/scanner-agent.js run
```

ولتشغيله تلقائيًا عند تسجيل الدخول على Windows (دون صلاحيات مسؤول، ويطلب موافقتك):

```powershell
powershell -ExecutionPolicy Bypass -File agent\install\windows\install-autostart.ps1
```

## 3. التحقق من البداية إلى النهاية

1. افتح `/document-scanner` بعد تسجيل الدخول.
2. يجب أن تظهر حالة «متصل (الإصدار 1.0.0)» وقائمة الماسحات.
3. امسح صفحة، أنشئ PDF، ثم ارفعه. تظهر رسالة النجاح ورابط «فتح المستند» فقط بعد رد الخادم الناجح.

---

**English:** install via Composer (path/VCS repository), run migrations, set `DOCUMENT_SCANNER_AGENT_SECRET` (same value as the agent's `sites[].pairingSecret`), run `document-scanner:check`, schedule `document-scanner:prune`. The server never contacts the agent; the browser does.
