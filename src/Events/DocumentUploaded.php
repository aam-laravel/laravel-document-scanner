<?php

namespace Aam\DocumentScanner\Events;

use Aam\DocumentScanner\Models\ScannedDocument;
use Aam\DocumentScanner\Models\ScanSession;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Dispatched only after the scanned file was validated, written to the disk
 * and its record committed. Listen to it for post-processing (e.g. a queued
 * OCR job or attaching the document to an application model).
 */
class DocumentUploaded
{
    use Dispatchable;

    public function __construct(public readonly ScannedDocument $document, public readonly ScanSession $session) {}
}
