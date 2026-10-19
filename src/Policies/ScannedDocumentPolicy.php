<?php

namespace Aam\DocumentScanner\Policies;

use Aam\DocumentScanner\Models\ScannedDocument;
use Illuminate\Contracts\Auth\Authenticatable;

/**
 * Owner-only by default. Applications that share documents (e.g. with an
 * admin role) can register their own policy for ScannedDocument via
 * Gate::policy() in a service provider booted after this package.
 */
class ScannedDocumentPolicy
{
    public function view(Authenticatable $user, ScannedDocument $document): bool
    {
        return $document->isOwnedBy($user);
    }

    public function download(Authenticatable $user, ScannedDocument $document): bool
    {
        return $document->isOwnedBy($user);
    }

    public function delete(Authenticatable $user, ScannedDocument $document): bool
    {
        return $document->isOwnedBy($user);
    }
}
