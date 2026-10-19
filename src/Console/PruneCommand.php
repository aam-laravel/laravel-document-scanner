<?php

namespace Aam\DocumentScanner\Console;

use Aam\DocumentScanner\Models\ScanSession;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;

/**
 * Marks open sessions past their expiry as expired and deletes expired /
 * cancelled sessions without a document after the retention window.
 * Stored documents are never deleted by this command.
 * Schedule it: Schedule::command('document-scanner:prune')->hourly();
 */
class PruneCommand extends Command
{
    protected $signature = 'document-scanner:prune {--dry-run : Only report what would change}';

    protected $description = 'Expire and delete stale scan sessions (documents are kept)';

    public function handle(): int
    {
        $now = Carbon::now();
        $expire = ScanSession::query()->where('status', ScanSession::STATUS_OPEN)->where('expires_at', '<', $now);
        $cutoff = $now->copy()->subHours((int) config('document-scanner.retention.prune_sessions_after_hours', 24));
        $delete = ScanSession::query()
            ->whereIn('status', [ScanSession::STATUS_EXPIRED, ScanSession::STATUS_CANCELLED])
            ->where('updated_at', '<', $cutoff)
            ->whereDoesntHave('document');

        if ($this->option('dry-run')) {
            $this->info("Would expire {$expire->count()} and delete {$delete->count()} session(s).");

            return self::SUCCESS;
        }
        $expired = $expire->update(['status' => ScanSession::STATUS_EXPIRED, 'updated_at' => $now]);
        $deleted = $delete->delete();
        $this->info("Expired {$expired} and deleted {$deleted} session(s).");

        return self::SUCCESS;
    }
}
