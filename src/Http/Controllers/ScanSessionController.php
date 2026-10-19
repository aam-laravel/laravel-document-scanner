<?php

namespace Aam\DocumentScanner\Http\Controllers;

use Aam\DocumentScanner\DocumentScanner;
use Aam\DocumentScanner\Exceptions\ScannerException;
use Aam\DocumentScanner\Http\Requests\PreflightDocumentRequest;
use Aam\DocumentScanner\Http\Requests\StoreScanSessionRequest;
use Aam\DocumentScanner\Http\Requests\UploadDocumentRequest;
use Aam\DocumentScanner\Models\ScanSession;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;

class ScanSessionController extends Controller
{
    public function store(StoreScanSessionRequest $request, DocumentScanner $scanner): JsonResponse
    {
        $session = $scanner->createSession($request->user(), $request->clientMeta());

        return response()->json($this->present($session), 201);
    }

    public function show(Request $request, ScanSession $session): JsonResponse
    {
        $this->authorizeOwner($request, $session, 'view');

        return response()->json($this->present($session));
    }

    public function destroy(Request $request, ScanSession $session, DocumentScanner $scanner): JsonResponse
    {
        $this->authorizeOwner($request, $session, 'cancel');
        $scanner->cancelSession($session);

        return response()->json($this->present($session->refresh()));
    }

    /** Metadata pre-check so the browser can fail fast before uploading a large file. */
    public function preflight(PreflightDocumentRequest $request, ScanSession $session): JsonResponse
    {
        if (! $session->acceptsUploads()) {
            throw new ScannerException($session->isExpired() ? 'SESSION_EXPIRED' : 'SESSION_CLOSED', 409);
        }
        if ((int) $request->input('size') > (int) config('document-scanner.limits.max_file_size_kb') * 1024) {
            throw new ScannerException('FILE_TOO_LARGE', 413);
        }
        if ((int) $request->input('pages') > (int) config('document-scanner.limits.max_pages')) {
            throw new ScannerException('TOO_MANY_PAGES', 422);
        }

        return response()->json(['ok' => true]);
    }

    public function upload(UploadDocumentRequest $request, ScanSession $session, DocumentScanner $scanner): JsonResponse
    {
        $result = $scanner->store($session, $request->file('document'), [
            'filename' => $request->input('filename'),
            'pages' => $request->filled('pages') ? (int) $request->input('pages') : null,
            'title' => $request->input('title'),
            'category' => $request->input('category'),
        ]);

        return response()->json([
            'document' => $scanner->present($result['document']),
            'session' => $this->present($session->refresh()),
            'duplicate' => ! $result['created'],
        ], $result['created'] ? 201 : 200);
    }

    private function authorizeOwner(Request $request, ScanSession $session, string $ability): void
    {
        if (! $request->user()->can($ability, $session)) {
            throw new ScannerException('NOT_FOUND', 404);
        }
    }

    private function present(ScanSession $session): array
    {
        $name = config('document-scanner.routes.name');
        $doc = $session->document()->first();

        return [
            'id' => $session->id,
            'status' => $session->isExpired() && $session->status === ScanSession::STATUS_OPEN ? ScanSession::STATUS_EXPIRED : $session->status,
            'expiresAt' => $session->expires_at->toIso8601String(),
            'uploadUrl' => route($name.'sessions.upload', $session),
            'preflightUrl' => route($name.'sessions.preflight', $session),
            'cancelUrl' => route($name.'sessions.destroy', $session),
            'documentId' => $doc?->id,
        ];
    }
}
