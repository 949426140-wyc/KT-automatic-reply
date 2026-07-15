$ErrorActionPreference = 'Continue'
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
$env:PENDING_REVIEW_MODE = 'true'
$env:SEMI_AUTO_MODE = 'false'
Set-Location -LiteralPath $PSScriptRoot

while ($true) {
  Add-Content -LiteralPath "pending-reply-scan.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] starting pending reply scanner"
  & cmd.exe /c "`"C:\Program Files\nodejs\node.exe`" auto-reply.js >> pending-reply-scan.log 2>&1"
  $exitCode = $LASTEXITCODE
  Add-Content -LiteralPath "pending-reply-scan.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] scanner exited, exitCode=$exitCode; restart after 5 seconds"
  Start-Sleep -Seconds 5
}
