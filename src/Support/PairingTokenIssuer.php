<?php

namespace Aam\DocumentScanner\Support;

use Aam\DocumentScanner\Exceptions\ScannerException;

/**
 * Mints short-lived, single-use pairing tokens for the local agent:
 *   v1.<base64url(json{o: origin, n: nonce, e: expiry})>.<base64url(HMAC-SHA256(secret, "v1.".payload))>
 * The agent verifies signature, origin (must equal the browser's Origin
 * header), expiry and nonce reuse. The secret itself never leaves the server.
 */
class PairingTokenIssuer
{
    public function __construct(private readonly ?string $secret, private readonly int $ttl = 60) {}

    /**
     * @return array{token: string, expiresAt: string}
     */
    public function issue(string $origin, ?int $now = null): array
    {
        if ($this->secret === null || strlen($this->secret) < 32) {
            throw new ScannerException('AGENT_PAIRING_NOT_CONFIGURED', 503);
        }
        $now ??= time();
        $exp = $now + max(10, min($this->ttl, 300));
        $payload = self::b64(json_encode(['o' => $origin, 'n' => self::b64(random_bytes(16)), 'e' => $exp], JSON_UNESCAPED_SLASHES));
        $sig = self::b64(hash_hmac('sha256', 'v1.'.$payload, $this->secret, true));

        return ['token' => "v1.{$payload}.{$sig}", 'expiresAt' => gmdate('c', $exp)];
    }

    private static function b64(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }
}
