<?php

namespace Aam\DocumentScanner\Policies;

use Aam\DocumentScanner\Models\ScanSession;
use Illuminate\Contracts\Auth\Authenticatable;

class ScanSessionPolicy
{
    public function view(Authenticatable $user, ScanSession $session): bool
    {
        return $session->isOwnedBy($user);
    }

    public function upload(Authenticatable $user, ScanSession $session): bool
    {
        return $session->isOwnedBy($user);
    }

    public function cancel(Authenticatable $user, ScanSession $session): bool
    {
        return $session->isOwnedBy($user);
    }
}
