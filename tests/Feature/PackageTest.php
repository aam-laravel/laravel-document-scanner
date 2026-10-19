<?php

namespace Aam\DocumentScanner\Tests\Feature;

use Aam\DocumentScanner\DocumentScanner;
use Aam\DocumentScanner\Facades\DocumentScanner as Facade;
use Aam\DocumentScanner\Tests\TestCase;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Route;

class PackageTest extends TestCase
{
    public function test_services_config_and_routes_are_registered(): void
    {
        $this->assertInstanceOf(DocumentScanner::class, app(DocumentScanner::class));
        $this->assertSame('http://127.0.0.1:47115', Facade::config('agent.url'));
        $this->assertSame(['pdf'], config('document-scanner.accepted_types'));
        foreach (['page', 'config', 'agent-token', 'sessions.store', 'sessions.show', 'sessions.destroy', 'sessions.preflight', 'sessions.upload', 'documents.show', 'documents.download', 'documents.destroy', 'assets'] as $name) {
            $this->assertTrue(Route::has('document-scanner.'.$name), $name);
        }
        $upload = Route::getRoutes()->getByName('document-scanner.sessions.upload');
        $this->assertContains('web', $upload->gatherMiddleware(), 'web group provides session + CSRF');
        $this->assertContains('auth', $upload->gatherMiddleware());
        $this->assertContains('throttle:document-scanner-upload', $upload->gatherMiddleware());
    }

    public function test_translations_exist_in_arabic_and_english_with_the_same_keys(): void
    {
        $en = require __DIR__.'/../../lang/en/messages.php';
        $ar = require __DIR__.'/../../lang/ar/messages.php';
        $flat = fn ($a, $p = '') => collect($a)->flatMap(fn ($v, $k) => is_array($v) ? (fn ($x) => $x)(collect($v)->keys()->map(fn ($kk) => "$p$k.$kk")) : ["$p$k"])->sort()->values()->all();
        $this->assertSame($flat($en), $flat($ar));
        app()->setLocale('ar');
        $this->assertSame('الماسح مشغول. انتظر حتى تنتهي المهمة الحالية.', __('document-scanner::messages.errors.DEVICE_BUSY'));
        app()->setLocale('en');
        $this->assertStringContainsString('busy', __('document-scanner::messages.errors.DEVICE_BUSY'));
    }

    public function test_blade_component_renders_config_without_secrets(): void
    {
        $this->actingAs($this->user());
        app()->setLocale('ar');
        $html = Blade::render('<form><x-document-scanner name="doc_id" :required="true" /></form>');
        $this->assertStringContainsString('data-document-scanner', $html);
        $this->assertStringContainsString('dir="rtl"', $html);
        $this->assertStringContainsString('name="doc_id"', $html);
        $this->assertStringContainsString('type="hidden"', $html);
        $this->assertStringContainsString('document-scanner.js', $html);
        $this->assertStringNotContainsString(self::SECRET, $html);

        $file = Blade::render('<x-document-scanner name="document" output="form-file" />');
        $this->assertStringContainsString('type="file"', $file);
        $this->assertStringContainsString('name="document"', $file);
    }

    public function test_component_renders_notice_for_guests_and_when_disabled(): void
    {
        $this->assertStringContainsString('ds-unavailable', Blade::render('<x-document-scanner />'));
        config(['document-scanner.enabled' => false]);
        $this->actingAs($this->user());
        $this->assertStringContainsString('ds-unavailable', Blade::render('<x-document-scanner />'));
    }

    public function test_client_config_exposes_no_secret_and_no_storage_details(): void
    {
        $this->actingAs($this->user());
        $res = $this->getJson('/document-scanner/config')->assertOk();
        $body = $res->getContent();
        $this->assertStringNotContainsString(self::SECRET, $body);
        $this->assertStringNotContainsString('scanned-documents', $body);
        $res->assertJsonPath('agent.url', 'http://127.0.0.1:47115')->assertJsonPath('agent.pairingMode', 'signed');
        $this->assertNotEmpty($res->json('csrfToken'));
        $this->assertNotEmpty($res->headers->get('X-Correlation-Id'));
    }

    public function test_scanner_page_and_assets(): void
    {
        $this->actingAs($this->user());
        $this->get('/document-scanner')->assertOk()->assertSee('data-document-scanner', false);
        $this->get('/document-scanner/assets/document-scanner.js')->assertOk()->assertHeader('X-Content-Type-Options', 'nosniff');
        $this->get('/document-scanner/assets/..%2F..%2Fcomposer.json')->assertNotFound();
        $this->get('/document-scanner/assets/unknown.js')->assertNotFound();
    }

    public function test_feature_switch_and_gate(): void
    {
        $this->actingAs($this->user());
        Gate::define('use-document-scanner', fn () => false);
        $this->getJson('/document-scanner/config')->assertForbidden()->assertJsonPath('error.code', 'FORBIDDEN');
        config(['document-scanner.enabled' => false]);
        $this->getJson('/document-scanner/config')->assertNotFound();
    }

    public function test_guests_are_rejected_everywhere(): void
    {
        $this->getJson('/document-scanner/config')->assertUnauthorized();
        $this->postJson('/document-scanner/agent-token')->assertUnauthorized();
        $this->postJson('/document-scanner/sessions')->assertUnauthorized();
    }

    public function test_artisan_commands(): void
    {
        $this->artisan('document-scanner:secret')->assertSuccessful();
        $this->artisan('document-scanner:check')->assertSuccessful();
        config(['document-scanner.agent.pairing_secret' => null]);
        $this->artisan('document-scanner:check')->assertFailed();
    }
}
