<?php

namespace Aam\DocumentScanner\Support;

use Aam\DocumentScanner\Exceptions\ScannerException;
use Illuminate\Http\UploadedFile;

/**
 * Content-based validation of an uploaded scan. Client-supplied MIME type and
 * filename are ignored; the type is sniffed from the bytes.
 */
class FileInspector
{
    /** type key => [mime, extension] */
    public const TYPES = [
        'pdf' => ['application/pdf', 'pdf'],
        'jpeg' => ['image/jpeg', 'jpg'],
        'png' => ['image/png', 'png'],
    ];

    public function __construct(private readonly PdfInspector $pdf, private readonly array $config) {}

    /**
     * @return array{type: string, mime: string, extension: string, pages: ?int, size: int, sha256: string}
     *
     * @throws ScannerException
     */
    public function inspect(UploadedFile $file, ?int $claimedPages = null): array
    {
        $path = $file->getRealPath();
        $size = $path ? (int) filesize($path) : 0;
        if (! $path || $size === 0) {
            throw new ScannerException('FILE_EMPTY', 422, ['document' => [ScannerException::translate('FILE_EMPTY')]]);
        }
        $maxBytes = (int) $this->config['limits']['max_file_size_kb'] * 1024;
        if ($size > $maxBytes) {
            throw new ScannerException('FILE_TOO_LARGE', 413);
        }

        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        $mime = (string) $finfo->file($path);
        $type = null;
        foreach ($this->config['accepted_types'] as $key) {
            if (isset(self::TYPES[$key]) && self::TYPES[$key][0] === $mime) {
                $type = $key;
            }
        }
        if ($type === null) {
            throw new ScannerException('FILE_TYPE_NOT_ALLOWED', 422, ['document' => [ScannerException::translate('FILE_TYPE_NOT_ALLOWED')]]);
        }

        $pages = null;
        if ($type === 'pdf') {
            $info = $this->pdf->inspect($path);
            if (! $info['valid']) {
                throw new ScannerException('FILE_CORRUPT', 422);
            }
            if ($this->config['pdf']['reject_active_content'] && $info['active_content'] !== []) {
                throw new ScannerException('FILE_ACTIVE_CONTENT', 422);
            }
            if ($info['pages'] === null && $this->config['pdf']['require_page_count']) {
                throw new ScannerException('FILE_CORRUPT', 422);
            }
            $pages = $info['pages'];
            if ($pages !== null && $claimedPages !== null && $pages !== $claimedPages) {
                throw new ScannerException('PDF_PAGE_MISMATCH', 422);
            }
        } else {
            $img = @getimagesize($path);
            if ($img === false || $img[0] < 1 || $img[1] < 1) {
                throw new ScannerException('FILE_CORRUPT', 422);
            }
            if ($img[0] * $img[1] > (int) $this->config['pdf']['max_image_pixels']) {
                throw new ScannerException('FILE_TOO_LARGE', 413);
            }
            $pages = 1;
        }

        if ($pages !== null && $pages > (int) $this->config['limits']['max_pages']) {
            throw new ScannerException('TOO_MANY_PAGES', 422);
        }

        return [
            'type' => $type,
            'mime' => self::TYPES[$type][0],
            'extension' => self::TYPES[$type][1],
            'pages' => $pages,
            'size' => $size,
            'sha256' => hash_file('sha256', $path),
        ];
    }
}
