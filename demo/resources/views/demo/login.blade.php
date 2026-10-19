@extends('demo.layout')

@section('content')
<div class="box">
    <h1>Sign in required</h1>
    <p>This demo has no real login form.</p>
    @if (app()->isLocal())
        <p><a href="{{ route('demo.login') }}">Sign in as the demo user</a></p>
    @endif
</div>
@endsection
