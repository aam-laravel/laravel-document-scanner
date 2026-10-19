<#
  WIA bridge for document-scanner-agent (Windows only).

  Uses the Windows Image Acquisition Automation Library (wiaaut.dll, part of
  Windows) through COM. It never shows WIA UI dialogs. Each invocation writes
  newline-delimited JSON events to stdout and exits:

    -Action list                      -> {"type":"devices","devices":[...]}
    -Action caps  -DeviceId <id>      -> {"type":"caps", ...raw WIA capability data...}
    -Action scan  -DeviceId <id> -Settings <base64 json> -OutDir <dir>
                                      -> {"type":"page",...} per page, then {"type":"done"}
  Errors are reported as {"type":"error","hresult":"0x8021....","message":"..."}.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('list', 'caps', 'scan')][string]$Action,
  [string]$DeviceId,
  [string]$Settings,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }

function HResultOf($err) {
  $ex = $err.Exception
  while ($ex) {
    if ($ex -is [System.Runtime.InteropServices.COMException]) { return ('0x{0:X8}' -f $ex.ErrorCode) }
    if ($ex.HResult -and ($ex.HResult -band 0xFFFF0000) -eq 0x80210000) { return ('0x{0:X8}' -f $ex.HResult) }
    $ex = $ex.InnerException
  }
  return ('0x{0:X8}' -f $err.Exception.HResult)
}

function Fail($err, $stage) {
  Emit @{ type = 'error'; hresult = (HResultOf $err); stage = $stage; message = $err.Exception.Message }
  exit 2
}

function Prop($props, [int]$id) {
  foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p } }
  return $null
}

function Describe($p) {
  if ($null -eq $p) { return $null }
  $d = @{ id = $p.PropertyID; value = $p.Value; readOnly = $p.IsReadOnly; subType = $p.SubType }
  try {
    if ($p.SubType -eq 1) { $d.min = $p.SubTypeMin; $d.max = $p.SubTypeMax; $d.step = $p.SubTypeStep }
    elseif ($p.SubType -ge 2) { $d.values = @($p.SubTypeValues | ForEach-Object { $_ }) }
  } catch { }
  return $d
}

function SetProp($props, [int]$id, $value) {
  $p = Prop $props $id
  if ($null -eq $p) { throw [System.ArgumentException]::new("WIA property $id not present") }
  $p.Value = $value
}

function Connect-Device([string]$id) {
  $dm = New-Object -ComObject WIA.DeviceManager
  foreach ($info in $dm.DeviceInfos) {
    if ($info.DeviceID -eq $id) { return $info.Connect() }
  }
  Emit @{ type = 'error'; hresult = '0x80210015'; stage = 'connect'; message = 'Device not found' }
  exit 2
}

# WIA property ids (wiadef.h)
$DPS_DOCUMENT_HANDLING_CAPABILITIES = 3086
$DPS_DOCUMENT_HANDLING_STATUS = 3087
$DPS_DOCUMENT_HANDLING_SELECT = 3088
$DPS_HORIZONTAL_BED_SIZE = 3074
$DPS_VERTICAL_BED_SIZE = 3075
$DPS_HORIZONTAL_SHEET_FEED_SIZE = 3076
$DPS_VERTICAL_SHEET_FEED_SIZE = 3077
$DPS_MIN_HORIZONTAL_SHEET_FEED_SIZE = 3104
$DPS_MIN_VERTICAL_SHEET_FEED_SIZE = 3105
$DPS_PAGES = 3096
$IPA_DATATYPE = 4103
$IPS_XRES = 6147
$IPS_YRES = 6148
$IPS_XPOS = 6149
$IPS_YPOS = 6150
$IPS_XEXTENT = 6151
$IPS_YEXTENT = 6152
$IPS_BRIGHTNESS = 6154
$IPS_CONTRAST = 6155

$FMT_PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
$FMT_BMP = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'

