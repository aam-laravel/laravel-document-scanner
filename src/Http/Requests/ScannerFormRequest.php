<?php

namespace Aam\DocumentScanner\Http\Requests;

use Aam\DocumentScanner\Exceptions\ScannerException;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;

/** Renders validation failures in the package's unified error format. */
abstract class ScannerFormRequest extends FormRequest
{
    protected function failedValidation(Validator $validator): void
    {
        $errors = $validator->errors();
        $code = 'VALIDATION_FAILED';
        $failed = $validator->failed();
        if (isset($failed['document']['Max'])) {
            $code = 'FILE_TOO_LARGE';
        } elseif (isset($failed['document']['Required']) || isset($failed['document']['File']) || isset($failed['document']['Uploaded'])) {
            $code = 'FILE_EMPTY';
        }

        throw new HttpResponseException(ScannerException::response($code, $code === 'FILE_TOO_LARGE' ? 413 : 422, $errors->toArray()));
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(ScannerException::response('FORBIDDEN', 403));
    }
}
