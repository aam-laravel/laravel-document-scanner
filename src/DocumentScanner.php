<?php

namespace Aam\DocumentScanner;

use Aam\DocumentScanner\Events\DocumentDeleted;
use Aam\DocumentScanner\Events\DocumentUploaded;
use Aam\DocumentScanner\Events\ScanSessionCancelled;
use Aam\DocumentScanner\Events\ScanSessionCreated;
use Aam\DocumentScanner\Exceptions\ScannerException;
use Aam\DocumentScanner\Models\ScannedDocument;
use Aam\DocumentScanner\Models\ScanSession;
use Aam\DocumentScanner\Support\CorrelationId;
use Aam\DocumentScanner\Support\FileInspector;
use Aam\DocumentScanner\Support\FileNamer;
use Aam\DocumentScanner\Support\PairingTokenIssuer;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;
use Throwable;

/**
 * Main service (also behind the DocumentScanner facade): sessions, pairing
 * tokens, validated storage of uploads, and the non-secret client config.
 */
class DocumentScanner
{
    public function __construct(
        private readonly array $config,
        private readonly FileInspector $inspector,
        private readonly FileNamer $namer,
        private readonly PairingTokenIssuer $tokens,
        private readonly Dispatcher $events,
    ) {}

    public function config(?string $key = null, mixed $default = null): mixed
    {
        return $key === null ? $this->config : data_get($this->config, $key, $default);
    }

    public function createSession(Authenticatable $user, array $clientMeta = []): ScanSession
    {
        $session = ScanSession::create([
            'owner_type' => $user->getMorphClass(),
            'owner_id' => (string) $user->getAuthIdentifier(),
            'status' => ScanSession::STATUS_OPEN,
            'correlation_id' => CorrelationId::current(),
            'client_meta' => $clientMeta ?: null,
            'expires_at' => Carbon::now()->addMinutes((int) $this->config('retention.session_ttl_minutes', 120)),
        ]);
        $this->log('info', 'scan session created', ['session' => $session->id]);
        $this->events->dispatch(new ScanSessionCreated($session));

        return $session;
    }

    public function cancelSession(ScanSession $session): void
    {
        if ($session->status !== ScanSession::STATUS_OPEN) {
            throw new ScannerException('SESSION_CLOSED', 409);
        }
        $session->update(['status' => ScanSession::STATUS_CANCELLED]);
        $this->log('info', 'scan session cancelled', ['session' => $session->id]);
        $this->events->dispatch(new ScanSessionCancelled($session));
    }

    /**
     * @return array{token: string, expiresAt: string}
     */
    public function pairingToken(string $requestOrigin): array
    {
        return $this->tokens->issue($this->config('agent.origin') ?: $requestOrigin);
    }

    /**
     * Validate and store an uploaded scan for a session. Idempotent per session:
     * re-uploading the same bytes returns the stored document; different bytes
     * after completion are rejected (409).
     *
     * @param  array{filename?: ?string, pages?: ?int, title?: ?string, category?: ?string}  $input
     * @return array{document: ScannedDocument, created: bool}
     */
    public function store(ScanSession $session, UploadedFile $file, array $input = []): array
    {
        $info = $this->inspector->inspect($file, $input['pages'] ?? null);

        $existing = $session->document()->first();
        if ($existing) {
            if (hash_equals($existing->sha256, $info['sha256'])) {
                return ['document' => $existing, 'created' => false];
            }
            throw new ScannerException('SESSION_CLOSED', 409);
        }
        if (! $session->acceptsUploads()) {
            throw new ScannerException($session->isExpired() ? 'SESSION_EXPIRED' : 'SESSION_CLOSED', 409);
        }

        $disk = (string) $this->config('storage.disk', 'local');
        $id = (string) Str::ulid();
        $path = $this->namer->storagePath($id, $info['extension']);
        $name = $this->namer->displayName($input['filename'] ?? null, $info['extension']);

        try {
            $stream = fopen($file->getRealPath(), 'rb');
            $ok = Storage::disk($disk)->put($path, $stream, ['visibility' => 'private']);
            if (is_resource($stream)) {
                fclose($stream);
            }
        } catch (Throwable $e) {
            $ok = false;
            $this->log('error', 'storage write failed', ['session' => $session->id, 'disk' => $disk, 'exception' => $e::class]);
        }
        if (! $ok) {
            throw new ScannerException('STORAGE_FAILED', 507);
        }

        try {
            $document = DB::transaction(function () use ($session, $id, $disk, $path, $name, $info, $input) {
                // lock the session row so concurrent retries cannot create two documents
                $locked = ScanSession::query()->whereKey($session->id)->lockForUpdate()->first();
                if ($locked->status !== ScanSession::STATUS_OPEN) {
                    throw new ScannerException('SESSION_CLOSED', 409);
                }
                $doc = ScannedDocument::create([
                    'id' => $id,
                    'session_id' => $session->id,
                    'owner_type' => $session->owner_type,
                    'owner_id' => $session->owner_id,
                    'disk' => $disk,
                    'path' => $path,
                    'filename' => $name,
                    'mime_type' => $info['mime'],
                    'size' => $info['size'],
                    'pages' => $info['pages'],
                    'sha256' => $info['sha256'],
                    'metadata' => array_filter([
                        'title' => $input['title'] ?? null,
                        'category' => $input['category'] ?? null,
                    ], fn ($v) => $v !== null && $v !== '') ?: null,
                ]);
                $locked->update(['status' => ScanSession::STATUS_COMPLETED]);

                return $doc;
            });
        } catch (Throwable $e) {
            Storage::disk($disk)->delete($path);
            if ($e instanceof ScannerException) {
                $again = $session->document()->first();
                if ($again && hash_equals($again->sha256, $info['sha256'])) {
                    return ['document' => $again, 'created' => false];
                }
                throw $e;
            }
            $this->log('error', 'document record failed', ['session' => $session->id, 'exception' => $e::class]);
            throw new ScannerException('STORAGE_FAILED', 500);
        }

        $session->refresh();
        $this->log('info', 'document uploaded', ['session' => $session->id, 'document' => $document->id, 'size' => $info['size'], 'pages' => $info['pages']]);
        // Fired only after the file is stored and the record committed.
        $this->events->dispatch(new DocumentUploaded($document, $session));

        return ['document' => $document, 'created' => true];
    }

