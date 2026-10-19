<?php

namespace Aam\DocumentScanner\Facades;

use Illuminate\Support\Facades\Facade;

/**
 * @method static \Aam\DocumentScanner\Models\ScanSession createSession(\Illuminate\Contracts\Auth\Authenticatable $user, array $clientMeta = [])
 * @method static void cancelSession(\Aam\DocumentScanner\Models\ScanSession $session)
 * @method static array store(\Aam\DocumentScanner\Models\ScanSession $session, \Illuminate\Http\UploadedFile $file, array $input = [])
 * @method static void delete(\Aam\DocumentScanner\Models\ScannedDocument $document)
 * @method static array present(\Aam\DocumentScanner\Models\ScannedDocument $document)
 * @method static array clientConfig(?string $locale = null)
 * @method static array pairingToken(string $requestOrigin)
 * @method static mixed config(?string $key = null, mixed $default = null)
 *
 * @see \Aam\DocumentScanner\DocumentScanner
 */
class DocumentScanner extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return \Aam\DocumentScanner\DocumentScanner::class;
    }
}
