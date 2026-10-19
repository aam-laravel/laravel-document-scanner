<?php

namespace Aam\DocumentScanner\Http\Middleware;

use Aam\DocumentScanner\Exceptions\ScannerException;
use Aam\DocumentScanner\Support\CorrelationId;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

/**
 * Applied to every package route: feature switch, authenticated user,
 * optional Gate ability, correlation id propagation.
 */
class ScannerMiddleware
{
    public function handle(Request $request, Closure $next): Response
    {
        $cid = CorrelationId::fromHeader($request->header('X-Correlation-Id'));
        Log::withContext(['correlation_id' => $cid]);

        if (! config('document-scanner.enabled')) {
            abort(404);
        }
        if ($request->user() === null) {
            return ScannerException::response('UNAUTHENTICATED', 401);
        }
        $ability = config('document-scanner.authorization.ability');
        if ($ability && Gate::has($ability) && Gate::denies($ability)) {
            return ScannerException::response('FORBIDDEN', 403);
        }

        $response = $next($request);
        $response->headers->set('X-Correlation-Id', $cid);

        return $response;
    }
}
