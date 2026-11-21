# Starts the web host inside WSL (its link is one-time, so each capture needs
# a fresh one), waits for the link, and runs scripts/capture-shots.ts with the
# arguments given in -Capture.
#
#   ./Run-Capture.ps1 -Out <dir> -Scripts /mnt/c/.../scripts/shots -Serve 'recorded /mnt/c/.../docs/images/logs/tinytable-fix.jsonl' -Capture '--name', 'web', '--session', 'second test', '--click', 'Ran commands'
#   ./Run-Capture.ps1 -Out <dir> -Scripts /mnt/c/.../scripts/shots -Serve live -Capture '--name', 'approval', '--themes', 'light', '--prompt', '...', '--until', 'approval'
#
# -Scripts is this folder as WSL sees it (/mnt/c/...). The host runs as root so
# that every path it shows is the neutral one snapshot.sh made.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Scripts,
  [string]$Serve = 'live',
  [string]$Distro = 'Ubuntu',
  # What scripts/capture-shots.ts is given after --url and --out.
  [string[]]$Capture = @()
)
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
wsl.exe -d $Distro -u root -- pkill -f 'minidsh.js web' 2>&1 | Out-Null
Start-Sleep -Milliseconds 800
$log = Join-Path ([IO.Path]::GetTempPath()) ("minidsh-shots-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + ".out")
$p = Start-Process -FilePath wsl.exe -ArgumentList "-d $Distro -u root -- bash $Scripts/serve.sh $Serve" -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(90)
$url = $null
do {
  Start-Sleep -Milliseconds 800
  $text = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
  if ($text -match '(http://127\.0\.0\.1:\d+/\?token=\S+)') { $url = $Matches[1] }
} while ($null -eq $url -and (Get-Date) -lt $deadline -and -not $p.HasExited)
if ($null -eq $url) {
  "no link from the host (exited=$($p.HasExited))"
  Get-Content "$log.err" -ErrorAction SilentlyContinue | Select-Object -First 8
  exit 1
}
New-Item -ItemType Directory -Force $Out | Out-Null
Push-Location $repo
try {
  $result = node scripts/capture-shots.ts --url $url --out $Out @Capture 2>&1
  $code = $LASTEXITCODE
} finally {
  Pop-Location
  # The host inherits this process's output pipe: left running, it keeps a
  # caller that reads our output waiting for ever. Its link is spent anyway.
  wsl.exe -d $Distro -u root -- pkill -f 'minidsh.js web' 2>&1 | Out-Null
  Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue
}
# The link holds the launch token: never echoed.
$result | ForEach-Object { "$_" -replace 'token=\S+', 'token=…' }
exit $code
