$ErrorActionPreference = 'Continue'
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
Set-Location -LiteralPath $PSScriptRoot

while ($true) {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'auto-reply.disabled')) {
    Add-Content -LiteralPath "auto-reply.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] auto-reply.disabled found; service remains off"
    exit 0
  }
  Add-Content -LiteralPath "auto-reply.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] starting Kutai DingTalk auto reply service"
  & cmd.exe /c "`"C:\Program Files\nodejs\node.exe`" auto-reply.js >> auto-reply.log 2>&1"
  $exitCode = $LASTEXITCODE
  Add-Content -LiteralPath "auto-reply.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] process exited, exitCode=$exitCode; restart after 5 seconds"
  Start-Sleep -Seconds 5
}
