@extends('demo.layout')

@section('content')
<form method="POST" action="{{ route('documents.store') }}" class="box">
    @csrf
    <h1>A — {{ __('document-scanner::messages.ui.title') }}</h1>
    <p>The widget uploads the PDF to the package endpoint. After a successful upload it writes the document id into the hidden input <code>scanned_document_id</code>; this form then submits only that id.</p>

    <label for="subject">Subject</label>
    <input id="subject" type="text" name="subject" value="{{ old('subject', 'Demo document') }}" required>

    <x-document-scanner name="scanned_document_id" output="upload" :required="true" title="Demo" category="demo" style="margin-top:16px" />

    <button type="submit" class="submit">Save record</button>
</form>
@endsection
