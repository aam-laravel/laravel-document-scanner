<?php

namespace Aam\DocumentScanner\Support;

use Illuminate\Support\Str;

/**
 * Per-request correlation id shared by browser, agent and server logs.
 * Accepts the client's X-Correlation-Id when well-formed.
 */
final class CorrelationId
{
    private static ?string $current = null;

    public static function fromHeader(?string $header): string
    {
        self::$current = ($header !== null && preg_match('/^[A-Za-z0-9_-]{8,64}$/', $header))
            ? $header
            : (string) Str::uuid();

        return self::$current;
    }

    public static function current(): string
    {
        return self::$current ??= (string) Str::uuid();
    }

    public static function reset(): void
    {
        self::$current = null;
    }
}
