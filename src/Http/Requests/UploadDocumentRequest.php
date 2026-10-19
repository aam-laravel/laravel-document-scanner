<?php

namespace Aam\DocumentScanner\Http\Requests;

class UploadDocumentRequest extends ScannerFormRequest
{
    public function authorize(): bool
    {
        return $this->user() !== null && $this->user()->can('upload', $this->route('session'));
    }

    public function rules(): array
    {
        $config = config('document-scanner');

        return [
            // Size is enforced here; type/structure are checked from the content by FileInspector.
            'document' => ['required', 'file', 'max:'.(int) $config['limits']['max_file_size_kb']],
            'filename' => ['nullable', 'string', 'max:150'],
            'pages' => ['nullable', 'integer', 'min:1', 'max:'.(int) $config['limits']['max_pages']],
            'title' => ['nullable', 'string', 'max:150'],
            'category' => ['nullable', 'string', 'max:64', 'regex:/^[\pL\pN _.-]+$/u'],
        ];
    }
}
