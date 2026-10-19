<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Master switch
    |--------------------------------------------------------------------------
    | Disable the whole feature (routes return 404, the component renders a
    | "not available" notice) e.g. per environment.
    */
    'enabled' => env('DOCUMENT_SCANNER_ENABLED', true),

    /*
    |--------------------------------------------------------------------------
    | Routes
    |--------------------------------------------------------------------------
    | Every route requires an authenticated user (uploads are owned by the
    | user). Keep "web" so session cookies + CSRF protection apply.
    */
    'routes' => [
        'enabled' => true,
        'prefix' => env('DOCUMENT_SCANNER_ROUTE_PREFIX', 'document-scanner'),
        'name' => 'document-scanner.',
        'middleware' => ['web', 'auth'],
        // Standalone scanner page at /{prefix}; set false if you only embed the component.
        'page' => true,
    ],

    /*
    |--------------------------------------------------------------------------
    | Authorization
    |--------------------------------------------------------------------------
    | Optional Gate ability checked before any scanner endpoint. When the
    | ability is not defined by the application, any authenticated user may
    | scan; documents are always restricted to their owner by the policies.
    */
    'authorization' => [
        'ability' => 'use-document-scanner',
    ],

    /*
    |--------------------------------------------------------------------------
    | Local Scanner Agent
    |--------------------------------------------------------------------------
    | The browser (not this server) talks to the agent running on the user's
    | machine. "url" must be a loopback address. The pairing secret is shared
    | with the agent config (sites[].pairingSecret) and never sent to the
    | browser: Laravel only hands out short-lived signed tokens.
    */
    'agent' => [
        'url' => env('DOCUMENT_SCANNER_AGENT_URL', 'http://127.0.0.1:47115'),
        'pairing_mode' => env('DOCUMENT_SCANNER_PAIRING_MODE', 'signed'), // signed | code
        'pairing_secret' => env('DOCUMENT_SCANNER_AGENT_SECRET'),
        'pairing_token_ttl' => 60, // seconds (the agent refuses tokens valid > 300s)
        // Origin the agent sees (scheme://host[:port]); null = current request origin.
        'origin' => env('DOCUMENT_SCANNER_ORIGIN'),
        'protocol' => 1,
        'min_version' => '1.0.0',
        // Real download page for the agent installer. Leave null until you
        // publish a build; the UI then says no download is available yet.
        'download_url' => env('DOCUMENT_SCANNER_AGENT_DOWNLOAD_URL'),
        'install_help_url' => env('DOCUMENT_SCANNER_AGENT_HELP_URL'),
        // Show simulated devices offered by an agent started with --adapter simulator.
        'allow_simulator' => env('DOCUMENT_SCANNER_ALLOW_SIMULATOR', false),
    ],

    'timeouts' => [
        'agent_probe_ms' => 2500,
        'agent_request_ms' => 20000,
        'scan_seconds' => 600,
        'upload_seconds' => 300,
    ],

    'limits' => [
        'max_file_size_kb' => (int) env('DOCUMENT_SCANNER_MAX_KB', 20480),
        'max_pages' => (int) env('DOCUMENT_SCANNER_MAX_PAGES', 100),
        // Resolutions above this show a "large file / slow" warning in the UI.
        'warn_dpi' => 300,
        // Resolutions above this are not offered even if the device supports them.
        'max_dpi' => 600,
    ],

    /*
    | Accepted upload types: pdf, jpeg, png. Content is inspected server-side;
    | client MIME types and extensions are not trusted.
    */
    'accepted_types' => ['pdf'],

    'storage' => [
        'disk' => env('DOCUMENT_SCANNER_DISK', 'local'),
        'path' => 'scanned-documents',
        // Lifetime of temporary signed download links (minutes).
        'download_link_ttl' => 10,
    ],

    'pdf' => [
        'jpeg_quality' => 0.85,        // 0.1 - 1.0 (browser JPEG encoder)
        'max_image_pixels' => 40_000_000, // per page, guards browser memory
        // Reject PDFs containing JavaScript, launch actions, embedded files, XFA or encryption.
        'reject_active_content' => true,
        // Reject PDFs whose page count cannot be determined.
        'require_page_count' => true,
    ],

    'filenames' => [
        // Placeholders: {date} (Ymd), {time} (His). Never includes user data by default.
        'pattern' => 'scan-{date}-{time}',
        'allow_user_names' => true,
        'max_length' => 100,
    ],

    'features' => [
        'blank_page_detection' => true,
        // Convert to grayscale / black&white in the browser when the scanner cannot (clearly labelled as software conversion).
        'software_color_conversion' => true,
        // OCR is not implemented by this package; keep false. See docs/usage.md.
        'ocr' => false,
    ],

    'retention' => [
        // Scan sessions that never received a document expire after this many minutes.
        'session_ttl_minutes' => 120,
        // `document-scanner:prune` deletes expired sessions older than this many hours.
        'prune_sessions_after_hours' => 24,
    ],

    'rate_limits' => [
        'uploads_per_minute' => 10,
        'sessions_per_minute' => 30,
        'tokens_per_minute' => 30,
    ],

    'logging' => [
        'enabled' => true,
        'channel' => env('DOCUMENT_SCANNER_LOG_CHANNEL'), // null = default channel
    ],

    'assets' => [
        // Serve the JS/CSS through a package route (always in sync with the installed version).
        // Set false after `php artisan vendor:publish --tag=document-scanner-assets` to use public/vendor/document-scanner.
        'serve_from_route' => true,
    ],
];
