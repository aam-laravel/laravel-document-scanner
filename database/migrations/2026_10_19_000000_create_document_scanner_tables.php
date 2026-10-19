<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // An upload session: created before scanning, owned by one user, used as
        // the idempotency key for the upload (one document per session).
        Schema::create('document_scanner_sessions', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('owner_type');
            $table->string('owner_id');
            $table->string('status', 20)->default('open'); // open | completed | cancelled | expired
            $table->string('correlation_id', 64)->nullable();
            $table->json('client_meta')->nullable(); // agent version, adapter, simulated flag (no document data)
            $table->timestamp('expires_at');
            $table->timestamps();

            $table->index(['owner_type', 'owner_id']);
            $table->index(['status', 'expires_at']);
        });

        Schema::create('document_scanner_documents', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('session_id')->nullable()->constrained('document_scanner_sessions')->nullOnDelete();
            $table->string('owner_type');
            $table->string('owner_id');
            $table->string('disk', 64);
            $table->string('path');
            $table->string('filename'); // sanitised display name
            $table->string('mime_type', 100);
            $table->unsignedBigInteger('size');
            $table->unsignedInteger('pages')->nullable();
            $table->char('sha256', 64);
            $table->json('metadata')->nullable(); // title / category / app-defined (validated)
            $table->timestamps();

            $table->index(['owner_type', 'owner_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('document_scanner_documents');
        Schema::dropIfExists('document_scanner_sessions');
    }
};
