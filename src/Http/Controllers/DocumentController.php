<?php

namespace Aam\DocumentScanner\Http\Controllers;

use Aam\DocumentScanner\DocumentScanner;
use Aam\DocumentScanner\Exceptions\ScannerException;
use Aam\DocumentScanner\Models\ScannedDocument;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\StreamedResponse;

class DocumentController extends Controller
{
    public function show(Request $request, ScannedDocument $document, DocumentScanner $scanner): JsonResponse
    {
        $this->authorizeOwner($request, $document, 'view');

        return response()->json(['document' => $scanner->present($document)]);
    }

    /** Signed short-lived URL *and* owner check: a leaked link is useless to other users. */
    public function download(Request $request, ScannedDocument $document): StreamedResponse
    {
        $this->authorizeOwner($request, $document, 'download');
        $disk = Storage::disk($document->disk);
        if (! $disk->exists($document->path)) {
            throw new ScannerException('DOCUMENT_MISSING', 404);
        }

        return $disk->download($document->path, $document->filename, [
            'Content-Type' => $document->mime_type,
            'Cache-Control' => 'private, no-store',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    public function destroy(Request $request, ScannedDocument $document, DocumentScanner $scanner): JsonResponse
    {
        $this->authorizeOwner($request, $document, 'delete');
        $scanner->delete($document);

        return response()->json(['deleted' => true]);
    }

    private function authorizeOwner(Request $request, ScannedDocument $document, string $ability): void
    {
        if (! $request->user()->can($ability, $document)) {
            // 404 rather than 403 so other users' document ids cannot be probed
            throw new ScannerException('NOT_FOUND', 404);
        }
    }
}
