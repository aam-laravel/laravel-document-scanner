# Operating Guide — aam/laravel-document-scanner

[النسخة العربية](OPERATING-GUIDE.ar.md)

This guide covers the practical steps from installation to day-to-day use. The other files in `docs/` (Arabic) hold the full reference.

---

## 1. How it works

```
[ Browser: scanner UI ] ──HTTP to 127.0.0.1──▶ [ Scanner Agent on the user's PC ] ──WinRT/WIA/SANE──▶ [ Scanner ]
            │
            └──HTTPS + session + CSRF──▶ [ Laravel: upload sessions, validation, storage, authorization ]
```

| Component | Runs on | Role |
|---|---|---|
| Laravel package | Server | Routes, file validation, private storage, policies, signing pairing tokens |
| Browser UI | Application page | Agent detection, settings, page preview/reorder, PDF creation, upload |
| Scanner Agent | Each user's PC with a scanner | Talks to the scanner through the operating system |

The server never contacts the agent; the browser does. So the setup works when Laravel runs on a remote server.

## 2. Requirements

| Component | Requirement |
|---|---|
| Server | PHP 8.2+, Laravel 11, 12 or 13, `fileinfo` extension, HTTPS in production |
| User PC | Node.js 20.10+ |
| Windows 10/11 | A WIA driver for the scanner; Windows PowerShell 5.1 (built in) |
| Linux | `sane-utils` (`scanimage -L` lists the device) |
| Browser | Current Chrome or Edge |

Verified: Laravel 13.37 on PHP 8.3, and Windows 11 with a Canon MF645C (flatbed, multi-sheet feeder, duplex). Linux was not tested on real hardware, and macOS is not supported.

## 3. Install the package in a Laravel app

**1) Add the repository to your app's `composer.json`:**

```json
"repositories": [
    { "type": "vcs", "url": "https://github.com/aam-laravel/laravel-document-scanner" }
]
```

**2) Install, publish and migrate:**

```bash
composer require "aam/laravel-document-scanner:dev-main"
php artisan vendor:publish --tag=document-scanner-config
php artisan migrate
```

**3) Generate the pairing secret:**

```bash
php artisan document-scanner:secret
```

**4) Add to `.env`:**

```dotenv
DOCUMENT_SCANNER_AGENT_SECRET=<output of step 3>
DOCUMENT_SCANNER_AGENT_URL=http://127.0.0.1:47115
DOCUMENT_SCANNER_DISK=local
DOCUMENT_SCANNER_AGENT_DOWNLOAD_URL=     # real download link once you publish an agent build
```

**5) Check the installation:**

```bash
php artisan document-scanner:check
```

**6) Schedule clean-up (`routes/console.php`):**

```php
Schedule::command('document-scanner:prune')->hourly();
```

> PHP's `upload_max_filesize` and `post_max_size` must be at least the maximum file size (20 MB by default).

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DOCUMENT_SCANNER_ENABLED` | `true` | Turn the feature off (routes return 404) |
| `DOCUMENT_SCANNER_AGENT_URL` | `http://127.0.0.1:47115` | Agent address as seen by the **user's browser**; must be loopback |
| `DOCUMENT_SCANNER_PAIRING_MODE` | `signed` | `signed` (Laravel-signed token) or `code` (user types a code shown by the agent) |
| `DOCUMENT_SCANNER_AGENT_SECRET` | — | HMAC secret shared with the agent (≥ 32 chars); never sent to the browser |
| `DOCUMENT_SCANNER_ORIGIN` | — | Origin the agent sees, if it differs from the request origin (behind a proxy) |
| `DOCUMENT_SCANNER_AGENT_DOWNLOAD_URL` | — | Agent download page; if empty the UI says no download is published yet |
| `DOCUMENT_SCANNER_ALLOW_SIMULATOR` | `false` | Show simulated devices; keep `false` in production |
| `DOCUMENT_SCANNER_DISK` | `local` | Laravel disk (private by default) |
| `DOCUMENT_SCANNER_MAX_KB` / `_MAX_PAGES` | `20480` / `100` | File size and page limits |

## 4. Install the agent on the user's PC

Copy the `agent/` folder from this repository to the PC, then:

```bash
cd agent
node bin/scanner-agent.js init-config --origin https://app.example.com --secret "<same DOCUMENT_SCANNER_AGENT_SECRET>"
node bin/scanner-agent.js diagnose     # the scanner must be listed
node bin/scanner-agent.js run
```

- `--origin` is your site's address exactly as the browser shows it (scheme, host and port if any).
- The agent listens on `127.0.0.1:47115` only and accepts only the sites listed in its config.
- On Windows the default adapter is `winrt` (Windows.Devices.Scanners / WIA 2.0), which returns every page of a feeder job. The older `wia` adapter stays available with `--adapter wia`.

**Autostart on Windows** (asks for confirmation, no admin rights):

```powershell
powershell -ExecutionPolicy Bypass -File agent\install\windows\install-autostart.ps1
powershell -ExecutionPolicy Bypass -File agent\install\windows\agent-control.ps1 status
powershell -ExecutionPolicy Bypass -File agent\install\windows\uninstall-autostart.ps1
```

