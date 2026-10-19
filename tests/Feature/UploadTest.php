<?php

namespace Aam\DocumentScanner\Tests\Feature;

use Aam\DocumentScanner\Events\DocumentUploaded;
use Aam\DocumentScanner\Models\ScannedDocument;
use Aam\DocumentScanner\Models\ScanSession;
use Aam\DocumentScanner\Tests\TestCase;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Foundation\Http\Middleware\PreventRequestForgery;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;
use Mockery;

class UploadTest extends TestCase
{
    private function newSession($user = null): array
    {
        $this->actingAs($user ?? $this->user());

        return $this->postJson('/document-scanner/sessions', ['client' => ['agentVersion' => '1.0.0', 'adapter' => 'simulator', 'simulated' => true]])
            ->assertCreated()->json();
    }

    public function test_full_flow_stores_a_private_file_with_a_random_name_and_fires_event_after_success(): void
    {
        Storage::fake('local');
        Event::fake([DocumentUploaded::class]);
        $session = $this->newSession();
        $this->assertSame('open', $session['status']);

        $this->postJson($session['preflightUrl'], ['size' => 1000, 'pages' => 3, 'mimeType' => 'application/pdf'])->assertOk();

        $res = $this->post($session['uploadUrl'], [
            'document' => $this->scannedPdf('../../evil name.pdf'),
            'filename' => 'عقد ../ مهم',
            'pages' => 3,
            'title' => 'Contract',
        ], ['Accept' => 'application/json', 'X-Correlation-Id' => 'corr-12345678']);

        $res->assertCreated()
            ->assertJsonPath('document.pages', 3)
            ->assertJsonPath('document.mimeType', 'application/pdf')
            ->assertJsonPath('document.filename', 'مهم.pdf') // basename(): directory parts are dropped
            ->assertJsonPath('session.status', 'completed')
            ->assertJsonPath('duplicate', false)
            ->assertHeader('X-Correlation-Id', 'corr-12345678');

        $doc = ScannedDocument::firstOrFail();
        $this->assertSame('local', $doc->disk);
        $this->assertMatchesRegularExpression('#^scanned-documents/\d{4}/\d{2}/[0-9a-z]{26}\.pdf$#', $doc->path);
        $this->assertStringNotContainsString('evil', $doc->path);
        Storage::disk('local')->assertExists($doc->path);
        $this->assertSame(hash('sha256', Storage::disk('local')->get($doc->path)), $doc->sha256);

        $body = $res->getContent();
        $this->assertStringNotContainsString($doc->path, $body, 'internal path never exposed');
        $this->assertStringNotContainsString('owner_id', $body);
        Event::assertDispatched(DocumentUploaded::class, fn ($e) => $e->document->is($doc));
    }

    public function test_session_accepts_any_agent_adapter_slug_but_rejects_unsafe_values(): void
    {
        $this->actingAs($this->user());
        // regression: the Windows "winrt" adapter was rejected by a fixed list
        $this->postJson('/document-scanner/sessions', ['client' => ['agentVersion' => '1.0.0', 'adapter' => 'winrt', 'simulated' => false]])->assertCreated();
        $this->assertSame('winrt', \Aam\DocumentScanner\Models\ScanSession::latest()->first()->client_meta['adapter']);
        $this->postJson('/document-scanner/sessions', ['client' => ['adapter' => '<script>']])
            ->assertStatus(422)->assertJsonPath('error.code', 'VALIDATION_FAILED');
    }

    public function test_retry_with_same_bytes_is_idempotent_and_different_bytes_are_rejected(): void
    {
        Storage::fake('local');
        $session = $this->newSession();
        $this->post($session['uploadUrl'], ['document' => $this->scannedPdf(), 'pages' => 3], ['Accept' => 'application/json'])->assertCreated();
        $again = $this->post($session['uploadUrl'], ['document' => $this->scannedPdf(), 'pages' => 3], ['Accept' => 'application/json']);
        $again->assertOk()->assertJsonPath('duplicate', true);
        $this->assertSame(1, ScannedDocument::count());

        $other = UploadedFile::fake()->createWithContent('x.pdf', $this->minimalPdf('', 1));
        $this->post($session['uploadUrl'], ['document' => $other], ['Accept' => 'application/json'])
            ->assertStatus(409)->assertJsonPath('error.code', 'SESSION_CLOSED');
    }

