<?php

namespace Aam\DocumentScanner\Http\Controllers;

use Illuminate\Routing\Controller;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/** Serves the package's browser assets from a fixed whitelist (no path input reaches the filesystem). */
class AssetController extends Controller
{
    public const FILES = [
        'document-scanner.js' => 'application/javascript',
        'scanner-app.js' => 'application/javascript',
        'agent-client.js' => 'application/javascript',
        'pdf-writer.js' => 'application/javascript',
        'page-store.js' => 'application/javascript',
        'image-tools.js' => 'application/javascript',
        'uploader.js' => 'application/javascript',
        'errors.js' => 'application/javascript',
        'document-scanner.css' => 'text/css',
    ];

    public function __invoke(string $file): BinaryFileResponse
    {
        abort_unless(isset(self::FILES[$file]), 404);
        $path = dirname(__DIR__, 3).'/resources/dist/'.$file;
        abort_unless(is_file($path), 404);

        return response()->file($path, [
            'Content-Type' => self::FILES[$file].'; charset=utf-8',
            // ES modules import each other without a version query, so always revalidate (304 via Last-Modified).
            'Cache-Control' => 'public, no-cache',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }
}
