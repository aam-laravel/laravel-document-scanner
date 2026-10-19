<?php

namespace Aam\DocumentScanner\Console;

use Aam\DocumentScanner\Support\FileInspector;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Verifies the server-side installation. It cannot check the agent: the agent
 * runs on each user's machine and is only reachable from their browser.
 */
class CheckCommand extends Command
{
    protected $signature = 'document-scanner:check';

    protected $description = 'Check the document scanner configuration (storage, secrets, routes, migrations, security settings)';

    private int $errors = 0;

    public function handle(): int
    {
        $c = config('document-scanner');

        $this->line('<info>Document scanner installation check</info>');
        $this->check('Feature enabled', (bool) $c['enabled'], 'DOCUMENT_SCANNER_ENABLED=false', warnOnly: true);

        $mode = $c['agent']['pairing_mode'];
        $this->check('Pairing mode is signed|code', in_array($mode, ['signed', 'code'], true), "invalid pairing_mode \"{$mode}\"");
        if ($mode === 'signed') {
            $len = strlen((string) $c['agent']['pairing_secret']);
            $this->check('Agent pairing secret set (>= 32 chars)', $len >= 32, 'set DOCUMENT_SCANNER_AGENT_SECRET (php artisan document-scanner:secret)');
        }
        $agentUrl = (string) $c['agent']['url'];
        $host = parse_url($agentUrl, PHP_URL_HOST);
        $this->check('Agent URL is loopback', in_array($host, ['127.0.0.1', 'localhost', '[::1]', '::1'], true), "agent.url \"{$agentUrl}\" is not a loopback address");
        $this->check('Agent download URL configured', ! empty($c['agent']['download_url']), 'DOCUMENT_SCANNER_AGENT_DOWNLOAD_URL not set: the UI will say no download is available', warnOnly: true);

        $this->check('Accepted types are known', array_diff($c['accepted_types'], array_keys(FileInspector::TYPES)) === [], 'unknown entries in accepted_types');
        $this->check('Max file size within PHP upload_max_filesize', $this->phpBytes(ini_get('upload_max_filesize')) >= $c['limits']['max_file_size_kb'] * 1024, 'raise upload_max_filesize / post_max_size or lower DOCUMENT_SCANNER_MAX_KB', warnOnly: true);
        $this->check('Max file size within PHP post_max_size', $this->phpBytes(ini_get('post_max_size')) >= $c['limits']['max_file_size_kb'] * 1024, 'raise post_max_size', warnOnly: true);

        $disk = $c['storage']['disk'];
        try {
            $probe = trim($c['storage']['path'], '/').'/.document-scanner-check';
            Storage::disk($disk)->put($probe, 'ok', ['visibility' => 'private']);
            Storage::disk($disk)->delete($probe);
            $this->check("Storage disk \"{$disk}\" writable", true);
        } catch (Throwable $e) {
            $this->check("Storage disk \"{$disk}\" writable", false, $e->getMessage());
        }
        $visibility = config("filesystems.disks.{$disk}.visibility");
        $this->check("Disk \"{$disk}\" is not public", $disk !== 'public' && $visibility !== 'public', 'scanned documents should be stored on a private disk', warnOnly: true);

        try {
            $tables = Schema::hasTable('document_scanner_sessions') && Schema::hasTable('document_scanner_documents');
        } catch (Throwable) {
            $tables = false;
        }
        $this->check('Database tables migrated', $tables, 'run php artisan migrate');

        $name = $c['routes']['name'];
        $this->check('Routes registered', ! $c['routes']['enabled'] || Route::has($name.'sessions.upload'), 'routes are disabled or not loaded');
        $this->check('Routes use the web (session + CSRF) middleware', in_array('web', (array) $c['routes']['middleware'], true), 'without "web" there is no CSRF protection', warnOnly: true);
        $this->check('Routes require authentication', collect((array) $c['routes']['middleware'])->contains(fn ($m) => str_starts_with($m, 'auth')), 'add "auth" to routes.middleware', warnOnly: true);

        if (app()->environment('production')) {
            $this->check('APP_DEBUG is off in production', ! config('app.debug'), 'set APP_DEBUG=false');
            $this->check('APP_URL uses HTTPS', str_starts_with((string) config('app.url'), 'https://'), 'serve the application over HTTPS');
            $this->check('Simulator disabled in production', ! $c['agent']['allow_simulator'], 'set DOCUMENT_SCANNER_ALLOW_SIMULATOR=false', warnOnly: true);
        }
        $this->check('OCR not enabled (not implemented by this package)', ! $c['features']['ocr'], 'features.ocr=true has no effect; implement OCR via the DocumentUploaded event', warnOnly: true);

        $this->newLine();
        $this->line($this->errors ? "<error>{$this->errors} problem(s) found.</error>" : '<info>All required checks passed.</info>');
        $this->line('Note: the local agent is checked from the browser (scanner page), not from this server.');

        return $this->errors ? self::FAILURE : self::SUCCESS;
    }

    private function check(string $label, bool $ok, string $hint = '', bool $warnOnly = false): void
    {
        if ($ok) {
            $this->line("  <info>✔</info> {$label}");

            return;
        }
        if ($warnOnly) {
            $this->line("  <comment>!</comment> {$label} — {$hint}");

            return;
        }
        $this->errors++;
        $this->line("  <error>✘</error> {$label} — {$hint}");
    }

    private function phpBytes(string|false $value): int
    {
        $value = trim((string) $value);
        if ($value === '' || $value === '-1' || $value === '0') {
            return PHP_INT_MAX;
        }
        $n = (int) $value;

        return match (strtolower(substr($value, -1))) {
            'g' => $n * 1024 ** 3,
            'm' => $n * 1024 ** 2,
            'k' => $n * 1024,
            default => $n,
        };
    }
}
