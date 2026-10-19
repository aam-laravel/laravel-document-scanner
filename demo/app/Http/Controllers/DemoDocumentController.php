<?php

namespace App\Http\Controllers;

use Aam\DocumentScanner\Models\ScannedDocument;
use Aam\DocumentScanner\Support\PdfInspector;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class DemoDocumentController extends Controller
{
    public function create()
    {
        return view('demo.create');
    }

    /**
     * Option A: the scanner widget already uploaded and validated the PDF via the
     * package endpoint; the form only carries the document id. Always re-check
     * ownership: never trust an id coming from the browser.
     */
    public function store(Request $request)
    {
        $data = $request->validate([
            'subject' => ['required', 'string', 'max:150'],
            'scanned_document_id' => ['required', 'ulid'],
        ]);

        $document = ScannedDocument::query()
            ->ownedBy($request->user())
            ->findOrFail($data['scanned_document_id']);

        return redirect()->route('documents.create')->with('status', __('Saved ":subject" with document :file (:pages pages).', [
            'subject' => $data['subject'],
            'file' => $document->filename,
            'pages' => $document->pages,
        ]));
    }

    public function createFile()
    {
        return view('demo.create-file');
    }

    /**
     * Option B: classic multipart upload. The widget put the generated PDF into
     * <input type="file" name="document">. Validate the real content and store
     * it on a private disk under a random name.
     */
    public function storeFile(Request $request, PdfInspector $inspector)
    {
        $request->validate([
            'document' => ['required', 'file', 'mimetypes:application/pdf', 'max:20480'],
        ]);

        $info = $inspector->inspect($request->file('document')->getRealPath());
        if (! $info['valid'] || $info['active_content'] !== []) {
            return back()->withErrors(['document' => __('The PDF is not valid.')]);
        }

        $path = $request->file('document')->storeAs('scanned-documents/form', Str::ulid().'.pdf', 'local');

        return redirect()->route('documents.create-file')->with('status', __('Stored privately (:pages pages). Internal path is not shown to users.', ['pages' => $info['pages']]))
            ->with('stored_path_for_demo_log', $path);
    }
}
