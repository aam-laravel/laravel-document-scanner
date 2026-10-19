<?php

namespace Aam\DocumentScanner;

use Aam\DocumentScanner\Console\CheckCommand;
use Aam\DocumentScanner\Console\PruneCommand;
use Aam\DocumentScanner\Console\SecretCommand;
use Aam\DocumentScanner\Models\ScannedDocument;
use Aam\DocumentScanner\Models\ScanSession;
use Aam\DocumentScanner\Policies\ScannedDocumentPolicy;
use Aam\DocumentScanner\Policies\ScanSessionPolicy;
use Aam\DocumentScanner\Support\FileInspector;
use Aam\DocumentScanner\Support\FileNamer;
use Aam\DocumentScanner\Support\PairingTokenIssuer;
use Aam\DocumentScanner\Support\PdfInspector;
use Aam\DocumentScanner\View\Components\Scanner;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class DocumentScannerServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/document-scanner.php', 'document-scanner');

        $this->app->singleton(PdfInspector::class);
        $this->app->bind(FileInspector::class, fn ($app) => new FileInspector($app->make(PdfInspector::class), $app['config']['document-scanner']));
        $this->app->bind(FileNamer::class, fn ($app) => new FileNamer($app['config']['document-scanner']));
        $this->app->bind(PairingTokenIssuer::class, fn ($app) => new PairingTokenIssuer(
            $app['config']['document-scanner.agent.pairing_secret'],
            (int) $app['config']['document-scanner.agent.pairing_token_ttl'],
        ));
        $this->app->bind(DocumentScanner::class, fn ($app) => new DocumentScanner(
            $app['config']['document-scanner'],
            $app->make(FileInspector::class),
            $app->make(FileNamer::class),
            $app->make(PairingTokenIssuer::class),
            $app['events'],
        ));
        $this->app->alias(DocumentScanner::class, 'document-scanner');
    }

    public function boot(): void
    {
        $this->loadTranslationsFrom(__DIR__.'/../lang', 'document-scanner');
        $this->loadViewsFrom(__DIR__.'/../resources/views', 'document-scanner');
        $this->loadMigrationsFrom(__DIR__.'/../database/migrations');
        Blade::component('document-scanner', Scanner::class);

        Gate::policy(ScanSession::class, ScanSessionPolicy::class);
        Gate::policy(ScannedDocument::class, ScannedDocumentPolicy::class);

        $this->registerRateLimiters();

        if (config('document-scanner.routes.enabled')) {
            $this->loadRoutesFrom(__DIR__.'/../routes/web.php');
        }

        if ($this->app->runningInConsole()) {
            $this->commands([CheckCommand::class, PruneCommand::class, SecretCommand::class]);

            $this->publishes([__DIR__.'/../config/document-scanner.php' => config_path('document-scanner.php')], 'document-scanner-config');
            $this->publishes([__DIR__.'/../database/migrations' => database_path('migrations')], 'document-scanner-migrations');
            $this->publishes([__DIR__.'/../lang' => $this->app->langPath('vendor/document-scanner')], 'document-scanner-lang');
            $this->publishes([__DIR__.'/../resources/views' => resource_path('views/vendor/document-scanner')], 'document-scanner-views');
            $this->publishes([__DIR__.'/../resources/dist' => public_path('vendor/document-scanner')], 'document-scanner-assets');
        }
    }

    private function registerRateLimiters(): void
    {
        $key = fn (Request $r) => $r->user()?->getAuthIdentifier() ?? $r->ip();
        RateLimiter::for('document-scanner-upload', fn (Request $r) => Limit::perMinute((int) config('document-scanner.rate_limits.uploads_per_minute', 10))->by('ds-up:'.$key($r)));
        RateLimiter::for('document-scanner-session', fn (Request $r) => Limit::perMinute((int) config('document-scanner.rate_limits.sessions_per_minute', 30))->by('ds-se:'.$key($r)));
        RateLimiter::for('document-scanner-token', fn (Request $r) => Limit::perMinute((int) config('document-scanner.rate_limits.tokens_per_minute', 30))->by('ds-tk:'.$key($r)));
    }
}