try {
  if ($Action -eq 'list') {
    $dm = New-Object -ComObject WIA.DeviceManager
    $list = @()
    foreach ($info in $dm.DeviceInfos) {
      if ($info.Type -ne 1) { continue } # 1 = ScannerDeviceType
      $name = try { $info.Properties.Item('Name').Value } catch { $info.DeviceID }
      $man = try { $info.Properties.Item('Manufacturer').Value } catch { '' }
      $desc = try { $info.Properties.Item('Description').Value } catch { '' }
      $list += @{ id = $info.DeviceID; name = $name; manufacturer = $man; description = $desc }
    }
    Emit @{ type = 'devices'; devices = $list }
    exit 0
  }

  $dev = Connect-Device $DeviceId

  if ($Action -eq 'caps') {
    $dp = $dev.Properties
    $out = @{
      type = 'caps'
      handlingCapabilities = (Describe (Prop $dp $DPS_DOCUMENT_HANDLING_CAPABILITIES))
      handlingStatus = (Describe (Prop $dp $DPS_DOCUMENT_HANDLING_STATUS))
      handlingSelect = (Describe (Prop $dp $DPS_DOCUMENT_HANDLING_SELECT))
      bedSize = @((Describe (Prop $dp $DPS_HORIZONTAL_BED_SIZE)), (Describe (Prop $dp $DPS_VERTICAL_BED_SIZE)))
      sheetFeedSize = @((Describe (Prop $dp $DPS_HORIZONTAL_SHEET_FEED_SIZE)), (Describe (Prop $dp $DPS_VERTICAL_SHEET_FEED_SIZE)))
      minSheetFeedSize = @((Describe (Prop $dp $DPS_MIN_HORIZONTAL_SHEET_FEED_SIZE)), (Describe (Prop $dp $DPS_MIN_VERTICAL_SHEET_FEED_SIZE)))
      wiaVersion = $(try { (Prop $dp 14).Value } catch { $null })
      perSelect = @{}
    }
    # Item properties can depend on the selected source; read them per source flag.
    $select = Prop $dp $DPS_DOCUMENT_HANDLING_SELECT
    $choices = @(0)
    if ($select -and -not $select.IsReadOnly) {
      $choices = @()
      $caps = [int]((Prop $dp $DPS_DOCUMENT_HANDLING_CAPABILITIES).Value)
      if ($caps -band 2) { $choices += 2 }
      if ($caps -band 1) { $choices += 1 }
      if (($caps -band 1) -and ($caps -band 4)) { $choices += 5 }
      if ($choices.Count -eq 0) { $choices = @(0) }
    }
    foreach ($sel in $choices) {
      try {
        if ($sel -ne 0) { $select.Value = $sel }
        $ip = $dev.Items.Item(1).Properties
        $out.perSelect["$sel"] = @{
          dataType = (Describe (Prop $ip $IPA_DATATYPE))
          xres = (Describe (Prop $ip $IPS_XRES))
          yres = (Describe (Prop $ip $IPS_YRES))
          xextent = (Describe (Prop $ip $IPS_XEXTENT))
          yextent = (Describe (Prop $ip $IPS_YEXTENT))
          brightness = (Describe (Prop $ip $IPS_BRIGHTNESS))
          contrast = (Describe (Prop $ip $IPS_CONTRAST))
        }
      } catch {
        $out.perSelect["$sel"] = @{ error = (HResultOf $_); message = $_.Exception.Message }
      }
    }
    Emit $out
    exit 0
  }

  if ($Action -eq 'scan') {
    $s = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Settings)) | ConvertFrom-Json
    $dp = $dev.Properties
    if ($s.select -ne 0) {
      try { SetProp $dp $DPS_DOCUMENT_HANDLING_SELECT ([int]$s.select) } catch { Fail $_ 'select-source' }
      if ($s.select -band 1) { try { SetProp $dp $DPS_PAGES 1 } catch { } }
    }
    $item = $dev.Items.Item(1)
    $ip = $item.Properties
    try {
      SetProp $ip $IPA_DATATYPE ([int]$s.dataType)
      SetProp $ip $IPS_XRES ([int]$s.dpi)
      SetProp $ip $IPS_YRES ([int]$s.dpi)
      # Order matters: position before extent, after resolution.
      SetProp $ip $IPS_XPOS 0
      SetProp $ip $IPS_YPOS 0
      $xmax = (Prop $ip $IPS_XEXTENT).SubTypeMax
      $ymax = (Prop $ip $IPS_YEXTENT).SubTypeMax
      SetProp $ip $IPS_XEXTENT ([Math]::Min([int]$s.widthPx, [int]$xmax))
      SetProp $ip $IPS_YEXTENT ([Math]::Min([int]$s.heightPx, [int]$ymax))
      if ($null -ne $s.brightness) { SetProp $ip $IPS_BRIGHTNESS ([int]$s.brightness) }
      if ($null -ne $s.contrast) { SetProp $ip $IPS_CONTRAST ([int]$s.contrast) }
    } catch { Fail $_ 'apply-settings' }

    $feeder = ($s.select -band 1) -ne 0
    $count = 0
    while ($count -lt [int]$s.maxPages) {
      Emit @{ type = 'progress'; page = ($count + 1) }
      $img = $null
      try {
        try { $img = $item.Transfer($FMT_PNG) } catch {
          $hr = HResultOf $_
          # Some drivers only deliver BMP; anything that is a paper/device condition is re-thrown.
          if ($hr -like '0x8021*') { throw }
          $img = $item.Transfer($FMT_BMP)
        }
      } catch {
        $hr = HResultOf $_
        # After >=1 page, WIA_ERROR_PAPER_EMPTY (or eSCL HTTP 404 'no next document') means the batch ended normally.
        if ($feeder -and $count -gt 0 -and ($hr -eq '0x80210003' -or $hr -eq '0x80190194')) { break }
        Fail $_ 'transfer'
      }
      $count++
      $base = Join-Path $OutDir ('page-{0:D4}' -f $count)
      $file = "$base.png"
      if ($img.FormatID -eq $FMT_PNG) {
        $img.SaveFile($file)
      } else {
        # Drivers often deliver BMP only. Save it, then convert to PNG (about 4x
        # smaller, lossless) with System.Drawing; WIA.ImageProcess fails with
        # "Specified cast is not valid" while the device session is open.
        $raw = "$base.bmp"
        $img.SaveFile($raw)
        try {
          $bmp = [System.Drawing.Image]::FromFile($raw)
          try { $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bmp.Dispose() }
          Remove-Item -LiteralPath $raw -Force
        } catch {
          $file = $raw
          Emit @{ type = 'warning'; stage = 'convert'; hresult = (HResultOf $_); message = $_.Exception.Message }
        }
      }
      Emit @{ type = 'page'; file = $file; width = $img.Width; height = $img.Height; dpi = [int]$img.HorizontalResolution }
      if (-not $feeder) { break }
    }
    Emit @{ type = 'done'; pages = $count }
    exit 0
  }
} catch {
  Fail $_ $Action
}
