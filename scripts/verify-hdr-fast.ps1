# bbport: the fast run — the real launcher, Play, two Enters, then the moment the log says the
# level renders ("Camera motion: scene render size"): one second later two screenshots, then the
# game is closed. The launcher chooses everything (resolution, HDR mode, environment).
param(
    [string]$DataRoot = 'E:\Bloodborne-bbport-nativeplus-hdr',
    [int]$SettleSeconds = 1,
    [int]$ShotCount = 2,
    [int]$ShotGapMs = 800,
    [int]$TailSeconds = 4,
    [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Drawing

$t0 = Get-Date
$exe = Join-Path $DataRoot 'Bloodborne.exe'
$logDir = Join-Path $DataRoot 'logs'
$stamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
$logsBefore = @(Get-ChildItem (Join-Path $logDir '*.log') -ErrorAction SilentlyContinue | ForEach-Object FullName)
$shotList = @()

function Get-NewLog {
    $new = @(Get-ChildItem (Join-Path $logDir '*.log') -ErrorAction SilentlyContinue |
             Where-Object { $logsBefore -notcontains $_.FullName } | Sort-Object LastWriteTime -Descending)
    if ($new.Count -eq 0) { return $null }
    return $new[0]
}

function Send-Keys([string]$keys) {
    try { [System.Windows.Forms.SendKeys]::SendWait($keys); return $true } catch { return $false }
}

function Save-Screen([string]$path) {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

function Find-Button($element, [string]$match) {
    $all = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                            [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) {
        $name = ''
        try { $name = $e.Current.Name } catch {}
        if ($name -and $name.ToLower().Contains($match.ToLower())) { return $e }
    }
    return $null
}

function Note([string]$what) {
    Write-Output ('[' + ('{0,5:N1}' -f ((Get-Date) - $t0).TotalSeconds) + 's] ' + $what)
}

$launcher = $null
$gameProc = $null

$stale = @(Get-Process -Name 'bb-probe','Bloodborne' -ErrorAction SilentlyContinue)
if ($stale.Count -gt 0) {
    Note ('stale instance(s) alive: ' + (($stale | ForEach-Object { $_.Id }) -join ',') + ' (a crashed run leaves one holding the GPU)')
    foreach ($p in $stale) { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null }
    Start-Sleep -Seconds 3
    $stale = @(Get-Process -Name 'bb-probe','Bloodborne' -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) {
        Note 'a process that cannot be killed is still there: the GPU is held by a dead instance, reboot to clear it'
        exit 2
    }
}

try {
    $launcher = Start-Process -FilePath $exe -WorkingDirectory $DataRoot -PassThru
    $end = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $end) {
        $launcher.Refresh()
        if ($launcher.MainWindowHandle -ne 0) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($launcher.MainWindowHandle -eq 0) { throw 'the launcher has no window' }
    $win = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$launcher.MainWindowHandle)
    $play = Find-Button $win 'play'
    if (-not $play) { throw 'no Play button' }
    Note 'launcher ready, pressing Play'
    $invoke = $null
    if ($play.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        ([System.Windows.Automation.InvokePattern]$invoke).Invoke()
    } else {
        $r = $play.Current.BoundingRectangle
        [System.Windows.Forms.Cursor]::Position =
            New-Object System.Drawing.Point([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
        Start-Sleep -Milliseconds 250
        $null = Send-Keys '{ENTER}'
    }

    $end = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $end) {
        $gameProc = Get-Process -Name 'bb-probe' -ErrorAction SilentlyContinue |
                    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($gameProc) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $gameProc) { throw 'the game window never appeared' }
    Note 'game window up, entering the game'

    # The start screen: wait for the port's own "splash screen hidden" line (the title/menu is
    # up), then the user's two Enters. "Menu pointer: menus closed" is the game answering them.
    $end = (Get-Date).AddSeconds(120)
    $menu = $false
    while ((Get-Date) -lt $end) {
        $log = Get-NewLog
        if ($log -and (Select-String -Path $log.FullName -Pattern 'splash screen hidden' -Quiet)) {
            $menu = $true
            break
        }
        Start-Sleep -Milliseconds 120
    }
    Note ('menu up: ' + $menu)
    [Microsoft.VisualBasic.Interaction]::AppActivate($gameProc.Id) | Out-Null
    Start-Sleep -Milliseconds 600
    $null = Send-Keys '{ENTER}'
    Start-Sleep -Milliseconds 1200
    $null = Send-Keys '{ENTER}'

    # A spare Enter: the title screen takes one, the save slot the next.
    Start-Sleep -Milliseconds 900
    $null = Send-Keys '{ENTER}'

    # The level: the port prints this the first time the scene renders at its own size.
    $end = (Get-Date).AddSeconds(180)
    $level = $false
    while ((Get-Date) -lt $end) {
        $log = Get-NewLog
        if ($log -and (Select-String -Path $log.FullName -Pattern 'Camera motion: scene render size' -Quiet)) {
            $level = $true
            break
        }
        Start-Sleep -Milliseconds 150
    }
    Note ('level marker: ' + $level)

    Start-Sleep -Seconds $SettleSeconds
    for ($i = 0; $i -lt $ShotCount; $i++) {
        [Microsoft.VisualBasic.Interaction]::AppActivate($gameProc.Id) | Out-Null
        Start-Sleep -Milliseconds 120
        $path = Join-Path $env:TEMP ("bb-fast-$stamp-$i.png")
        Save-Screen $path
        $shotList += $path
        if ($i + 1 -lt $ShotCount) { Start-Sleep -Milliseconds $ShotGapMs }
    }
    Note 'screenshots taken'
} catch {
    Write-Output ('run stopped: ' + $_.Exception.Message)
} finally {
    if (-not $KeepOpen) {
        if ($gameProc) {
            $gameProc.Refresh()
            if ($gameProc.MainWindowHandle -ne 0) { $gameProc.CloseMainWindow() | Out-Null }
            $end = (Get-Date).AddSeconds(10)
            while (-not $gameProc.HasExited -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 200; $gameProc.Refresh() }
            if (-not $gameProc.HasExited) {
                & taskkill.exe /T /F /PID $gameProc.Id 2>&1 | Out-Null
                Start-Sleep -Seconds 2
            }
            if (-not $gameProc.HasExited) { Note 'the game did not exit: its process is stuck' }
            else { Note 'game closed' }
        }
        if ($launcher -and -not $launcher.HasExited) {
            $launcher.CloseMainWindow() | Out-Null
            if (-not $launcher.WaitForExit(6000)) { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue }
        }
    }
}

$log = Get-NewLog
if ($log) {
    Note ('log: ' + $log.Name)
    Select-String -Path $log.FullName -Pattern 'max \(|HDR upscaler|DLSS: DLSS|Output resolution|Camera motion: scene render size' |
        ForEach-Object { $_.Line } | Select-Object -Last 12
}
foreach ($s in $shotList) { if (Test-Path $s) { Write-Output ('shot: ' + $s) } }
Note 'done'
