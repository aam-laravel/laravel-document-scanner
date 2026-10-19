<?php

namespace Aam\DocumentScanner\Events;

use Aam\DocumentScanner\Models\ScanSession;
use Illuminate\Foundation\Events\Dispatchable;

class ScanSessionCancelled
{
    use Dispatchable;

    public function __construct(public readonly ScanSession $session) {}
}
