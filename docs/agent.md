# البرنامج الوسيط المحلي (Scanner Agent)

الـ Agent برنامج Node.js مستقل عن Laravel (مجلد `agent/` في هذا المستودع) يعمل على جهاز المستخدم، ويستمع على `127.0.0.1` فقط، ويتصل بالماسح عبر واجهة نظام التشغيل.

## لماذا Node.js وWIA؟

| الخيار | التقييم |
|---|---|
| **Windows.Devices.Scanners (Windows 10/11)** | واجهة WinRT المبنية على WIA 2.0 (التي يستخدمها تطبيق Windows Scan)، تُستدعى من PowerShell 5.1 المدمج. تعيد **كل صفحات** مهمة وحدة التغذية، وتعلن مقاسات الورق التي يدعمها التعريف للتغذية. **المحوّل الافتراضي على Windows (`winrt`).** |
| WIA 1.0 Automation (`wiaaut.dll`) | محوّل احتياطي (`wia`). يعرض خيارات WIA 1.0 فقط، ومع تعريفات eSCL لا يسلّم إلا الصفحة الأولى من مهمة التغذية (انظر troubleshooting). |
| TWAIN (Windows) | يحتاج Data Source Manager بمعماريتي 32/64 بت وربطًا أصليًا (C/C++ أو .NET)، وكثير من تعريفاته تعرض واجهتها الخاصة. لم يُنفّذ؛ يمكن إضافته Adapter مستقبلًا. |
| SANE (Linux) | الواجهة القياسية؛ نُفّذ Adapter عبر `scanimage`. |
| macOS (ImageCaptureCore) | يحتاج Swift/Objective-C. **غير منفّذ وغير مدعوم.** |
| .NET / Go / Rust | غير مثبتة في بيئة البناء هذه؛ Node متوفر ولا يحتاج أي حزمة npm (وحدات مدمجة فقط)، فلا مخاطر سلسلة توريد. |

القيود: كل عملية تمر عبر `powershell.exe` (Windows PowerShell 5.1، لا PowerShell 7) بتكلفة إقلاع ~1-2 ثانية. في محوّل `winrt` تُسلَّم صفحات وحدة التغذية عند انتهاء المهمة (يظهر عدّاد التقدم أثناءها)، وإن فشلت المهمة في منتصفها تُسلَّم الصفحات المكتوبة قبل الخطأ. ترتيب الوجه/الظهر في Duplex متناوب كما يسلّمه التعريف (نجح على Canon MF645C).

## المتطلبات

- Node.js ‎20.10+‎ (`node --version`).
- Windows: خدمة «Windows Image Acquisition (WIA)» تعمل، وتعريف WIA للماسح (`Get-PnpDevice -Class Image`).
- Linux: `sudo apt install sane-utils` (أو ما يعادله)، وعضوية المستخدم في مجموعة `scanner`/`lp` حسب التوزيعة، و`scanimage -L` يعرض الجهاز.

## الإعداد

ملف الإعداد (JSON) في:

- Windows: `%APPDATA%\DocumentScannerAgent\config.json`
- Linux: `~/.config/document-scanner-agent/config.json`

أنشئه بالأمر (لا يكتب فوق ملف موجود إلا مع `--force`):

```bash
node bin/scanner-agent.js init-config --origin https://app.example.com --secret "<نفس DOCUMENT_SCANNER_AGENT_SECRET>"
```

مثال كامل (`config.example.json`):

```json
{
  "port": 47115,
  "adapters": ["auto"],
  "pairingMode": "signed",
  "sites": [{ "origin": "https://app.example.com", "pairingSecret": "..." }],
  "sessionTtlSeconds": 1800,
  "jobTtlSeconds": 900,
  "scanTimeoutSeconds": 600,
  "maxPagesPerJob": 200,
  "logLevel": "info"
}
```

| المفتاح | الشرح |
|---|---|
| `port` | منفذ loopback (1024-65535). يجب أن يطابق `DOCUMENT_SCANNER_AGENT_URL`. |
| `adapters` | `auto` (`winrt` على Windows، `sane` على Linux)، أو `winrt`، `wia`، `sane`، `simulator`. المحاكي لا يُفعّل إلا صراحة. |
| `pairingMode` | `signed` أو `code`. |
| `sites` | الأصول المسموح بها حرفيًا (`https://host[:port]`). لا يُقبل `*`، ولا `http` إلا لـ `localhost`/`.test`. |
| `logFile` | غير محدد = المسار الافتراضي، `null` = بلا ملف. |

سجل التشغيل: `%LOCALAPPDATA%\DocumentScannerAgent\logs\agent.log` (Windows) أو `~/.local/state/document-scanner-agent/agent.log`، بتدوير عند 1 ميغابايت (3 نسخ). لا يُسجَّل محتوى الصور ولا التوكنات ولا رموز الاقتران.

## أوامر سطر الأوامر

