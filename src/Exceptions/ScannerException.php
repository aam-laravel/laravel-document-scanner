<?php

namespace Aam\DocumentScanner\Exceptions;

use Aam\DocumentScanner\Support\CorrelationId;
use Illuminate\Http\JsonResponse;
use RuntimeException;

/**
 * Error with a stable `code` rendered as the package's unified JSON error
 * shape: {"error": {"code", "message", "correlationId", "fields"?}}.
 * Messages are translated; internal details are only logged.
 */
class ScannerException extends RuntimeException
{
    /**
     * @param  array<string, array<int, string>>  $fields
     */
    public function __construct(
        public readonly string $errorCode,
        public readonly int $status = 422,
        public readonly array $fields = [],
        ?string $message = null,
    ) {
        parent::__construct($message ?? self::translate($errorCode));
    }

    public static function translate(string $code): string
    {
        $key = 'document-scanner::messages.errors.'.$code;
        $text = __($key);

        return $text === $key ? __('document-scanner::messages.errors.UNKNOWN') : $text;
    }

    public function render(): JsonResponse
    {
        return static::response($this->errorCode, $this->status, $this->fields, $this->getMessage());
    }

    public static function response(string $code, int $status, array $fields = [], ?string $message = null): JsonResponse
    {
        $error = [
            'code' => $code,
            'message' => $message ?? self::translate($code),
            'correlationId' => CorrelationId::current(),
        ];
        if ($fields) {
            $error['fields'] = $fields;
        }

        return new JsonResponse(['error' => $error], $status, ['X-Correlation-Id' => CorrelationId::current()]);
    }
}
