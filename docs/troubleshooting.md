# استكشاف الأخطاء

## حالات الـ Agent في الواجهة

| الحالة | المعنى | ما تفعله |
|---|---|---|
| غير مشغّل أو غير مثبّت | لا شيء يستمع على المنفذ | ثبّت الـ Agent وشغّله؛ تحقق من `node bin/scanner-agent.js status` ومن تطابق المنفذ مع `DOCUMENT_SCANNER_AGENT_URL`. |
| يعمل، لكن هذا الموقع غير مسموح | الـ Agent يرد لكن بلا CORS لهذا الأصل | أضف الأصل حرفيًا (المخطط + المضيف + المنفذ) إلى `sites` في إعداد الـ Agent وأعد تشغيله. |
| إصدار غير متوافق | `protocol` مختلف أو `version` < `agent.min_version` | ثبّت الإصدار الأحدث من الـ Agent. |
| تعذّر الاقتران | توكن مرفوض أو رمز خاطئ | تأكد أن `DOCUMENT_SCANNER_AGENT_SECRET` = `pairingSecret` للأصل نفسه، وأن ساعة الجهازين متقاربة (التوكن صالح 60 ثانية). خلف Proxy اضبط `DOCUMENT_SCANNER_ORIGIN`. |
| لم نجد ماسحًا | المحوّل يعمل لكن لا أجهزة | شغّل الماسح ووصّله؛ Windows: `Get-PnpDevice -Class Image`؛ Linux: `scanimage -L`. |

التمييز بين «غير مشغّل» و«غير مسموح» يتم بطلب `no-cors` إضافي: إن نجح فهناك خادم يستمع لكنه رفض الأصل.

## رموز الأخطاء

كل خطأ له `code` ثابت، ورسالة مترجمة، و`action` مقترح أحيانًا، و`correlationId`، وتفاصيل تقنية قابلة للنسخ.

### الـ Agent والاتصال

| الرمز | السبب المعتاد |
|---|---|
| `AGENT_UNREACHABLE` | الـ Agent متوقف/غير مثبت، أو جدار حماية، أو المنفذ مختلف |
| `AGENT_INCOMPATIBLE` | إصدار/بروتوكول غير متوافق |
| `ORIGIN_NOT_ALLOWED` | الأصل غير مدرج في `sites` |
| `HOST_NOT_ALLOWED` | ترويسة Host غير loopback (محاولة DNS rebinding أو Proxy) |
| `PAIRING_REQUIRED` / `SESSION_EXPIRED` | لا جلسة أو انتهت (تُعاد تلقائيًا مرة في وضع signed) |
| `PAIRING_FAILED` | توقيع/أصل/صلاحية التوكن، أو رمز خاطئ (`details.reason`) |
| `AGENT_PAIRING_NOT_CONFIGURED` | السر غير مضبوط على الخادم |
| `RATE_LIMITED`، `REPLAYED_REQUEST`، `INVALID_REQUEST`، `PAYLOAD_TOO_LARGE` | حماية الـ API |

### الجهاز والتعريف

| الرمز | المصدر |
|---|---|
| `ADAPTER_UNAVAILABLE` | لا WinRT/WIA/SANE على هذا النظام، أو تعذّر تشغيل `powershell.exe`/`scanimage` |
| `NO_DEVICES`، `DEVICE_NOT_FOUND` | لا أجهزة / الجهاز اختفى |
| `DEVICE_BUSY` | مهمة أخرى على الجهاز (أو `WIA_ERROR_BUSY`/`DEVICE_LOCKED`) |
| `DEVICE_OFFLINE` | `WIA_ERROR_OFFLINE`، خطأ اتصال، أو SANE «Error during device I/O» |
| `DEVICE_OPEN_FAILED`، `PERMISSION_DENIED` | فشل فتح الجهاز / صلاحيات (Linux: مجموعة `scanner`) |
| `DRIVER_ERROR`، `DRIVER_MISSING` | استثناء في التعريف / مكوّن WIA غير مسجل |
| `UNSUPPORTED_FEATURE`، `UNSUPPORTED_SETTING`، `SOURCE_UNAVAILABLE` | إعداد خارج القدرات المعلنة |
| `FEEDER_EMPTY` | `WIA_ERROR_PAPER_EMPTY` قبل أول صفحة، أو SANE «out of documents» |
| `PAPER_JAM`، `PAPER_FEED_FAILED` | انحشار/فشل تغذية أبلغ عنه الجهاز |
| `COVER_OPEN`، `WARMING_UP`، `HARDWARE_ERROR` | حالات عتادية أبلغ عنها الجهاز؛ `0x8019xxxx` من ماسحات eSCL/الشبكة تعني رمز HTTP من الجهاز (`details.httpStatus`) |
| `SCAN_CANCELLED`، `SCAN_TIMEOUT` | إلغاء المستخدم / تجاوز `scanTimeoutSeconds` |
| `IMAGE_READ_FAILED`، `OUT_OF_MEMORY`، `DISK_FULL`، `TOO_MANY_PAGES`، `JOB_NOT_FOUND`، `INTERNAL_ERROR` | معالجة الصور والموارد |

