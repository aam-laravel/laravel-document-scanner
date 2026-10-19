<?php

namespace Aam\DocumentScanner\Http\Requests;

/** Cheap metadata check before sending a large file. Not a substitute for upload validation. */
class PreflightDocumentRequest extends ScannerFormRequest
{
    public function authorize(): bool
    {
        return $this->user() !== null && $this->user()->can('upload', $this->route('session'));
    }

    public function rules(): array
    {
        $config = config('document-scanner');
        $types = array_map(fn ($t) => \Aam\DocumentScanner\Support\FileInspector::TYPES[$t][0] ?? null, $config['accepted_types']);

        return [
            'size' => ['required', 'integer', 'min:1'],
            'pages' => ['required', 'integer', 'min:1'],
            'mimeType' => ['required', 'string', 'in:'.implode(',', array_filter($types))],
        ];
    }
}
