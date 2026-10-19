<?php

namespace Aam\DocumentScanner\Http\Controllers;

use Aam\DocumentScanner\DocumentScanner;
use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;

/** Non-secret client configuration (agent URL, limits, translations, endpoints). */
class ClientConfigController extends Controller
{
    public function __invoke(DocumentScanner $scanner): JsonResponse
    {
        return response()->json($scanner->clientConfig() + ['csrfToken' => csrf_token()]);
    }
}
