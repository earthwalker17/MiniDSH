# Captures one top-level window to a PNG with PrintWindow (PW_RENDERFULLCONTENT),
# which reads the window's own composed content: it works when the window is
# covered by another, and it never captures what is around it.
#
#   pwsh Capture-Window.ps1 -Handle <hwnd> -Out <file.png>
#   pwsh Capture-Window.ps1 -ProcessId <pid> -Out <file.png>
#   pwsh Capture-Window.ps1 -TitleLike '*MiniDSH*' -Out <file.png>
param(
  [long]$Handle = 0,
  [int]$ProcessId = 0,
  [string]$TitleLike = '',
  [string]$Title = '',
  [Parameter(Mandatory = $true)][string]$Out
)
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Cap -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr hwnd, System.IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hwnd, out RECT rect);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr hwnd, int attr, out RECT rect, int size);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr FindWindowW(string cls, string title);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
[Cap.Win]::SetProcessDPIAware() | Out-Null
$hwnd = [IntPtr]::Zero
if ($Handle -ne 0) { $hwnd = [IntPtr]$Handle }
elseif ($Title -ne '') { $hwnd = [Cap.Win]::FindWindowW($null, $Title) }
elseif ($ProcessId -ne 0) { $hwnd = (Get-Process -Id $ProcessId).MainWindowHandle }
elseif ($TitleLike -ne '') { $hwnd = (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $TitleLike } | Select-Object -First 1).MainWindowHandle }
if ($hwnd -eq [IntPtr]::Zero) { Write-Error 'no such window'; exit 1 }
$full = New-Object Cap.Win+RECT
[Cap.Win]::GetWindowRect($hwnd, [ref]$full) | Out-Null
# The frame DWM actually draws (GetWindowRect includes invisible resize borders).
$frame = New-Object Cap.Win+RECT
$hr = [Cap.Win]::DwmGetWindowAttribute($hwnd, 9, [ref]$frame, 16)
if ($hr -ne 0) { $frame = $full }
$w = $full.Right - $full.Left; $h = $full.Bottom - $full.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [Cap.Win]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$crop = New-Object System.Drawing.Rectangle ($frame.Left - $full.Left), ($frame.Top - $full.Top), ($frame.Right - $frame.Left), ($frame.Bottom - $frame.Top)
$final = $bmp.Clone($crop, $bmp.PixelFormat)
$final.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"printed=$ok size=$($final.Width)x$($final.Height) -> $Out"
$bmp.Dispose(); $final.Dispose()
