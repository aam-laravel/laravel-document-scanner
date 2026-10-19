<?php

namespace Aam\DocumentScanner\Events;

use Illuminate\Foundation\Events\Dispatchable;

class DocumentDeleted
{
    use Dispatchable;

    public function __construct(public readonly string $documentId, public readonly string $ownerType, public readonly string $ownerId) {}
}