    public function test_rejects_empty_wrong_type_corrupt_active_large_and_mismatched_files(): void
    {
        Storage::fake('local');
        $session = $this->newSession();
        $post = fn ($file, $extra = []) => $this->post($session['uploadUrl'], ['document' => $file] + $extra, ['Accept' => 'application/json']);

        $post(UploadedFile::fake()->createWithContent('a.pdf', ''))->assertStatus(422)->assertJsonPath('error.code', 'FILE_EMPTY');
        // a PNG renamed to .pdf with a PDF mime: content sniffing wins
        $png = UploadedFile::fake()->image('x.png')->getContent();
        $post(UploadedFile::fake()->createWithContent('scan.pdf', $png)->mimeType('application/pdf'))
            ->assertStatus(422)->assertJsonPath('error.code', 'FILE_TYPE_NOT_ALLOWED');
        $post(UploadedFile::fake()->createWithContent('a.pdf', "%PDF-1.4\n garbage without trailer"))
            ->assertStatus(422)->assertJsonPath('error.code', 'FILE_CORRUPT');
        $post(UploadedFile::fake()->createWithContent('a.pdf', $this->minimalPdf('/OpenAction << /S /JavaScript /JS (x) >>')))
            ->assertStatus(422)->assertJsonPath('error.code', 'FILE_ACTIVE_CONTENT');
        $post($this->scannedPdf(), ['pages' => 2])->assertStatus(422)->assertJsonPath('error.code', 'PDF_PAGE_MISMATCH');

        config(['document-scanner.limits.max_pages' => 2]);
        $post($this->scannedPdf())->assertStatus(422)->assertJsonPath('error.code', 'TOO_MANY_PAGES');

        config(['document-scanner.limits.max_file_size_kb' => 1]);
        $post(UploadedFile::fake()->create('big.pdf', 5, 'application/pdf'))->assertStatus(413)->assertJsonPath('error.code', 'FILE_TOO_LARGE');

        $this->assertSame(0, ScannedDocument::count());
        $this->assertSame([], Storage::disk('local')->allFiles());
        $this->assertSame('open', ScanSession::first()->status, 'session stays open for a corrected retry');
    }

    public function test_preflight_rejects_oversized_or_too_many_pages(): void
    {
        $session = $this->newSession();
        $this->postJson($session['preflightUrl'], ['size' => 999_999_999, 'pages' => 1, 'mimeType' => 'application/pdf'])->assertStatus(413);
        $this->postJson($session['preflightUrl'], ['size' => 10, 'pages' => 9999, 'mimeType' => 'application/pdf'])->assertStatus(422)->assertJsonPath('error.code', 'TOO_MANY_PAGES');
        $this->postJson($session['preflightUrl'], ['size' => 10, 'pages' => 1, 'mimeType' => 'text/html'])->assertStatus(422)->assertJsonPath('error.code', 'VALIDATION_FAILED');
    }

    public function test_other_users_cannot_access_sessions_or_documents(): void
    {
        Storage::fake('local');
        $owner = $this->user('owner@example.com');
        $session = $this->newSession($owner);
        $doc = $this->post($session['uploadUrl'], ['document' => $this->scannedPdf(), 'pages' => 3], ['Accept' => 'application/json'])->json('document');

        $this->actingAs($this->user('intruder@example.com'));
        $this->getJson("/document-scanner/sessions/{$session['id']}")->assertNotFound();
        $this->deleteJson("/document-scanner/sessions/{$session['id']}")->assertNotFound();
        $this->post($session['uploadUrl'], ['document' => $this->scannedPdf()], ['Accept' => 'application/json'])->assertForbidden();
        $this->getJson("/document-scanner/documents/{$doc['id']}")->assertNotFound();
        $this->get($doc['downloadUrl'])->assertNotFound(); // valid signature, wrong user
        $this->deleteJson("/document-scanner/documents/{$doc['id']}")->assertNotFound();
        $this->assertSame(1, ScannedDocument::count());
    }

    public function test_download_requires_valid_signature_and_streams_the_file(): void
    {
        Storage::fake('local');
        $session = $this->newSession();
        $doc = $this->post($session['uploadUrl'], ['document' => $this->scannedPdf(), 'pages' => 3, 'filename' => 'my scan'], ['Accept' => 'application/json'])->json('document');

        $res = $this->get($doc['downloadUrl'])->assertOk()->assertHeader('Content-Type', 'application/pdf');
        $this->assertStringContainsString('my scan.pdf', $res->headers->get('Content-Disposition'));
        $this->get("/document-scanner/documents/{$doc['id']}/download")->assertForbidden(); // unsigned
        $this->get(URL::temporarySignedRoute('document-scanner.documents.download', now()->subMinute(), ['document' => $doc['id']]))->assertForbidden();

        $this->getJson("/document-scanner/documents/{$doc['id']}")->assertOk()->assertJsonPath('document.id', $doc['id']);
        $this->deleteJson("/document-scanner/documents/{$doc['id']}")->assertOk();
        $this->assertSame([], Storage::disk('local')->allFiles());
    }

