# document-scanner-agent

البرنامج الوسيط المحلي لحزمة `aam/laravel-document-scanner`. يعمل على جهاز المستخدم، ويستمع على `127.0.0.1:47115`، ويصل إلى الماسح عبر Windows.Devices.Scanners (WIA 2.0، الافتراضي على Windows) أو WIA 1.0 أو SANE (Linux)، ويقدّم API محدودًا للأصول المسموح بها فقط.

- لا اعتمادات npm (وحدات Node المدمجة فقط). Node.js ‎20.10+‎.
- الوثائق الكاملة: [../docs/agent.md](../docs/agent.md) وعقد الـ API: [../docs/agent-protocol.md](../docs/agent-protocol.md).

```bash
node bin/scanner-agent.js init-config --origin https://app.example.com --secret "<DOCUMENT_SCANNER_AGENT_SECRET>"
node bin/scanner-agent.js diagnose
node bin/scanner-agent.js run
npm test
```

| الملف | الغرض |
|---|---|
| `config.example.json` | مثال إعداد (السر قيمة تطوير فقط) |
| `config.demo.json` | إعداد التطبيق التجريبي: المحاكي + المحوّل الأصلي للنظام، أصلان `localhost:8000/8001` |
| `scripts/winrt.ps1` | جسر Windows.Devices.Scanners (الافتراضي على Windows) |
| `scripts/wia.ps1` | جسر WIA 1.0 عبر COM (احتياطي) |
| `test/fixtures/winrt-canon-mf645c-caps.json` | قدرات WinRT مسجلة من الماسح نفسه |
| `install/windows/*.ps1` | تشغيل تلقائي عبر Task Scheduler للمستخدم، تحكم، إزالة |
| `install/linux/*` | خدمة systemd للمستخدم وسكربت تثبيت/إزالة |
| `test/fixtures/wia-canon-mf645c-caps.json` | قدرات مسجلة من ماسح حقيقي (Canon MF645C) |
