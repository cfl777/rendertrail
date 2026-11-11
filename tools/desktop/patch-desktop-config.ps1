# Run this OUTSIDE Claude Desktop (double-click patch-desktop-config.cmd, or run from Windows Terminal).
# It waits for Claude Desktop to quit, adds the rendertrail MCP server to claude_desktop_config.json
# once Desktop's last config write has settled, then relaunches Desktop.
# Why: Desktop rewrites the config from memory every few seconds while running and reads it only at launch.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$patch = Join-Path $here 'add-desktop-config.mjs'
$cfg = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
# Any process named Claude counts as Desktop unless it is VS Code's Claude Code binary.
function DesktopProcs { Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { -not $_.Path -or $_.Path -notlike '*\.vscode\*' } }

$seen = @(DesktopProcs)
Write-Host "Claude Desktop processes running now: $($seen.Count)"
if ($seen.Count -eq 0) {
  Write-Host 'Desktop does not look like it is running. If it IS open, close this window, quit Desktop first, then run this again.'
} else {
  Write-Host 'Waiting for Claude Desktop to quit... (quit it now via the tray icon or Ctrl+Q; do not relaunch it yourself)'
  while (@(DesktopProcs).Count -gt 0) { Start-Sleep -Milliseconds 500 }
}
Write-Host 'Desktop has quit. Waiting for its last config write to settle...'
do { Start-Sleep -Milliseconds 300 } until (((Get-Date) - (Get-Item $cfg).LastWriteTime).TotalSeconds -gt 1.5)

& node $patch
if ($LASTEXITCODE -ne 0) { Write-Host 'Patch failed; see output above.'; Read-Host 'Press Enter to close'; exit 1 }

Write-Host 'Relaunching Claude Desktop...'
try { Start-Process -FilePath 'explorer.exe' -ArgumentList 'shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude' }
catch { Start-Process -FilePath 'C:\Program Files\WindowsApps\Claude_4.23118.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe' }
Write-Host 'Done. In Desktop, ask Claude to run the rendertrail hello tool.'
Start-Sleep -Seconds 4
