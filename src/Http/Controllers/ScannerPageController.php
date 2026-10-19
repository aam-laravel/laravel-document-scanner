<?php

namespace Aam\DocumentScanner\Http\Controllers;

use Illuminate\Contracts\View\View;
use Illuminate\Routing\Controller;

class ScannerPageController extends Controller
{
    public function __invoke(): View
    {
        return view('document-scanner::page');
    }
}
