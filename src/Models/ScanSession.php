<?php

namespace Aam\DocumentScanner\Models;

use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasOne;

/**
 * @property string $id
 * @property string $owner_type
 * @property string $owner_id
 * @property string $status
 * @property string|null $correlation_id
 * @property array|null $client_meta
 * @property \Illuminate\Support\Carbon $expires_at
 */
class ScanSession extends Model
{
    use HasUlids;

    public const STATUS_OPEN = 'open';

    public const STATUS_COMPLETED = 'completed';

    public const STATUS_CANCELLED = 'cancelled';

    public const STATUS_EXPIRED = 'expired';

    protected $table = 'document_scanner_sessions';

    protected $guarded = [];

    protected $hidden = ['owner_type', 'owner_id'];

    protected function casts(): array
    {
        return [
            'client_meta' => 'array',
            'expires_at' => 'datetime',
        ];
    }

    public function document(): HasOne
    {
        return $this->hasOne(ScannedDocument::class, 'session_id');
    }

    public function isOwnedBy(?Authenticatable $user): bool
    {
        return $user !== null
            && $this->owner_type === $user->getMorphClass()
            && (string) $this->owner_id === (string) $user->getAuthIdentifier();
    }

    public function isExpired(): bool
    {
        return $this->expires_at->isPast();
    }

    public function acceptsUploads(): bool
    {
        return $this->status === self::STATUS_OPEN && ! $this->isExpired();
    }

    public function scopeOwnedBy(Builder $query, Authenticatable $user): Builder
    {
        return $query->where('owner_type', $user->getMorphClass())->where('owner_id', (string) $user->getAuthIdentifier());
    }
}
