<?php

use Aam\DocumentScanner\Http\Controllers\AgentTokenController;
use Aam\DocumentScanner\Http\Controllers\AssetController;
use Aam\DocumentScanner\Http\Controllers\ClientConfigController;
use Aam\DocumentScanner\Http\Controllers\DocumentController;
use Aam\DocumentScanner\Http\Controllers\ScannerPageController;
use Aam\DocumentScanner\Http\Controllers\ScanSessionController;
use Aam\DocumentScanner\Http\Middleware\ScannerMiddleware;
use Illuminate\Support\Facades\Route;

$config = config('document-scanner.routes');

Route::middleware([...(array) $config['middleware'], ScannerMiddleware::class])
    ->prefix($config['prefix'])
    ->name($config['name'])
    ->group(function () use ($config) {
        if ($config['page'] ?? true) {
            Route::get('/', ScannerPageController::class)->name('page');
        }
        Route::get('config', ClientConfigController::class)->name('config');
        Route::post('agent-token', AgentTokenController::class)
            ->middleware('throttle:document-scanner-token')->name('agent-token');

        Route::post('sessions', [ScanSessionController::class, 'store'])
            ->middleware('throttle:document-scanner-session')->name('sessions.store');
        Route::get('sessions/{session}', [ScanSessionController::class, 'show'])->whereUlid('session')->name('sessions.show');
        Route::delete('sessions/{session}', [ScanSessionController::class, 'destroy'])->whereUlid('session')->name('sessions.destroy');
        Route::post('sessions/{session}/preflight', [ScanSessionController::class, 'preflight'])->whereUlid('session')->name('sessions.preflight');
        Route::post('sessions/{session}/upload', [ScanSessionController::class, 'upload'])->whereUlid('session')
            ->middleware('throttle:document-scanner-upload')->name('sessions.upload');

        Route::get('documents/{document}', [DocumentController::class, 'show'])->whereUlid('document')->name('documents.show');
        Route::get('documents/{document}/download', [DocumentController::class, 'download'])->whereUlid('document')
            ->middleware('signed')->name('documents.download');
        Route::delete('documents/{document}', [DocumentController::class, 'destroy'])->whereUlid('document')->name('documents.destroy');
    });

if (config('document-scanner.assets.serve_from_route')) {
    // Static, non-sensitive browser assets: no session needed.
    Route::get($config['prefix'].'/assets/{file}', AssetController::class)
        ->where('file', '[a-z-]+\.(js|css)')
        ->name($config['name'].'assets');
}
