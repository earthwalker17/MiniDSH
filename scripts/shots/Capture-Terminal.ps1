# Opens a NEW Windows Terminal window with a title of our own, runs one command
# line in it, waits, captures that window alone with PrintWindow (its own
# composed content: nothing around or over it is in the picture), and closes it.
# The person's own terminal windows and settings are never touched.
#
#   pwsh Capture-Terminal.ps1 -Out <file.png> -Columns 110 -Rows 34 -WaitSeconds 12 -CommandLine 'wsl.exe -d Ubuntu -u root -- bash /root/tui.sh' [-Keys 'text to type']
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$CommandLine,
  [int]$Columns = 110,
  [int]$Rows = 34,
  [int]$WaitSeconds = 10,
  [string]$Title = 'MiniDSH',
  # The window is titled exactly -Title (for the published picture); refused if such a window already exists.
  [switch]$ExactTitle
)
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Shot -Name Win -MemberDefinition @'
public delegate bool Proc(System.IntPtr hwnd, System.IntPtr lparam);
[DllImport("user32.dll")] public static extern bool EnumWindows(Proc proc, System.IntPtr lparam);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr hwnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr hwnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")] public static extern bool PostMessageW(System.IntPtr hwnd, uint msg, System.IntPtr w, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr hwnd, System.IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hwnd, out RECT rect);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr hwnd, int attr, out RECT rect, int size);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
[Shot.Win]::SetProcessDPIAware() | Out-Null
$mark = if ($ExactTitle) { $Title } else { "$Title " + [Guid]::NewGuid().ToString('N').Substring(0, 6) }
function Find-Window([string]$exact) {
  $found = [IntPtr]::Zero
  $cb = [Shot.Win+Proc]{ param($h, $l)
    $c = New-Object System.Text.StringBuilder 256; [Shot.Win]::GetClassNameW($h, $c, 256) | Out-Null
    if ($c.ToString() -like 'CASCADIA*') { $t = New-Object System.Text.StringBuilder 512; [Shot.Win]::GetWindowTextW($h, $t, 512) | Out-Null; if ($t.ToString() -eq $exact) { $script:hit = $h } }
    return $true }
  $script:hit = [IntPtr]::Zero
  [Shot.Win]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  $script:hit
}
if ($ExactTitle -and (Find-Window $mark) -ne [IntPtr]::Zero) { Write-Error "a terminal window titled '$mark' is already open; close it or drop -ExactTitle"; exit 1 }
Start-Process wt.exe -ArgumentList "-w new --size $Columns,$Rows --title `"$mark`" --suppressApplicationTitle $CommandLine"
$deadline = (Get-Date).AddSeconds(30); $hwnd = [IntPtr]::Zero
do { Start-Sleep -Milliseconds 500; $hwnd = Find-Window $mark } while ($hwnd -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline)
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "the terminal window titled '$mark' never appeared"; exit 1 }
Start-Sleep -Seconds $WaitSeconds
$full = New-Object Shot.Win+RECT; [Shot.Win]::GetWindowRect($hwnd, [ref]$full) | Out-Null
$frame = New-Object Shot.Win+RECT; if ([Shot.Win]::DwmGetWindowAttribute($hwnd, 9, [ref]$frame, 16) -ne 0) { $frame = $full }
$bmp = New-Object System.Drawing.Bitmap ($full.Right - $full.Left), ($full.Bottom - $full.Top)
$g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc(); $ok = [Shot.Win]::PrintWindow($hwnd, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
$crop = New-Object System.Drawing.Rectangle ($frame.Left - $full.Left), ($frame.Top - $full.Top), ($frame.Right - $frame.Left), ($frame.Bottom - $frame.Top)
$final = $bmp.Clone($crop, $bmp.PixelFormat); $final.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"printed=$ok size=$($final.Width)x$($final.Height) -> $Out"
$bmp.Dispose(); $final.Dispose()
# Close only the window this script opened.
[Shot.Win]::PostMessageW($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
