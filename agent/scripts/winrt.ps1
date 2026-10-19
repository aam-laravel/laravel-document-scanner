<#
  Windows.Devices.Scanners bridge for document-scanner-agent (Windows 10/11).

  This is the WinRT scanning API built on WIA 2.0 (the one used by the
  Windows Scan app). Unlike the WIA 1.0 Automation Library it returns every
  page of a document-feeder job, and it exposes the feeder page sizes the
  driver declares. Requires Windows PowerShell 5.1 (not PowerShell 7).

    -Action list                         -> {"type":"devices","devices":[...]}
    -Action caps -DeviceId <id>          -> {"type":"caps", ...raw values...}
    -Action scan -DeviceId <id> -Settings <base64 json> -OutDir <dir>
                                         -> {"type":"page",...} per page, then {"type":"done"}
  Errors: {"type":"error","hresult":"0x...","stage":"...","message":"..."}
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('list', 'caps', 'scan')][string]$Action,
  [string]$DeviceId,
  [string]$Settings,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }

function Inner($err) {
  $e = if ($err -is [System.Management.Automation.ErrorRecord]) { $err.Exception } else { $err }
  while ($e.InnerException) { $e = $e.InnerException }
  return $e
}

function Fail($err, $stage) {
  $e = Inner $err
  Emit @{ type = 'error'; hresult = ('0x{0:X8}' -f $e.HResult); stage = $stage; message = $e.Message }
  exit 2
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Devices.Scanners.ImageScanner, Windows.Devices.Scanners, ContentType = WindowsRuntime]
  $null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
} catch { Fail $_ 'load-winrt' }

