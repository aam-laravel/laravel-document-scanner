<?php

namespace Aam\DocumentScanner\Events;

use Aam\DocumentScanner\Models\ScanSession;
use Illuminate\Foundation\Events\Dispatchable;

/** A user opened a scan/upload session (before scanning on their machine). */
class ScanSessionCreated
{
    use Dispatchable;

    public function __construct(public readonly ScanSession $session) {}
}