**Linux:**

```bash
./agent/install/linux/install.sh          # systemd user service
./agent/install/linux/install.sh --uninstall
```

Other CLI commands: `status`, `devices`, `caps <deviceId>`, `test-scan <deviceId>`, `gen-secret`, `version`.

## 5. Use it in any form

### Option A (recommended): the package uploads the file, the form posts its id

```blade
<form method="POST" action="{{ route('contracts.store') }}">
    @csrf
    <input name="title" required>
    <x-document-scanner name="scanned_document_id" :required="true" />
    <button type="submit">Save</button>
</form>
```

After scanning and clicking "Upload to server", the server validates and stores the file, then the document id is written into the hidden `scanned_document_id` field.

```php
use Aam\DocumentScanner\Models\ScannedDocument;

public function store(Request $request)
{
    $data = $request->validate([
        'title' => ['required', 'string', 'max:150'],
        'scanned_document_id' => ['required', 'ulid'],
    ]);

    // Always check the document belongs to the current user
    $document = ScannedDocument::query()
        ->ownedBy($request->user())
        ->findOrFail($data['scanned_document_id']);

    Contract::create(['title' => $data['title'], 'scanned_document_id' => $document->id]);
}
```

### Option B: the file itself is submitted with the form

```blade
<form method="POST" action="{{ route('documents.store') }}" enctype="multipart/form-data">
    @csrf
    <x-document-scanner name="document" output="form-file" :required="true" />
    <button type="submit">Submit</button>
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

### Component options

| Option | Purpose |
|---|---|
| `name` | Field name in the form |
| `output` | `upload` (default) or `form-file` |
| `:required` | Blocks form submission until a document exists |
| `title`, `category` | Metadata stored with the document |
| `:max-pages` | Page limit lower than the configured one |

### JavaScript API

```html
<div id="scanner"></div>
<script type="module">
  import '/document-scanner/assets/document-scanner.js';
  const el = document.getElementById('scanner');
  el.addEventListener('document-scanner:uploaded', (e) => console.log(e.detail.document.id));
  await window.DocumentScanner.mountFromUrl(el, '/document-scanner/config', { output: 'upload', name: 'scanned_document_id' });
</script>
```

Events: `document-scanner:uploaded` (`detail.document`), `document-scanner:attached` (form-file mode), `document-scanner:error` (`detail.code`).

## 6. What the user does

1. Open the page: the agent shows "Connected" and the scanner list appears.
2. Choose the scanner, paper source (flatbed, feeder one side or both sides), colour, resolution and size. Lists only show what the device supports.
3. Click "Scan": pages appear as thumbnails.
4. Rotate, reorder (drag, buttons or `Alt+↑/↓`), delete, rescan a page, or add pages.
5. Click "Upload to server". Success is shown only after the server confirms; on failure the pages stay and "Try again" appears.

## 7. What the server checks on upload

Authenticated owner, CSRF, open session, non-empty file, size limit, real type sniffed from the bytes, PDF structure, no active content (JavaScript, launch actions, embedded files, XFA, encryption), page count matching the client's claim, page limit. Files are stored on a private disk as `scanned-documents/YYYY/MM/<ulid>.pdf`. Retrying the same bytes in the same session returns the existing document instead of creating a duplicate. The `DocumentUploaded` event fires only after the file is stored and the record committed.

## 8. Troubleshooting

| What you see | Fix |
|---|---|
| "Not running or not installed" | Start the agent: `node bin/scanner-agent.js status` |
| "Running, but this site is not allowed" | Add the site's exact origin to `sites` in the agent config and restart it |
| "Pairing failed" | `DOCUMENT_SCANNER_AGENT_SECRET` must equal `pairingSecret`; clocks must be close |
| "No scanner found" | Power on and connect the scanner; Windows: `Get-PnpDevice -Class Image` |
| `HARDWARE_ERROR` with HTTP 500 | Check the scanner's display (jam or stuck job) or restart it |
| Chrome asks for "local network" access | Allow it; it is needed to reach 127.0.0.1 |

"Copy diagnostic report" at the bottom of the UI copies a report without secrets. The `correlationId` links an error across browser, agent and server logs.

## 9. Before production

- [ ] HTTPS, `APP_DEBUG=false`, `php artisan document-scanner:check` clean.
- [ ] Random pairing secret distributed to PCs over a secure channel.
- [ ] Agent `sites` lists only the production origin; `DOCUMENT_SCANNER_ALLOW_SIMULATOR=false`.
- [ ] Private storage disk.
- [ ] Signed agent build and an official download URL in `DOCUMENT_SCANNER_AGENT_DOWNLOAD_URL`.

## 10. Not implemented

OCR, deskew/auto-crop, duplicate-page detection, saved setting profiles, PDF/A, resumable chunked upload, TWAIN, macOS, signed installer and auto-update. See `CHANGELOG.md` for the reasons.
