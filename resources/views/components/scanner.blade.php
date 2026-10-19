@if (! $enabled)
    <div class="ds-unavailable" role="status">{{ __('document-scanner::messages.ui.not_available') }}</div>
@else
    @once
        <link rel="stylesheet" href="{{ $assetBase }}/document-scanner.css?v={{ $assetVersion }}">
        <script type="module" src="{{ $assetBase }}/document-scanner.js?v={{ $assetVersion }}"></script>
    @endonce
    <div {{ $attributes->merge(['class' => 'ds-root']) }}
         id="{{ $id }}"
         data-document-scanner
         dir="{{ $clientConfig['dir'] }}"
         lang="{{ $clientConfig['locale'] }}">
        <script type="application/json" data-ds-config>@json(['config' => $clientConfig, 'options' => $options])</script>
        @if ($options['output'] === 'form-file')
            {{-- Real file input: the PDF is placed here so the surrounding form submits the file itself. --}}
            <input type="file" name="{{ $name }}" accept="application/pdf" class="ds-visually-hidden" tabindex="-1" aria-hidden="true" data-ds-output data-required="{{ $required ? '1' : '0' }}">
        @else
            {{-- Receives the uploaded document id (ULID) after a successful upload. --}}
            <input type="hidden" name="{{ $name }}" value="" data-ds-output data-required="{{ $required ? '1' : '0' }}">
        @endif
        <noscript>{{ __('document-scanner::messages.ui.not_available') }}</noscript>
    </div>
@endif
