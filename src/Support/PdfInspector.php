<?php

namespace Aam\DocumentScanner\Support;

/**
 * Lightweight structural PDF checks without external tools:
 *  - header (%PDF-1.x / %PDF-2.x within the first 1024 bytes)
 *  - trailer (startxref + %%EOF in the last 2 KB)
 *  - page count (/Type /Page objects, cross-checked with /Count of /Pages nodes)
 *  - active/unsafe content markers (JavaScript, Launch, EmbeddedFile, XFA, RichMedia, Encrypt, ...)
 *
 * Stream bodies (image data) are skipped so binary data cannot produce false
 * matches. Limitation: dictionaries stored inside compressed object streams
 * (/ObjStm) are not decompressed; `has_object_streams` is reported so callers
 * can decide (PDFs produced by this package never use object streams).
 * The file is read into memory; callers must enforce a size limit first.
 */
class PdfInspector
{
    private const ACTIVE_MARKERS = ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/XFA', '/RichMedia', '/Encrypt', '/SubmitForm', '/ImportData'];

    /**
     * @return array{valid: bool, reason: ?string, version: ?string, pages: ?int, active_content: array<int, string>, has_object_streams: bool}
     */
    public function inspect(string $path): array
    {
        $result = ['valid' => false, 'reason' => null, 'version' => null, 'pages' => null, 'active_content' => [], 'has_object_streams' => false];

        $data = @file_get_contents($path);
        if ($data === false || $data === '') {
            $result['reason'] = $data === false ? 'unreadable' : 'empty';

            return $result;
        }
        if (! preg_match('/%PDF-([12]\.\d)/', substr($data, 0, 1024), $m)) {
            $result['reason'] = 'header';

            return $result;
        }
        $result['version'] = $m[1];

        $tail = substr($data, -2048);
        if (! str_contains($tail, '%%EOF') || ! str_contains($tail, 'startxref')) {
            $result['reason'] = 'trailer';

            return $result;
        }

        $objects = $this->withoutStreams($data);
        if ($objects === null) {
            $result['reason'] = 'stream';

            return $result;
        }

        $pageObjects = preg_match_all('#/Type\s*/Page(?![a-zA-Z])#', $objects);
        $rootCount = 0;
        if (preg_match_all('#<<((?:(?!<<|>>).)*?/Type\s*/Pages\b(?:(?!<<|>>).)*)>>#s', $objects, $nodes)) {
            foreach ($nodes[1] as $dict) {
                if (preg_match('#/Count\s+(\d+)#', $dict, $c)) {
                    $rootCount = max($rootCount, (int) $c[1]);
                }
            }
        }

        $active = [];
        foreach (self::ACTIVE_MARKERS as $marker) {
            if (preg_match('#'.preg_quote($marker, '#').'(?![a-zA-Z])#', $objects)) {
                $active[] = $marker;
            }
        }
        $result['active_content'] = $active;
        $result['has_object_streams'] = str_contains($objects, '/ObjStm');

        if ($pageObjects > 0 && $rootCount > 0 && $pageObjects !== $rootCount) {
            $result['reason'] = 'page_tree';

            return $result;
        }
        $result['pages'] = $pageObjects > 0 ? $pageObjects : ($rootCount > 0 ? $rootCount : null);
        $result['valid'] = true;

        return $result;
    }

    /** Remove `stream … endstream` bodies; null when a stream is unterminated. */
    private function withoutStreams(string $data): ?string
    {
        $out = '';
        $pos = 0;
        while (preg_match('/(?<![a-z])stream(\r\n|\n|\r)/', $data, $m, PREG_OFFSET_CAPTURE, $pos)) {
            $start = $m[0][1];
            $out .= substr($data, $pos, $start - $pos);
            $end = strpos($data, 'endstream', $start + strlen($m[0][0]));
            if ($end === false) {
                return null;
            }
            $pos = $end + 9;
        }

        return $out.substr($data, $pos);
    }
}
