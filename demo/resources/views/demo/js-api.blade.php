@extends('demo.layout')

@section('content')
<div class="box">
    <h1>C — JavaScript API</h1>
    <p>No Blade component: the page loads the module, fetches the non-secret client config from <code>{{ route('document-scanner.config') }}</code> and mounts the scanner into a plain element.</p>
    <div id="my-scanner"></div>
    <pre id="event-log" aria-live="polite" style="background:#111827;color:#d1fae5;padding:8px;border-radius:6px;min-height:2em;white-space:pre-wrap"></pre>
</div>
<link rel="stylesheet" href="{{ route('document-scanner.assets', 'document-scanner.css') }}">
<script type="module">
    import '{{ route('document-scanner.assets', 'document-scanner.js') }}';

    const el = document.getElementById('my-scanner');
    const log = (m) => (document.getElementById('event-log').textContent += m + '\n');

    el.addEventListener('document-scanner:uploaded', (e) => log('uploaded: ' + JSON.stringify({ id: e.detail.document.id, pages: e.detail.document.pages, size: e.detail.document.size })));
    el.addEventListener('document-scanner:error', (e) => log('error: ' + e.detail.code));

    await window.DocumentScanner.mountFromUrl(el, @json(route('document-scanner.config')), { output: 'upload', name: 'scanned_document_id', title: 'JS API demo' });
</script>
@endsection
