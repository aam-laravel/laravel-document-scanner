# التطوير والاختبارات

## بنية المستودع

```
laravel-document-scanner/      جذر المستودع = حزمة Laravel (composer.json)
├── config/  database/  lang/{ar,en}/  routes/
├── resources/views/           مكوّن Blade وصفحة المسح
├── resources/dist/            واجهة المتصفح (ES Modules بلا بناء ولا اعتمادات)
├── src/                       Provider، Controllers، Requests، Policies، Models، Support، Console، Events
├── tests/                     PHPUnit (Unit، Feature) + tests/js (node:test)
├── docs/                      الوثائق (العربية) + دليل التشغيل بالعربية والإنجليزية
├── agent/                     البرنامج الوسيط (Node.js، بلا اعتمادات npm)
│   ├── bin/scanner-agent.js   سطر الأوامر
│   ├── src/                   الخادم، الأمان، المهام، المحوّلات (simulator، wia، sane)
│   ├── scripts/wia.ps1        جسر WIA عبر COM
│   ├── install/               التشغيل التلقائي (Windows، Linux)
│   └── test/                  node:test (وحدات + تكامل HTTP مع المحاكي)
└── demo/                      تطبيق Laravel 13 تجريبي يستخدم الحزمة عبر path repository ("url": "..")
```

## تشغيل بيئة التطوير

```bash
# 1) الحزمة (من جذر المستودع)
composer install

# 2) التطبيق التجريبي
cd demo && cp .env.example .env && composer install && php artisan key:generate && php artisan migrate
# ثم في demo/.env: DOCUMENT_SCANNER_AGENT_SECRET=dev-only-secret-change-me-0123456789abcdef
#                   DOCUMENT_SCANNER_ALLOW_SIMULATOR=true
php artisan serve --port=8000

# 3) الـ Agent (محاكي + WIA)، إعداد يسمح بـ http://localhost:8000 و8001
cd ../agent && node bin/scanner-agent.js run --config config.demo.json
```

افتح `http://localhost:8000/demo/login` (متاح فقط في البيئة المحلية). السر في `demo/.env` قيمة تطوير فقط ويطابق `agent/config.demo.json`.

## الاختبارات

```bash
# الـ Agent: وحدات (الأمان، الإعداد، القدرات، تحليل WIA/SANE، PNG، السجلات) + تكامل HTTP مع المحاكي
cd agent && npm test

# واجهة المتصفح: PDF، مخزن الصفحات، عميل الـ Agent، الرافع، أدوات الصور
node --test "tests/js/*.test.js"   # من جذر المستودع

# Laravel (Testbench): يجب تشغيل اختبارات JS أولًا لأنها تولّد tests/Fixtures/generated-3-pages.pdf
vendor/bin/phpunit
```

اختبار PHP يقرأ ملف PDF الذي أنتجه كاتب PDF في JavaScript، فيتحقق التنفيذان من بعضهما.

### ما تغطيه الاختبارات

| المجال | الاختبارات |
|---|---|
| تسجيل الحزمة | الخدمات، الإعدادات، كل المسارات بأسمائها، `web`/`auth`/`throttle` على الرفع، الأوامر |
| الترجمات والمكوّن | تطابق مفاتيح العربية والإنجليزية، RTL، إخفاء الأسرار، وضعا upload وform-file، الضيف والتعطيل |
| المصادقة والصلاحيات | الضيف 401، Gate 403، CSRF 419 (بإلغاء استثناء بيئة الاختبار)، مستخدم آخر 404/403 |
| الملفات | فارغ، نوع مزيف (PNG باسم PDF)، تالف، محتوى نشط، كبير، عدد صفحات غير مطابق، صفحات كثيرة |
| التخزين | قرص خاص، اسم ULID، SHA-256، فشل القرص (507 بلا سجل ولا حدث)، الحذف |
| منع التكرار | إعادة نفس البايتات = 200 duplicate، بايتات مختلفة = 409 |
| الجلسات | منتهية، ملغاة، التنظيف بـ prune |
| التنزيل | توقيع صالح، غير موقّع، منتهي، مالك آخر |
| الـ Agent | CORS/PNA، DNS rebinding، الاقتران الموقّع والرمزي، Replay، حد المعدل، Flatbed، Duplex، انحشار، إلغاء، مشغول، إعدادات غير مدعومة، عزل المهام بين الجلسات، تنظيف الملفات، صفحة الحالة |
| الواجهة | حالات probe (متصل، غير متوافق، محجوب، متوقف)، إعادة الاقتران، تسليم الصفحات أثناء المسح، عدم إعلان النجاح دون مستند، رموز HTTP |

### اختبارات يدوية شاملة (المتصفح المدمج)

نُفذت على التطبيق التجريبي: حالة «غير مشغّل»، الاتصال، المحاكي (Duplex 3 أوراق = 6 صفحات)، التدوير والترتيب بلوحة المفاتيح والحذف وإعادة المسح والإضافة من Flatbed، PDF بمقاسات مختلفة، الرفع، إرسال النموذج، حارس الحقل المطلوب، انحشار الورق، الإلغاء، فشل الشبكة وإعادة المحاولة بنفس الجلسة، وضع form-file، واجهة JavaScript، الاقتران بالرمز، والماسح الحقيقي (Flatbed وADF).

غير مغطى آليًا: اختبارات واجهة DOM (لا jsdom/Playwright لتجنب الاعتمادات)، اختبارات أداء لمستندات طويلة جدًا، Safari/Firefox، Linux/SANE على جهاز حقيقي.

## إضافة Adapter جديد

نفّذ في `agent/src/adapters/` صنفًا بالواجهة:

```js
class MyAdapter {
  name = 'mine';
  async isAvailable() { return { available: true } }
  async listDevices() { return [{ id: 'mine:<native>', name, manufacturer, adapter: 'mine', simulated: false, status }] }
  async getCapabilities(deviceId) { /* نموذج القدرات في agent-protocol.md */ }
  async scan(deviceId, settings, { outDir, signal, onPage, onProgress }) { /* onPage({file, mime, width, height, dpi, colorMode, side}) */ }
}
```

ثم سجّله في `adapters/index.js` (بادئة المعرّف → اسم المحوّل). لا تُعلن قدرة لم يُعدها التعريف فعلًا.
