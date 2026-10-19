<?php

namespace Aam\DocumentScanner\View\Components;

use Aam\DocumentScanner\DocumentScanner;
use Illuminate\Contracts\View\View;
use Illuminate\Support\Str;
use Illuminate\View\Component;

/**
 * <x-document-scanner name="scanned_document_id" output="upload" />
 *
 * output="upload"    (default) the PDF is uploaded to the package endpoint and the
 *                    resulting document id (ULID) is written to a hidden input `name`.
 * output="form-file" the PDF is placed into a real <input type="file" name="{name}">
 *                    so the surrounding form submits the file itself.
 */
class Scanner extends Component
{
    public string $id;

    public function __construct(
        public string $name = 'scanned_document_id',
        public string $output = 'upload',
        public bool $required = false,
        public ?string $title = null,
        public ?string $category = null,
        public ?int $maxPages = null,
        ?string $id = null,
    ) {
        $this->output = in_array($output, ['upload', 'form-file'], true) ? $output : 'upload';
        $this->id = $id ?: 'document-scanner-'.Str::lower(Str::random(8));
    }

    /** Cache-busting token derived from every shipped asset. */
    public static function assetVersion(): string
    {
        $stamp = '';
        foreach (glob(dirname(__DIR__, 3).'/resources/dist/*') ?: [] as $file) {
            $stamp .= basename($file).filemtime($file);
        }

        return substr(md5($stamp), 0, 10);
    }

    public function render(): View
    {
        $scanner = app(DocumentScanner::class);
        $enabled = (bool) config('document-scanner.enabled') && auth()->check();

        $options = [
            'output' => $this->output,
            'name' => $this->name,
            'title' => $this->title,
            'category' => $this->category,
            'maxPages' => $this->maxPages,
        ];

        return view('document-scanner::components.scanner', [
            'enabled' => $enabled,
            'clientConfig' => $enabled ? $scanner->clientConfig() + ['csrfToken' => csrf_token()] : null,
            'options' => $options,
            'assetVersion' => self::assetVersion(),
            'assetBase' => config('document-scanner.assets.serve_from_route')
                ? rtrim(url(config('document-scanner.routes.prefix').'/assets'), '/')
                : asset('vendor/document-scanner'),
        ]);
    }
}
