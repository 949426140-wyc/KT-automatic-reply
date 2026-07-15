$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

$pidFiles = @('bot-reply.pid', 'bot-reply-launcher.pid')
foreach ($file in $pidFiles) {
  $path = Join-Path $PSScriptRoot $file
  if (Test-Path -LiteralPath $path) {
    $pidText = Get-Content -LiteralPath $path -ErrorAction SilentlyContinue
    if ($pidText) {
      $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
      if ($proc) {
        Stop-Process -Id $proc.Id -Force
        Add-Content -LiteralPath "bot-reply.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] stopped $file pid=$($proc.Id)"
      }
    }
  }
}

$cwd = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -ne $PID -and
    ($_.CommandLine -like '*start-bot-reply.ps1*' -or $_.CommandLine -like '*server.js*') -and
    $_.CommandLine -like "*$cwd*"
  } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Add-Content -LiteralPath "bot-reply.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] stopped matched process pid=$($_.ProcessId)"
    } catch {}
  }

Write-Host "bot reply service stopped"
