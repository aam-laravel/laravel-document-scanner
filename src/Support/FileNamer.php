<?php

namespace Aam\DocumentScanner\Support;

use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * Display names are sanitised (Unicode letters incl. Arabic are kept; path
 * separators, control and reserved characters are removed). Storage names are
 * random ULIDs and never derived from user input.
 */
class FileNamer
{
    public function __construct(private readonly array $config) {}

    public function displayName(?string $requested, string $extension, ?Carbon $now = null): string
    {
        $now ??= Carbon::now();
        $base = null;
        if ($requested !== null && ($this->config['filenames']['allow_user_names'] ?? true)) {
            $base = $this->sanitize($requested, $extension);
        }
        if ($base === null || $base === '') {
            $base = strtr($this->config['filenames']['pattern'] ?? 'scan-{date}-{time}', [
                '{date}' => $now->format('Ymd'),
                '{time}' => $now->format('His'),
            ]);
            $base = $this->sanitize($base, $extension) ?: 'scan';
        }

        return $base.'.'.$extension;
    }

    public function sanitize(string $name, string $extension): string
    {
        $name = basename(str_replace('\\', '/', $name));
        // drop a trailing extension that matches (or any extension) so we control it
        $name = preg_replace('/\.'.preg_quote($extension, '/').'$/i', '', $name) ?? '';
        // remove control chars, bidi overrides and characters reserved on common filesystems
        $name = preg_replace('/[\x00-\x1F\x7F<>:"\/\\\\|?*\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $name) ?? '';
        $name = preg_replace('/[^\p{L}\p{M}\p{N} ._()\-]/u', '', $name) ?? '';
        $name = preg_replace('/\s+/u', ' ', $name) ?? '';
        $name = trim($name, " .-_");
        $max = (int) ($this->config['filenames']['max_length'] ?? 100);

        return Str::limit($name, $max, '');
    }

    public function storagePath(string $id, string $extension, ?Carbon $now = null): string
    {
        $now ??= Carbon::now();
        $dir = trim((string) ($this->config['storage']['path'] ?? 'scanned-documents'), '/');

        return ($dir !== '' ? $dir.'/' : '').$now->format('Y/m').'/'.strtolower($id).'.'.$extension;
    }
}
