<?php

namespace Aam\DocumentScanner\Http\Requests;

class StoreScanSessionRequest extends ScannerFormRequest
{
    public function authorize(): bool
    {
        return $this->user() !== null;
    }

    public function rules(): array
    {
        return [
            'client' => ['nullable', 'array'],
            'client.agentVersion' => ['nullable', 'string', 'max:32', 'regex:/^[0-9A-Za-z.+-]+$/'],
            // Informational only (stored for diagnostics): accept any short adapter slug so new
            // agent adapters (e.g. winrt) never block an upload.
            'client.adapter' => ['nullable', 'string', 'max:32', 'regex:/^[a-z0-9_-]+$/'],
            'client.simulated' => ['nullable', 'boolean'],
        ];
    }

    /** Only whitelisted, non-sensitive client facts are stored. */
    public function clientMeta(): array
    {
        return array_filter([
            'agentVersion' => $this->input('client.agentVersion'),
            'adapter' => $this->input('client.adapter'),
            'simulated' => $this->has('client.simulated') ? $this->boolean('client.simulated') : null,
        ], fn ($v) => $v !== null);
    }
}
