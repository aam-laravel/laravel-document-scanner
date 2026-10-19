<?php

namespace Aam\DocumentScanner\Http\Controllers;

use Aam\DocumentScanner\DocumentScanner;
use Aam\DocumentScanner\Exceptions\ScannerException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;

/**
 * Hands the authenticated browser a short-lived pairing token for the local
 * agent (signed pairing mode). The shared secret never leaves the server.
 */
class AgentTokenController extends Controller
{
    public function __invoke(Request $request, DocumentScanner $scanner): JsonResponse
    {
        if ($scanner->config('agent.pairing_mode') !== 'signed') {
            throw new ScannerException('AGENT_PAIRING_NOT_CONFIGURED', 409);
        }

        return response()->json($scanner->pairingToken($request->getSchemeAndHttpHost()))
            ->header('Cache-Control', 'no-store');
    }
}
