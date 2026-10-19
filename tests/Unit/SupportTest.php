<?php

namespace Aam\DocumentScanner\Tests\Unit;

use Aam\DocumentScanner\Support\FileNamer;
use Aam\DocumentScanner\Support\PairingTokenIssuer;
use Aam\DocumentScanner\Support\PdfInspector;
use Aam\DocumentScanner\Exceptions\ScannerException;
use Aam\DocumentScanner\Tests\TestCase;
use Illuminate\Support\Carbon;

class SupportTest extends TestCase
{
    private function tmp(string $content): string
    {
        $p = tempnam(sys_get_temp_dir(), 'pdf');
        file_put_contents($p, $content);

        return $p;
    }

    public function test_pdf_inspector_reads_pdf_from_the_browser_writer(): void
    {
        $path = $this->fixture('generated-3-pages.pdf');
        if (! is_file($path)) {
            $this->markTestSkipped('JS fixture missing; run node --test tests/js first.');
        }
        $info = (new PdfInspector)->inspect($path);
        $this->assertTrue($info['valid']);
        $this->assertSame(3, $info['pages']);
        $this->assertSame([], $info['active_content']);
        $this->assertFalse($info['has_object_streams']);
    }

    public function test_pdf_inspector_rejects_broken_files_and_flags_active_content(): void
    {
        $inspector = new PdfInspector;
        $this->assertSame('empty', $inspector->inspect($this->tmp(''))['reason']);
        $this->assertSame('header', $inspector->inspect($this->tmp('hello world'))['reason']);
        $this->assertSame('trailer', $inspector->inspect($this->tmp("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"))['reason']);

        $ok = $inspector->inspect($this->tmp($this->minimalPdf('', 2)));
        $this->assertTrue($ok['valid']);
        $this->assertSame(2, $ok['pages']);

        $js = $inspector->inspect($this->tmp($this->minimalPdf('/OpenAction << /S /JavaScript /JS (app.alert(1)) >>')));
        $this->assertContains('/JavaScript', $js['active_content']);
        $this->assertContains('/JS', $js['active_content']);

        $bad = $this->minimalPdf('', 2);
        $bad = str_replace('/Count 2', '/Count 5', $bad);
        $this->assertSame('page_tree', $inspector->inspect($this->tmp($bad))['reason']);
    }

    public function test_pdf_inspector_ignores_markers_inside_binary_streams(): void
    {
        $pdf = $this->minimalPdf();
        $pdf = str_replace("\nxref\n0 1", "\n9 0 obj\n<< /Length 30 >>\nstream\n/JS /Type /Page /Launch junk\nendstream\nendobj\nxref\n0 1", $pdf);
        $info = (new PdfInspector)->inspect($this->tmp($pdf));
        $this->assertTrue($info['valid']);
        $this->assertSame(1, $info['pages']);
        $this->assertSame([], $info['active_content']);
    }

    public function test_file_namer_sanitises_display_names_and_never_uses_them_for_storage(): void
    {
        $namer = new FileNamer(config('document-scanner'));
        $now = Carbon::parse('2026-10-19 08:09:10');
        $this->assertSame('scan-20261019-080910.pdf', $namer->displayName(null, 'pdf', $now));
        $this->assertSame('passwd.pdf', $namer->displayName('../../etc/passwd', 'pdf', $now));
        $this->assertSame('عقد إيجار 2026.pdf', $namer->displayName("عقد إيجار\u{202E} 2026.pdf", 'pdf', $now));
        $this->assertSame('scan-20261019-080910.pdf', $namer->displayName('<>:"|?*', 'pdf', $now));
        $this->assertSame('a b.pdf', $namer->displayName("a\x00\n b", 'pdf', $now));
        $this->assertSame(104, mb_strlen($namer->displayName(str_repeat('x', 300), 'pdf', $now)));

        $path = $namer->storagePath('01JABCDEF', 'pdf', $now);
        $this->assertSame('scanned-documents/2026/10/01jabcdef.pdf', $path);
    }

    public function test_pairing_tokens_are_hmac_signed_short_lived_and_unique(): void
    {
        $issuer = new PairingTokenIssuer(self::SECRET, 60);
        $a = $issuer->issue('https://app.example.com', 1_000_000);
        $b = $issuer->issue('https://app.example.com', 1_000_000);
        $this->assertNotSame($a['token'], $b['token'], 'random nonce');
        [$v, $payload, $sig] = explode('.', $a['token']);
        $this->assertSame('v1', $v);
        $expected = rtrim(strtr(base64_encode(hash_hmac('sha256', 'v1.'.$payload, self::SECRET, true)), '+/', '-_'), '=');
        $this->assertSame($expected, $sig);
        $data = json_decode(base64_decode(strtr($payload, '-_', '+/')), true);
        $this->assertSame('https://app.example.com', $data['o']);
        $this->assertSame(1_000_060, $data['e']);
        $this->assertStringNotContainsString(self::SECRET, $a['token']);

        $this->expectException(ScannerException::class);
        (new PairingTokenIssuer('short'))->issue('https://x.example');
    }
}
