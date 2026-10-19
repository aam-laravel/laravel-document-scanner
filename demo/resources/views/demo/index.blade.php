@extends('demo.layout')

@section('content')
<div class="box">
    <h1>aam/laravel-document-scanner — demo</h1>
    <p>This demo app shows three ways to embed the scanner. Start the local agent first (see <code>docs/agent.md</code>).</p>
    @guest
        @if (app()->isLocal())
            <p><a href="{{ route('demo.login') }}">Sign in as the demo user (local environment only)</a></p>
        @endif
    @else
        <ul>
            <li><a href="{{ route('documents.create') }}">A — widget uploads the PDF, form receives the document id</a></li>
            <li><a href="{{ route('documents.create-file') }}">B — widget attaches the PDF to a normal file input</a></li>
            <li><a href="{{ route('documents.js-api') }}">C — JavaScript API</a></li>
        </ul>
    @endguest
</div>
@endsection