    public function test_storage_failure_returns_error_and_records_nothing(): void
    {
        Event::fake([DocumentUploaded::class]);
        $session = $this->newSession();
        $disk = Mockery::mock(FilesystemAdapter::class);
        $disk->shouldReceive('put')->andReturn(false);
        $disk->shouldReceive('delete')->andReturn(true);
        Storage::set('local', $disk);

        $this->post($session['uploadUrl'], ['document' => $this->scannedPdf(), 'pages' => 3], ['Accept' => 'application/json'])
            ->assertStatus(507)->assertJsonPath('error.code', 'STORAGE_FAILED')
            ->assertJsonMissingPath('error.trace');
        $this->assertSame(0, ScannedDocument::count());
        $this->assertSame('open', ScanSession::first()->status);
        Event::assertNotDispatched(DocumentUploaded::class);
    }

    public function test_expired_and_cancelled_sessions_reject_uploads(): void
    {
        Storage::fake('local');
        $session = $this->newSession();
        ScanSession::whereKey($session['id'])->update(['expires_at' => now()->subMinute()]);
        $this->getJson("/document-scanner/sessions/{$session['id']}")->assertJsonPath('status', 'expired');
        $this->post($session['uploadUrl'], ['document' => $this->scannedPdf()], ['Accept' => 'application/json'])
            ->assertStatus(409)->assertJsonPath('error.code', 'SESSION_EXPIRED');

        $s2 = $this->newSession(auth()->user());
        $this->deleteJson($s2['cancelUrl'])->assertOk()->assertJsonPath('status', 'cancelled');
        $this->post($s2['uploadUrl'], ['document' => $this->scannedPdf()], ['Accept' => 'application/json'])
            ->assertStatus(409)->assertJsonPath('error.code', 'SESSION_CLOSED');
    }

    public function test_csrf_is_enforced_for_session_cookie_requests(): void
    {
        // Laravel skips CSRF while running unit tests; force it on for this test.
        $this->app->bind(PreventRequestForgery::class, fn ($app) => new class($app, $app['encrypter']) extends PreventRequestForgery
        {
            protected function runningUnitTests()
            {
                return false;
            }
        });
        $this->actingAs($this->user());
        $this->postJson('/document-scanner/sessions')->assertStatus(419);
        $this->postJson('/document-scanner/agent-token')->assertStatus(419);
    }

    public function test_pairing_token_endpoint(): void
    {
        $this->actingAs($this->user());
        $res = $this->postJson('/document-scanner/agent-token')->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        $this->assertStringStartsWith('v1.', $res->json('token'));
        $payload = json_decode(base64_decode(strtr(explode('.', $res->json('token'))[1], '-_', '+/')), true);
        $this->assertSame('http://localhost', $payload['o'], 'bound to the request origin');
        $this->assertStringNotContainsString(self::SECRET, $res->getContent());

        config(['document-scanner.agent.origin' => 'https://app.example.com']);
        $payload = json_decode(base64_decode(strtr(explode('.', $this->postJson('/document-scanner/agent-token')->json('token'))[1], '-_', '+/')), true);
        $this->assertSame('https://app.example.com', $payload['o']);

        config(['document-scanner.agent.pairing_secret' => '']);
        $this->postJson('/document-scanner/agent-token')->assertStatus(503)->assertJsonPath('error.code', 'AGENT_PAIRING_NOT_CONFIGURED');
    }

    public function test_upload_rate_limit(): void
    {
        Storage::fake('local');
        config(['document-scanner.rate_limits.uploads_per_minute' => 2]);
        $session = $this->newSession();
        $empty = fn () => $this->post($session['uploadUrl'], ['document' => UploadedFile::fake()->createWithContent('a.pdf', '')], ['Accept' => 'application/json']);
        $empty()->assertStatus(422);
        $empty()->assertStatus(422);
        $empty()->assertStatus(429);
    }

    public function test_prune_command_expires_and_deletes_stale_sessions_but_keeps_documents(): void
    {
        Storage::fake('local');
        $user = $this->user();
        $done = $this->newSession($user);
        $this->post($done['uploadUrl'], ['document' => $this->scannedPdf(), 'pages' => 3], ['Accept' => 'application/json'])->assertCreated();
        $stale = $this->newSession($user);
        ScanSession::whereKey($stale['id'])->update(['expires_at' => now()->subDays(3)]);

        $this->artisan('document-scanner:prune')->assertSuccessful();
        $this->assertSame('expired', ScanSession::find($stale['id'])->status);
        ScanSession::whereKey($stale['id'])->update(['updated_at' => now()->subDays(2)]);
        $this->artisan('document-scanner:prune')->assertSuccessful();
        $this->assertNull(ScanSession::find($stale['id']));
        $this->assertNotNull(ScanSession::find($done['id']));
        $this->assertSame(1, ScannedDocument::count());
    }
}
