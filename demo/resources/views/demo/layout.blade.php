<!DOCTYPE html>
<html lang="{{ app()->getLocale() }}" dir="{{ app()->getLocale() === 'ar' ? 'rtl' : 'ltr' }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>@yield('title', 'Document Scanner Demo')</title>
    <style>
        body { margin: 0; font-family: system-ui, "Segoe UI", Tahoma, sans-serif; background: #f5f6f8; color: #1f2937; }
        header { background: #111827; color: #fff; padding: 10px 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
        header a, header button { color: #fff; background: none; border: 0; font: inherit; cursor: pointer; text-decoration: underline; }
        main { max-width: 1100px; margin: 0 auto; padding: 20px 16px; }
        .box { background: #fff; border: 1px solid #d1d5db; border-radius: 8px; padding: 16px; margin-block-end: 16px; }
        .status { background: #dcfce7; border: 1px solid #15803d; padding: 10px; border-radius: 6px; }
        .errors { background: #fee2e2; border: 1px solid #b91c1c; padding: 10px; border-radius: 6px; }
        label { font-weight: 600; display: block; margin-block-end: 4px; }
        input[type=text] { font: inherit; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; width: 100%; max-width: 420px; box-sizing: border-box; }
        .submit { font: inherit; background: #15803d; color: #fff; border: 0; border-radius: 6px; padding: 8px 16px; margin-block-start: 12px; cursor: pointer; }
    </style>
</head>
<body>
<header>
    <strong>Document Scanner Demo</strong>
    <a href="{{ route('home') }}">Home</a>
    @auth
        <a href="{{ route('documents.create') }}">A: upload</a>
        <a href="{{ route('documents.create-file') }}">B: form file</a>
        <a href="{{ route('documents.js-api') }}">C: JS API</a>
        <a href="{{ route('document-scanner.page') }}">Package page</a>
    @endauth
    <a href="{{ route('locale', 'ar') }}">العربية</a>
    <a href="{{ route('locale', 'en') }}">English</a>
    @auth
        <form method="POST" action="{{ route('logout') }}" style="margin:0">@csrf<button type="submit">Logout ({{ auth()->user()->email }})</button></form>
    @endauth
</header>
<main>
    @if (session('status'))<p class="status" role="status">{{ session('status') }}</p>@endif
    @if ($errors->any())<div class="errors" role="alert">@foreach ($errors->all() as $e)<p>{{ $e }}</p>@endforeach</div>@endif
    @yield('content')
</main>
</body>
</html>
