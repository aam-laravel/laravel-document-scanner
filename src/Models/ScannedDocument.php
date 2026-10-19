<?php

namespace Aam\DocumentScanner\Models;

use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Storage;

/**
 * A stored scanned document. The storage path is never exposed to clients;
 * downloads go through authorised routes.
 *
 * @property string $id
 * @property string|null $session_id
 * @property string $owner_type
 * @property string $owner_id
 * @property string $disk
 * @property string $path
 * @property string $filename
 * @property string $mime_type
 * @property int $size
 * @property int|null $pages
 * @property string $sha256
 * @property array|null $metadata
 */
class ScannedDocument extends Model
{
    use HasUlids;

    protected $table = 'document_scanner_documents';

    protected $guarded = [];

    protected $hidden = ['owner_type', 'owner_id', 'disk', 'path'];

    protected function casts(): array
    {
        return [
            'metadata' => 'array',
            'size' => 'integer',
            'pages' => 'integer',
        ];
    }

    public function session(): BelongsTo
    {
        return $this->belongsTo(ScanSession::class, 'session_id');
    }

    public function isOwnedBy(?Authenticatable $user): bool
    {
        return $user !== null
            && $this->owner_type === $user->getMorphClass()
            && (string) $this->owner_id === (string) $user->getAuthIdentifier();
    }

    public function scopeOwnedBy(Builder $query, Authenticatable $user): Builder
    {
        return $query->where('owner_type', $user->getMorphClass())->where('owner_id', (string) $user->getAuthIdentifier());
    }

    /** Delete the stored file together with the record. */
    public function deleteWithFile(): void
    {
        Storage::disk($this->disk)->delete($this->path);
        $this->delete();
    }
}
