<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

/** Demo: locale chosen via /locale/{ar|en}, defaulting to Arabic. */
class SetLocale
{
    public function handle(Request $request, Closure $next)
    {
        app()->setLocale($request->session()->get('locale', 'ar'));

        return $next($request);
    }
}
