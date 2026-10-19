<?php

use App\Http\Controllers\DemoDocumentController;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Route;

/*
| Demo application for aam/laravel-document-scanner.
| /demo/login is a development convenience and only exists in the local environment.
*/

Route::middleware('web')->group(function () {
    Route::get('/', fn () => view('demo.index'))->name('home');

    Route::get('/login', fn () => view('demo.login'))->name('login');

    if (app()->isLocal()) {
        Route::get('/demo/login', function () {
            $user = User::firstOrCreate(['email' => 'demo@example.test'], ['name' => 'Demo User', 'password' => bcrypt(str()->random(32))]);
            Auth::login($user);
            request()->session()->regenerate();

            return redirect()->route('documents.create');
        })->name('demo.login');
    }

    Route::get('/locale/{locale}', function (Request $request, string $locale) {
        abort_unless(in_array($locale, ['ar', 'en'], true), 404);
        $request->session()->put('locale', $locale);

        return back();
    })->name('locale');

    Route::middleware('auth')->group(function () {
        // Option A: package uploads the PDF; the form receives the document id.
        Route::get('/documents/create', [DemoDocumentController::class, 'create'])->name('documents.create');
        Route::post('/documents', [DemoDocumentController::class, 'store'])->name('documents.store');

        // Option B: the PDF is attached to a regular <input type="file"> and posted with the form.
        Route::get('/documents/create-file', [DemoDocumentController::class, 'createFile'])->name('documents.create-file');
        Route::post('/documents/file', [DemoDocumentController::class, 'storeFile'])->name('documents.store-file');

        // Option C: JavaScript API on a custom page.
        Route::get('/documents/js-api', fn () => view('demo.js-api'))->name('documents.js-api');

        Route::post('/logout', function (Request $request) {
            Auth::logout();
            $request->session()->invalidate();
            $request->session()->regenerateToken();

            return redirect('/');
        })->name('logout');
    });
});