$extensions = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTask = ($extensions | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskProgress = ($extensions | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperationWithProgress`2' })[0]

function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait()
  return $task.Result
}

function Open-Scanner([string]$id) {
  return Await ([Windows.Devices.Scanners.ImageScanner]::FromIdAsync($id)) ([Windows.Devices.Scanners.ImageScanner])
}

# Feeder page sizes we map to presets (Windows.Graphics.Printing.PrintMediaSize names).
$PageSizeNames = @('IsoA3', 'IsoA4', 'IsoA5', 'IsoA6', 'NorthAmericaLetter', 'NorthAmericaLegal')

function Describe-Source($cfg, [bool]$feeder) {
  $d = @{
    minDpi = $cfg.MinResolution.DpiX
    maxDpi = $cfg.MaxResolution.DpiX
    opticalDpi = $cfg.OpticalResolution.DpiX
    defaultDpi = $cfg.DesiredResolution.DpiX
    color = $cfg.IsColorModeSupported('Color')
    gray = $cfg.IsColorModeSupported('Grayscale')
    bw = $cfg.IsColorModeSupported('Monochrome')
    maxArea = @{ w = $cfg.MaxScanArea.Width; h = $cfg.MaxScanArea.Height }
    minArea = @{ w = $cfg.MinScanArea.Width; h = $cfg.MinScanArea.Height }
    brightness = @{ min = $cfg.MinBrightness; max = $cfg.MaxBrightness; step = $cfg.BrightnessStep; default = $cfg.DefaultBrightness }
    contrast = @{ min = $cfg.MinContrast; max = $cfg.MaxContrast; step = $cfg.ContrastStep; default = $cfg.DefaultContrast }
    formats = @{ png = $cfg.IsFormatSupported('Png'); jpeg = $cfg.IsFormatSupported('Jpeg'); dib = $cfg.IsFormatSupported('DeviceIndependentBitmap') }
  }
  if ($feeder) {
    $d.duplex = $cfg.CanScanDuplex
    $d.pageSizes = @($PageSizeNames | Where-Object { $cfg.IsPageSizeSupported([Windows.Graphics.Printing.PrintMediaSize]::$_, 'Portrait') })
  }
  return $d
}

try {
  if ($Action -eq 'list') {
    $sel = [Windows.Devices.Scanners.ImageScanner]::GetDeviceSelector()
    $infos = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($sel)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
    $list = @()
    foreach ($i in $infos) { $list += @{ id = $i.Id; name = $i.Name; enabled = $i.IsEnabled } }
    Emit @{ type = 'devices'; devices = $list }
    exit 0
  }

  $scanner = $null
  try { $scanner = Open-Scanner $DeviceId } catch { Fail $_ 'open' }
  if ($null -eq $scanner) { Emit @{ type = 'error'; hresult = '0x80210015'; stage = 'open'; message = 'Scanner not found' }; exit 2 }

  if ($Action -eq 'caps') {
    $out = @{ type = 'caps'; defaultSource = [string]$scanner.DefaultScanSource }
    if ($scanner.IsScanSourceSupported('Flatbed')) { $out.flatbed = Describe-Source $scanner.FlatbedConfiguration $false }
    if ($scanner.IsScanSourceSupported('Feeder')) { $out.feeder = Describe-Source $scanner.FeederConfiguration $true }
    Emit $out
    exit 0
  }

  if ($Action -eq 'scan') {
    $s = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Settings)) | ConvertFrom-Json
    $feeder = $s.source -ne 'Flatbed'
    $cfg = if ($feeder) { $scanner.FeederConfiguration } else { $scanner.FlatbedConfiguration }
    try {
      $cfg.Format = $s.format
      $cfg.ColorMode = $s.colorMode
      $res = New-Object Windows.Devices.Scanners.ImageScannerResolution
      $res.DpiX = [single]$s.dpi
      $res.DpiY = [single]$s.dpi
      $cfg.DesiredResolution = $res
      # Never let the driver silently substitute another resolution.
      if ([int]$cfg.DesiredResolution.DpiX -ne [int]$s.dpi) {
        Emit @{ type = 'error'; hresult = '0x8021000C'; stage = 'apply-settings'; message = "Resolution $($s.dpi) not accepted (driver chose $($cfg.DesiredResolution.DpiX))" }
        exit 2
      }
      if ($null -ne $s.brightness) { $cfg.Brightness = [int]$s.brightness }
      if ($null -ne $s.contrast) { $cfg.Contrast = [int]$s.contrast }
      if ($feeder) {
        $cfg.Duplex = [bool]$s.duplex
        $cfg.MaxNumberOfPages = [uint32]$s.maxPages
        $cfg.PageSize = [Windows.Graphics.Printing.PrintMediaSize]::($s.pageSize)
        $cfg.PageOrientation = 'Portrait'
      } else {
        $cfg.SelectedScanRegion = New-Object Windows.Foundation.Rect(0, 0, [double]$s.widthIn, [double]$s.heightIn)
      }
    } catch { Fail $_ 'apply-settings' }

    $folder = $null
    try { $folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($OutDir)) ([Windows.Storage.StorageFolder]) } catch { Fail $_ 'output-folder' }
    $source = if ($feeder) { [Windows.Devices.Scanners.ImageScannerScanSource]::Feeder } else { [Windows.Devices.Scanners.ImageScannerScanSource]::Flatbed }
    Emit @{ type = 'progress'; page = 1 }
    $op = $scanner.ScanFilesToFolderAsync($source, $folder)
    $task = $asTaskProgress.MakeGenericMethod([Windows.Devices.Scanners.ImageScannerScanResult], [UInt32]).Invoke($null, @($op))
    try { $task.Wait() } catch { Fail $_ 'transfer' }

    # Files arrive in scan order (front/back interleaved for duplex); give them stable names.
    $n = 0
    foreach ($f in $task.Result.ScannedFiles) {
      $n++
      $ext = [System.IO.Path]::GetExtension($f.Path)
      $target = Join-Path $OutDir ('page-{0:D4}{1}' -f $n, $ext)
      Move-Item -LiteralPath $f.Path -Destination $target -Force
      Emit @{ type = 'page'; file = $target; dpi = [int]$s.dpi }
    }
    Emit @{ type = 'done'; pages = $n }
    exit 0
  }
} catch {
  Fail $_ $Action
}
