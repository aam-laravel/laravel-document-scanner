@php($dir = in_array(substr(app()->getLocale(), 0, 2), ['ar', 'he', 'fa', 'ur'], true) ? 'rtl' : 'ltr')
<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}" dir="{{ $dir }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>{{ __('document-scanner::messages.ui.title') }}</title>
    <style>
        body { margin: 0; font-family: system-ui, "Segoe UI", Tahoma, sans-serif; background: #f5f6f8; color: #1f2937; }
        main { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
        h1 { font-size: 1.4rem; margin: 0 0 16px; }
    </style>
</head>
<body>
<main>
    <h1>{{ __('document-scanner::messages.ui.title') }}</h1>
    <x-document-scanner name="scanned_document_id" output="upload" />
</main>
</body>
</html>
