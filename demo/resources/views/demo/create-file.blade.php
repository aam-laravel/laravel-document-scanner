@extends('demo.layout')

@section('content')
<form method="POST" action="{{ route('documents.store-file') }}" enctype="multipart/form-data" class="box">
    @csrf
    <h1>B — PDF in a regular file input</h1>
    <p>With <code>output="form-file"</code> the widget creates the PDF and places it into <code>&lt;input type="file" name="document"&gt;</code>. Submitting the form sends the file like any other upload.</p>

    <x-document-scanner name="document" output="form-file" :required="true" />

    <button type="submit" class="submit">Submit form with PDF</button>
</form>
@endsection
