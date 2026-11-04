# bbport: mirror the built release into the HDR harness folder and write its bbport.ini.
#
# The port is portable: it reads bbport.ini, user\ and logs\ from its own folder, and it finds the
# game as the sibling of that folder (run.py: BB_GAME_DIR, else PACKAGE_DIR.parent\CUSA03173). So a
# harness is a copy of the release placed next to the game dump, with an ini that turns the feature
# on. This script copies and writes; it does NOT start the game.
#
#   .\scripts\mirror-hdr-harness.ps1                 # first mirror, then report what it set
#   .\scripts\mirror-hdr-harness.ps1 -Mirror         # a clean install (drops files the release has not)
#   .\scripts\mirror-hdr-harness.ps1 -DryRun         # check the paths and print the plan
#
# PowerShell 5.1: the ini goes out through [System.IO.File], not Set-Content (no -NoNewline here).
param(
    [string]$Source = 'C:\Users\wow99\Downloads\Bloodborne-bbport-0.7-windows-x64',
    [string]$DataRoot = 'E:\Bloodborne-bbport-nativeplus-hdr',
    [string]$GameRoot = 'E:\CUSA03173',
    [string]$SaveFrom = 'E:\LanternEngine-NativePlusHDR\user',
    [string]$Upscaler = 'dlss',
    [int]$Preset = 1,                 # 0 Native AA, 1 Quality, 2 Balanced, 3 Performance, 4 Ultra Performance
    [string]$OutputRes = '3840x2160',
    [float]$Peak = 790,
    [float]$PaperWhite = 203,
    [float]$Knee = 0.6,
    # The build's output folder: its bb-probe.exe replaces the release's in bin\. The released
    # launcher starts that binary, so a stock package plus this file is the harness for this branch
    # (the distributed 0.7 binary predates it).
    [string]$Overlay = 'D:\Code\bloodborne_pc\out\win-native',
    [switch]$Mirror,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Need([string]$Path, [string]$What) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "$What missing: $Path" }
}

Need $Source 'the release folder'
Need (Join-Path $Source 'Bloodborne.exe') 'the launcher in the release'
Need (Join-Path $GameRoot 'eboot.bin') 'the game dump (eboot.bin)'

# The port resolves the game as <parent of its own folder>\CUSA03173, so the harness folder has to be
# a sibling of the dump with that exact name - or BB_GAME_DIR has to be set for every run.
$harnessParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $DataRoot))
$dumpParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $GameRoot))
if ($harnessParent -ne $dumpParent) {
    Write-Warning "the harness folder is not a sibling of the dump ($harnessParent vs $dumpParent):" +
                  " set BB_GAME_DIR for every run, or it will not find eboot.bin"
}

$ini = @(
    '# bbport: the HDR harness. Written by scripts/mirror-hdr-harness.ps1.'
    ''
    '# HDR output (hdr=1, hdr_mode=native+): the scene chain carries above-white to the display.'
    'hdr=1'
    'hdr_mode=native+'
    "hdr_peak=$Peak"
    "hdr_paper_white=$PaperWhite"
    "hdr_knee=$Knee"
    ''
    '# The upscaler under test; Quality = 1 for DLSS, and TAA takes no render-scale preset.'
    "upscaler=$Upscaler"
    "preset=$Preset"
    ''
    '# The output size the panel is measured at.'
    "output_res=$OutputRes"
    ''
) -join "`r`n"

Write-Output "release    $Source"
Write-Output "harness    $DataRoot"
Write-Output "game dump  $GameRoot"
Write-Output "save from  $SaveFrom"
Write-Output ''
Write-Output 'bbport.ini:'
Write-Output $ini

# The branch's own engine: the released launcher runs bin\bb-probe.exe, and the 0.7 package's copy
# is not this branch. Without this the harness measures the released code, not ours.
$engine = Join-Path $Overlay 'bb-probe.exe'
if (Test-Path -LiteralPath $engine) {
    Write-Output "engine     $engine -> $DataRoot\bin\bb-probe.exe"
} else {
    Write-Warning "no built engine at $engine (build it first: cmake -S gpu -B out/win-native -G Ninja -DBB_NET=OFF; ninja -C out/win-native bb-probe)"
}

if ($DryRun) {
    Write-Output '-DryRun: nothing copied, nothing written, the game not started.'
    exit 0
}

# Copy the release in. /E copies new and changed files and keeps what is there (logs, saves, out\);
# -Mirror is the clean install.
$robocopyArgs = @($Source, $DataRoot, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
if ($Mirror) { $robocopyArgs += '/PURGE' }
& robocopy @robocopyArgs | Out-Host
# robocopy: 0-7 are success, 8 and up are failures.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

# The save the measurement runs from (the reference install's), when there is one to take.
if (Test-Path -LiteralPath $SaveFrom) {
    $saveTo = Join-Path $DataRoot 'user'
    New-Item -ItemType Directory -Force -Path $saveTo | Out-Null
    & robocopy $SaveFrom $saveTo /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "robocopy of the save failed ($LASTEXITCODE)" }
} else {
    Write-Warning "no save at ${SaveFrom}: the harness starts without one"
}

# The branch's own engine over the package's. Refused rather than skipped: a harness that quietly
# runs the released binary would measure code that is not under test.
if (-not (Test-Path -LiteralPath $engine)) {
    throw "no built engine at $engine - build it first:" +
          " cmake -S gpu -B out/win-native -G Ninja -DBB_NET=OFF && ninja -C out/win-native bb-probe"
}
$target = Join-Path $DataRoot 'bin\bb-probe.exe'
Copy-Item -LiteralPath $engine -Destination $target -Force
Write-Output "engine replaced: $target"

# The ini last, so a run can never see a half-written one.
[System.IO.File]::WriteAllText((Join-Path $DataRoot 'bbport.ini'), $ini,
                               (New-Object System.Text.UTF8Encoding($false)))

Write-Output ''
Write-Output "mirrored. The harness reads $DataRoot\bbport.ini and writes $DataRoot\logs\."
Write-Output "run:  `$env:BB_HDR_SCENE_CURVE='1'; & scripts\verify-hdr-fast.ps1 -DataRoot '$DataRoot'"
