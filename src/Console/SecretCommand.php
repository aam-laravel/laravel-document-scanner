<?php

namespace Aam\DocumentScanner\Console;

use Illuminate\Console\Command;

/**
 * Prints a new random pairing secret. It is not written anywhere: put it in
 * .env (DOCUMENT_SCANNER_AGENT_SECRET) and in the agent config
 * (sites[].pairingSecret) through your own secure deployment channel.
 */
class SecretCommand extends Command
{
    protected $signature = 'document-scanner:secret';

    protected $description = 'Generate a random pairing secret for the local scanner agent';

    public function handle(): int
    {
        $secret = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $this->line($secret);
        $this->line('<comment>Store it as DOCUMENT_SCANNER_AGENT_SECRET in .env and as sites[].pairingSecret in the agent config.</comment>', verbosity: 'v');

        return self::SUCCESS;
    }
}
