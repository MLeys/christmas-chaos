<#
  Christmas Chaos - allow phones on your Wi-Fi to reach the game server.

  Adds ONE inbound Windows Firewall rule: TCP <port> (default 3000, or $env:PORT) on the Private and Public
  profiles (a new party Wi-Fi is usually marked "Public"). Safe to run again: the old rule is replaced.

  Usage:   npm run firewall
           powershell -ExecutionPolicy Bypass -File scripts\setup-firewall.ps1 -Port 3001
           add -Remove to delete the rule again, -NoPause to skip the "press Enter" at the end.
#>
param(
  [int]$Port = 0,
  [switch]$Remove,
  [switch]$NoPause
)

if ($Port -le 0) {
  if ($env:PORT -and ($env:PORT -as [int])) { $Port = [int]$env:PORT } else { $Port = 3000 }
}
$ruleName = "Christmas Chaos (TCP $Port)"

function Test-IsAdmin {
  # Works in PowerShell Constrained Language Mode (managed/work PCs): no .NET calls.
  # 'whoami /groups' lists the High Mandatory Level SID only in an elevated (admin) session.
  $groups = & whoami /groups 2>$null
  return [bool]($groups | Select-String -SimpleMatch 'S-1-16-12288')
}

if (-not (Test-IsAdmin)) {
  Write-Host "Christmas Chaos needs administrator permission to change the firewall."
  Write-Host "A Windows prompt will appear - click Yes."
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Port', "$Port")
  if ($Remove) { $argList += '-Remove' }
  if ($NoPause) { $argList += '-NoPause' }
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -ErrorAction Stop | Out-Null
  } catch {
    Write-Host "The firewall was not changed: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "If Windows asked for an admin password you don't have, this PC is locked down by IT -"
    Write-Host "run the game on a personal laptop instead (see README, Troubleshooting)."
    exit 1
  }
  exit 0
}

try {
  $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($existing) { $existing | Remove-NetFirewallRule -ErrorAction Stop }

  if ($Remove) {
    Write-Host "Removed the firewall rule '$ruleName'." -ForegroundColor Green
  } else {
    New-NetFirewallRule -DisplayName $ruleName `
      -Description 'Lets phones on the same Wi-Fi reach the Christmas Chaos game server.' `
      -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
      -Profile Private, Public -ErrorAction Stop | Out-Null
    Write-Host ""
    Write-Host "Done! Phones can now reach Christmas Chaos on port $Port." -ForegroundColor Green
    Write-Host ""
    try {
      $profiles = Get-NetConnectionProfile -ErrorAction Stop
      foreach ($p in $profiles) { Write-Host ("  Network '{0}' ({1}) is {2}" -f $p.Name, $p.InterfaceAlias, $p.NetworkCategory) }
    } catch { }
    Write-Host ""
    Write-Host "Still stuck? Turn off any VPN, and make sure every phone is on the SAME Wi-Fi (not a guest network)."
  }
} catch {
  Write-Host "Could not change the firewall: $($_.Exception.Message)" -ForegroundColor Red
  if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}

if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
exit 0
