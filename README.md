# aam/laravel-document-scanner

**العربية** | [English](#english)

مكتبة Laravel لمسح المستندات من ماسحات ضوئية حقيقية عبر برنامج وسيط محلي (Scanner Agent)، ومعاينة الصفحات وترتيبها في المتصفح، وتجميعها في ملف PDF متعدد الصفحات، ثم رفعه إلى Laravel مع تحقق كامل على الخادم.

📘 **دليل التشغيل:** [docs/OPERATING-GUIDE.ar.md](docs/OPERATING-GUIDE.ar.md)

```
[ المتصفح ] ──HTTP على 127.0.0.1──▶ [ Scanner Agent على جهاز المستخدم ] ──▶ [ الماسح ]
     └──HTTPS + جلسة + CSRF──▶ [ Laravel: التحقق والتخزين والصلاحيات ]
```

| المجلد | المحتوى |
|---|---|
| `src/`، `config/`، `routes/`، `lang/`، `resources/` | حزمة Laravel (الجذر هو حزمة Composer) |
| `agent/` | البرنامج الوسيط المحلي (Node.js، بلا اعتمادات npm): Windows.Devices.Scanners، WIA، SANE، محاكي |
| `demo/` | تطبيق Laravel 13 تجريبي |
| `docs/` | الوثائق |

### تثبيت سريع

داخل مجلد مشروع Laravel:

```bash
composer config repositories.document-scanner git https://github.com/aam-laravel/laravel-document-scanner.git
composer require "aam/laravel-document-scanner:~1.0"
php artisan migrate
php artisan document-scanner:secret   # ضع الناتج في DOCUMENT_SCANNER_AGENT_SECRET
php artisan document-scanner:check
```

```blade
<form method="POST" action="{{ route('contracts.store') }}">
    @csrf
    <x-document-scanner name="scanned_document_id" :required="true" />
    <button type="submit">حفظ</button>
</form>
```

### ما اختُبر فعليًا

Laravel 13.37 وPHP 8.3. على Windows 11 مع ماسح Canon MF645C: السطح الزجاجي، ووحدة التغذية بعدة أوراق، والمسح على الوجهين. لم يُختبر Linux/SANE على جهاز حقيقي، وmacOS غير مدعوم. الاختبارات الآلية: 27 لـ PHP، و11 للواجهة، و36 للـ Agent.

### الوثائق

[دليل التشغيل](docs/OPERATING-GUIDE.ar.md) · [التثبيت](docs/installation.md) · [الـ Agent](docs/agent.md) · [عقد الـ API](docs/agent-protocol.md) · [الاستخدام](docs/usage.md) · [الرفع](docs/uploading.md) · [استكشاف الأخطاء](docs/troubleshooting.md) · [الأمان](docs/security.md) · [التطوير](docs/development.md) · [CHANGELOG](CHANGELOG.md)

---

<a id="english"></a>

## English

A Laravel package for scanning documents from physical scanners through a local agent, reviewing and reordering pages in the browser, building a multi-page PDF client-side, and uploading it to Laravel with full server-side validation.

📘 **Operating guide:** [docs/OPERATING-GUIDE.en.md](docs/OPERATING-GUIDE.en.md)

| Folder | Contents |
|---|---|
| `src/`, `config/`, `routes/`, `lang/`, `resources/` | The Laravel package (the repository root is the Composer package) |
| `agent/` | Local agent (Node.js, no npm dependencies): Windows.Devices.Scanners, WIA, SANE, simulator |
| `demo/` | Laravel 13 demo application |
| `docs/` | Documentation (detailed reference in Arabic; operating guide in both languages) |

### Quick start

Inside your Laravel project folder:

```bash
composer config repositories.document-scanner git https://github.com/aam-laravel/laravel-document-scanner.git
composer require "aam/laravel-document-scanner:~1.0"
php artisan migrate
php artisan document-scanner:secret   # put the output in DOCUMENT_SCANNER_AGENT_SECRET
php artisan document-scanner:check
```

```blade
<form method="POST" action="{{ route('contracts.store') }}">
    @csrf
    <x-document-scanner name="scanned_document_id" :required="true" />
    <button type="submit">Save</button>
</form>
```

On the user's PC:

```bash
cd agent
node bin/scanner-agent.js init-config --origin https://app.example.com --secret "<same secret>"
node bin/scanner-agent.js run
```

### Verified

Laravel 13.37 on PHP 8.3. Windows 11 with a Canon MF645C: flatbed, multi-sheet feeder and duplex. Linux/SANE was not tested on real hardware, and macOS is not supported. Automated tests: 27 PHP, 11 browser-client and 36 agent tests.

## License

MIT. No runtime dependencies beyond `illuminate/*` in PHP; the browser UI and the agent use no npm packages.
