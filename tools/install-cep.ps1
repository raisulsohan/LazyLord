# LazyLord — install the CEP panel for development (Windows).
# Enables CEP unsigned-extension debug mode and links the panel into the
# per-user CEP extensions folder.
#
# Run in PowerShell:  ./tools/install-cep.ps1
# Undo:               ./tools/install-cep.ps1 -Uninstall

param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$bundleId = "com.lazylord.panel"
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "packages\adobe-cep"
$extRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$dest = Join-Path $extRoot $bundleId

if ($Uninstall) {
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force; Write-Host "Removed $dest" }
  else { Write-Host "Nothing to remove at $dest" }
  return
}

# 1) Enable unsigned extensions for the CSXS versions shipped with CC 2021+.
foreach ($v in 9, 10, 11, 12) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -Type String
  Write-Host "PlayerDebugMode=1 for CSXS.$v"
}

# 2) Link the panel into the CEP extensions folder.
if (-not (Test-Path $extRoot)) { New-Item -ItemType Directory -Path $extRoot -Force | Out-Null }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }

try {
  New-Item -ItemType SymbolicLink -Path $dest -Target $source -ErrorAction Stop | Out-Null
  Write-Host "Symlinked $dest -> $source"
} catch {
  Write-Host "Symlink failed (needs admin/developer mode); copying instead."
  Copy-Item $source $dest -Recurse -Force
  Write-Host "Copied to $dest"
}

Write-Host ""
Write-Host "Done. Restart Photoshop / Illustrator / After Effects, then open"
Write-Host "  Window > Extensions (legacy) > LazyLord"