### المتصفح والخادم

| الرمز | السبب |
|---|---|
| `NO_PAGES` | لا صفحات جاهزة، أو نموذج مطلوب دون مستند |
| `PDF_FAILED`، `PDF_PAGE_MISMATCH` | فشل إنشاء PDF أو التحقق منه |
| `FILE_TOO_LARGE`، `FILE_EMPTY`، `FILE_TYPE_NOT_ALLOWED`، `FILE_CORRUPT`، `FILE_ACTIVE_CONTENT` | تحقق الخادم |
| `NETWORK_ERROR`، `UPLOAD_FAILED` | انقطاع/مهلة/خطأ 5xx؛ الصفحات محفوظة |
| `UNAUTHENTICATED`، `FORBIDDEN`، `CSRF_MISMATCH`، `VALIDATION_FAILED` | الجلسة/الصلاحيات/الحقول |
| `SESSION_CLOSED`، `SESSION_EXPIRED` | جلسة رفع مغلقة أو منتهية (تُنشأ جلسة جديدة تلقائيًا عند الرفع) |
| `STORAGE_FAILED`، `DOCUMENT_MISSING` | فشل القرص / ملف مفقود |
| `OCR_FAILED` | محجوز؛ OCR غير منفّذ |

## التشخيص

- **في المتصفح**: «نسخ تقرير التشخيص» أسفل الواجهة ينسخ JSON يضم: حالة الـ Agent وصحته، تشخيص الـ Agent (إن كان مقترنًا)، المصادر، حالة الصفحات (دون صور)، وآخر 30 خطأ مع `correlationId`. لا يحتوي على توكنات أو جلسات أو صور.
- **في الـ Agent**: `node bin/scanner-agent.js diagnose` (السر محذوف)، والسجل في المسار المذكور في [agent.md](agent.md).
- **في Laravel**: السجلات تحمل البادئة `[document-scanner]` و`correlation_id`. ابحث بالـ `correlationId` الظاهر في تفاصيل الخطأ لتتبع العملية في المتصفح والـ Agent والخادم.
- لا تُعرض Stack Traces للمستخدم: أخطاء الحزمة JSON بصيغة ثابتة. أبقِ `APP_DEBUG=false` في الإنتاج.

## مشكلات معروفة

- **المتصفحات**: صفحة HTTPS تستدعي `http://127.0.0.1` مسموح في Chrome/Edge/Firefox لأن loopback يُعد «موثوقًا محتملًا». إصدارات Chrome الحديثة قد تعرض طلب إذن «الوصول إلى الشبكة المحلية» (Local Network Access) أول مرة: يجب على المستخدم السماح. Safari لم يُختبر وقد يحجب الطلب. لا تطلب من المستخدم تعطيل أي حماية.
- **قدرات التعريف**: مثال حقيقي: Canon MF645C عبر تعريف eSCL يعرض 300 dpi فقط وألوانًا (ملوّن/رمادي) بلا سطوع/تباين، عبر المحوّلين كليهما. لخيارات أوسع ثبّت تعريف الشركة المصنّعة.
- **صفحة واحدة فقط من وحدة التغذية مع محوّل `wia`** (مُشخّص على Canon MF645C بتعريف eSCL): الجهاز يمسح الرزمة كلها في مهمة واحدة، لكن مكتبة WIA 1.0 Automation تسلّم أول صورة فقط، وطلب الصفحة التالية يبدأ مهمة جديدة يرفضها الجهاز بـ HTTP 500 (`0x801901F4`)، وقد يبقى بعدها في حالة خطأ يرفض حتى المسح من السطح الزجاجي حتى تُعالَج من لوحته. التعريف يرفض أيضًا `Pages ≠ 1`. **الحل**: محوّل `winrt` (الافتراضي الآن) يعيد كل صفحات المهمة. إن ظهر HTTP 500 مع `winrt` فافحص شاشة الماسح (انحشار أو مهمة عالقة) أو أعد تشغيله.
- **الإلغاء على WIA**: يوقف عملية الـ Agent، لكن الماسح قد يُكمل سحب الورقة الحالية فيزيائيًا.
- **تحويل BMP→PNG**: بعض التعريفات تسلّم BMP فقط؛ يحوّله الـ Agent إلى PNG عبر `System.Drawing`. إن فشل التحويل تُرسل BMP (أكبر حجمًا) ويُسجَّل تحذير.
