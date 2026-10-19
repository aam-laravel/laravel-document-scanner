<?php

namespace Aam\DocumentScanner\Tests;

use Aam\DocumentScanner\DocumentScannerServiceProvider;
use Aam\DocumentScanner\Support\CorrelationId;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Orchestra\Testbench\TestCase as Orchestra;

abstract class TestCase extends Orchestra
{
    use RefreshDatabase;

    public const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';

    protected function getPackageProviders($app): array
    {
        return [DocumentScannerServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('app.key', 'base64:'.base64_encode(str_repeat('k', 32)));
        $app['config']->set('database.default', 'testing');
        $app['config']->set('auth.providers.users.model', User::class);
        $app['config']->set('document-scanner.agent.pairing_secret', self::SECRET);
        $app['config']->set('document-scanner.storage.disk', 'local');
        $app['config']->set('filesystems.disks.local.root', sys_get_temp_dir().'/document-scanner-tests');
    }

    protected function defineDatabaseMigrations(): void
    {
        $this->loadMigrationsFrom(__DIR__.'/database/migrations');
    }

    protected function setUp(): void
    {
        parent::setUp();
        CorrelationId::reset();
    }

    protected function user(string $email = 'a@example.com'): User
    {
        return User::create(['name' => 'U', 'email' => $email, 'password' => bcrypt('x')]);
    }

    protected function fixture(string $name): string
    {
        return __DIR__.'/Fixtures/'.$name;
    }

    /** A real PDF produced by the browser PDF writer (tests/js writes it). */
    protected function scannedPdf(string $clientName = 'scan.pdf'): UploadedFile
    {
        $path = $this->fixture('generated-3-pages.pdf');
        if (! is_file($path)) {
            $this->markTestSkipped('Run `npm run test:js` (node --test tests/js) first to generate the PDF fixture.');
        }

        return UploadedFile::fake()->createWithContent($clientName, file_get_contents($path));
    }

    protected function minimalPdf(string $extra = '', int $pages = 1): string
    {
        $kids = implode(' ', array_map(fn ($i) => (3 + $i).' 0 R', range(0, $pages - 1)));
        $objs = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R {$extra} >>\nendobj\n2 0 obj\n<< /Type /Pages /Count {$pages} /Kids [{$kids}] >>\nendobj\n";
        for ($i = 0; $i < $pages; $i++) {
            $objs .= (3 + $i)." 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n";
        }

        return "%PDF-1.4\n{$objs}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R >>\nstartxref\n9\n%%EOF\n";
    }
}
