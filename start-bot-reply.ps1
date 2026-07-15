$ErrorActionPreference = 'Continue'
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
Set-Location -LiteralPath $PSScriptRoot

Set-Content -LiteralPath "bot-reply-launcher.pid" -Encoding UTF8 -Value $PID

while ($true) {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'bot-reply.disabled')) {
    Add-Content -LiteralPath "bot-reply.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] bot-reply.disabled found; service remains off"
    exit 0
  }
  Add-Content -LiteralPath "bot-reply.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] starting Kutai DingTalk robot reply service"
  & cmd.exe /c "`"C:\Program Files\nodejs\node.exe`" server.js >> bot-reply.log 2>&1"
  $exitCode = $LASTEXITCODE
  Add-Content -LiteralPath "bot-reply.log" -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] process exited, exitCode=$exitCode; restart after 5 seconds"
  Start-Sleep -Seconds 5
}