```bash
node bin/scanner-agent.js run                 # تشغيل في المقدمة
node bin/scanner-agent.js status              # فحص /v1/health لنسخة تعمل
node bin/scanner-agent.js devices             # الأجهزة المكتشفة
node bin/scanner-agent.js caps "<deviceId>"   # القدرات كما أعادها التعريف
node bin/scanner-agent.js test-scan "<deviceId>" --source flatbed --dpi 300 --color gray --paper a4 --out ./out
node bin/scanner-agent.js diagnose            # تقرير تشخيص منقّح (بلا أسرار)
node bin/scanner-agent.js gen-secret
node bin/scanner-agent.js version
```

خيارات عامة: `--config <file>`، `--adapter <name>` (قابل للتكرار)، `--port <n>`.

وضع المحاكي للتطوير:

```bash
node bin/scanner-agent.js run --adapter simulator --config ./config.example.json
```

## التشغيل التلقائي

### Windows (مهمة مجدولة للمستخدم، بلا صلاحيات مسؤول)

```powershell
# تثبيت (يعرض ما سيفعله ويطلب الموافقة؛ -Yes لتجاوز السؤال)
powershell -ExecutionPolicy Bypass -File install\windows\install-autostart.ps1
# تحكم
powershell -ExecutionPolicy Bypass -File install\windows\agent-control.ps1 status   # start | stop | restart | status
# إزالة (-RemoveData يحذف الإعداد والسجلات)
powershell -ExecutionPolicy Bypass -File install\windows\uninstall-autostart.ps1
```

المهمة `DocumentScannerAgent` تعمل عند تسجيل الدخول، بنافذة مخفية، وبصلاحيات المستخدم العادية (`RunLevel Limited`)، وتُعاد تلقائيًا 3 مرات عند التعطل. قد تظهر نافذة PowerShell لجزء من الثانية عند تسجيل الدخول.

> لم تُختبر سكربتات التثبيت التلقائي فعليًا في هذه الجلسة (تُنشئ تغييرات دائمة في النظام وتتطلب موافقتك).

### Linux (خدمة systemd للمستخدم)

```bash
./install/linux/install.sh            # ينسخ إلى ~/.local/share/document-scanner-agent ويفعّل الخدمة
systemctl --user status document-scanner-agent
./install/linux/install.sh --uninstall
```

> غير مختبر على Linux في هذه الجلسة.

## التحديث

لا يوجد تحديث تلقائي. للتحديث: أوقف الخدمة، استبدل مجلد الـ Agent بالإصدار الجديد، ثم شغّلها. قاعدة التوافق: الحزمة ترفض الـ Agent إذا اختلف `protocol` أو كان `version` أقل من `agent.min_version` في إعداد الحزمة.

## الحزم والتوقيع (قبل الإنتاج)

لم تُنشأ حزمة تثبيت موقّعة بعد. المقترح:

1. بناء ملف تنفيذي واحد عبر [Node Single Executable Applications](https://nodejs.org/api/single-executable-applications.html) مع تضمين `scripts/wia.ps1`، أو توزيع المجلد مع Node محمول.
2. Windows: توقيع الملف التنفيذي والمثبت (MSI/MSIX) بشهادة Code Signing، وإلا سيظهر تحذير SmartScreen. لاحظ أن `wia.ps1` يُشغَّل بـ `-ExecutionPolicy Bypass` على مستوى العملية فقط.
3. Linux: حزمة `.deb`/`.rpm` أو AppImage مع ملف خدمة systemd للمستخدم.
4. ضبط `SCANNER_AGENT_BUILD_DATE` أثناء البناء ليظهر في `/v1/health`.
5. نشر الحزمة على رابط رسمي وضبط `DOCUMENT_SCANNER_AGENT_DOWNLOAD_URL`.

## ما اختُبر فعليًا

| الميزة | المحاكي | جهاز حقيقي |
|---|---|---|
| اكتشاف الأجهزة والقدرات | ✔ | ✔ Canon MF645C (تعريف Microsoft eSCL، Windows 11) عبر `winrt` و`wia` |
| مسح Flatbed | ✔ | ✔ `winrt` (JPEG) و`wia` (PNG)، 300 dpi رمادي وملوّن، A5 ومنطقة مخصصة |
| مسح ADF وجه واحد | ✔ | ✔ `winrt`: ورقتان → صفحتان (سطر الأوامر)، وثلاث ورقات → PDF من 3 صفحات رُفع وخُزّن من المتصفح. ✘ `wia`: الصفحة الأولى فقط ثم HTTP 500 من الجهاز. |
| Duplex | ✔ | ✔ `winrt` على Canon MF645C (أفاد المستخدم بنجاحه من المتصفح) |
| انحشار الورق / الإلغاء / الجهاز المشغول | ✔ | لم يُختبر (لم يُفتعل على الجهاز) |
| SANE | اختبارات وحدات للمحلل فقط | لم يُختبر |