    public function delete(ScannedDocument $document): void
    {
        $document->deleteWithFile();
        $this->log('info', 'document deleted', ['document' => $document->id]);
        $this->events->dispatch(new DocumentDeleted($document->id, $document->owner_type, $document->owner_id));
    }

    /** Public JSON representation (no disk/path/owner). */
    public function present(ScannedDocument $document): array
    {
        $prefix = $this->config('routes.name', 'document-scanner.');

        return [
            'id' => $document->id,
            'filename' => $document->filename,
            'mimeType' => $document->mime_type,
            'size' => $document->size,
            'pages' => $document->pages,
            'sha256' => $document->sha256,
            'metadata' => $document->metadata,
            'createdAt' => $document->created_at?->toIso8601String(),
            'downloadUrl' => URL::temporarySignedRoute(
                $prefix.'documents.download',
                Carbon::now()->addMinutes((int) $this->config('storage.download_link_ttl', 10)),
                ['document' => $document->id],
            ),
        ];
    }

    /**
     * Non-secret configuration consumed by the browser client.
     */
    public function clientConfig(?string $locale = null): array
    {
        $prefix = $this->config('routes.name', 'document-scanner.');
        $locale ??= app()->getLocale();
        $messages = trans('document-scanner::messages', [], $locale);

        return [
            'locale' => $locale,
            'dir' => in_array(substr($locale, 0, 2), ['ar', 'he', 'fa', 'ur'], true) ? 'rtl' : 'ltr',
            'agent' => [
                'url' => rtrim((string) $this->config('agent.url'), '/'),
                'pairingMode' => $this->config('agent.pairing_mode', 'signed'),
                'protocol' => (int) $this->config('agent.protocol', 1),
                'minVersion' => (string) $this->config('agent.min_version'),
                'downloadUrl' => $this->config('agent.download_url'),
                'helpUrl' => $this->config('agent.install_help_url'),
                'allowSimulator' => (bool) $this->config('agent.allow_simulator'),
            ],
            'endpoints' => [
                'token' => route($prefix.'agent-token'),
                'sessions' => route($prefix.'sessions.store'),
            ],
            'timeouts' => $this->config('timeouts'),
            'limits' => [
                'maxFileSizeBytes' => (int) $this->config('limits.max_file_size_kb') * 1024,
                'maxPages' => (int) $this->config('limits.max_pages'),
                'warnDpi' => (int) $this->config('limits.warn_dpi'),
                'maxDpi' => (int) $this->config('limits.max_dpi'),
            ],
            'pdf' => [
                'jpegQuality' => (float) $this->config('pdf.jpeg_quality', 0.85),
                'maxImagePixels' => (int) $this->config('pdf.max_image_pixels'),
            ],
            'features' => $this->config('features'),
            'filenamePattern' => $this->config('filenames.pattern'),
            'messages' => is_array($messages) ? $messages : [],
        ];
    }

    private function log(string $level, string $message, array $context = []): void
    {
        if (! $this->config('logging.enabled', true)) {
            return;
        }
        $context['correlation_id'] = CorrelationId::current();
        Log::channel($this->config('logging.channel'))->{$level}('[document-scanner] '.$message, $context);
    }
}
