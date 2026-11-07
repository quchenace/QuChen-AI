# QuChen: one-line installer for the desktop app (Windows 10/11, x64).
#
#   irm https://github.com/quchenace/QuChen-AI/releases/latest/download/install-app.ps1 | iex
#
# It finds the newest release, downloads its Windows installer, checks the SHA-256 published beside it,
# installs QuChen for the current user (no administrator rights) and starts it.
# Set $env:QUCHEN_NO_START='1' to install without starting; $env:QUCHEN_FEED to install from another release folder.
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Die([string]$msg) { [Console]::Error.WriteLine("QuChen installer: $msg"); throw "QuChen installer stopped" }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
try { if ([Net.WebRequest]::DefaultWebProxy) { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } } catch { }

if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Die 'this is the Windows installer; on macOS or Linux, download the app from the releases page.' }
$arch = $env:PROCESSOR_ARCHITEW6432; if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { Die "this computer ($arch) is not x64; there is no QuChen app for it." }

$feed = if ($env:QUCHEN_FEED) { $env:QUCHEN_FEED } else { 'https://github.com/quchenace/QuChen-AI/releases/latest/download' }
$feed = $feed.TrimEnd('/')

Write-Host ''
Write-Host '  QuChen' -ForegroundColor Green
Write-Host '  Local AI, tuned to one model.'
Write-Host ''

$work = Join-Path ([IO.Path]::GetTempPath()) ('quchen-app-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    Write-Host '  Finding the newest release...'
    try { Invoke-WebRequest -UseBasicParsing -Uri "$feed/latest.json" -OutFile (Join-Path $work 'latest.json') }
    catch { Die "could not read $feed/latest.json ($($_.Exception.Message)). Check your internet connection and run this again." }
    $latest = Get-Content (Join-Path $work 'latest.json') -Raw | ConvertFrom-Json
    $entry = $latest.platforms.'windows-x86_64'
    if (-not $entry -or -not $entry.url) { Die "release $($latest.version) has no Windows app." }
    $version = $latest.version
    $url = $entry.url
    $name = [IO.Path]::GetFileName(([Uri]$url).AbsolutePath)
    if ($env:QUCHEN_FEED) { $url = "$feed/" + $name }   # a mirror that holds the installer beside latest.json
    Write-Host "  Version $version" -ForegroundColor Green
    Write-Host "  $name"

    $exe = Join-Path $work $name
    Write-Host '  Downloading...'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
        try { Start-BitsTransfer -Source $url -Destination $exe -Description 'QuChen' -ErrorAction Stop } catch { }
    }
    if (-not (Test-Path $exe)) {
        $job = Start-Job -ScriptBlock { param($u, $o) Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $o } -ArgumentList $url, $exe
        while ($job.State -eq 'Running') {
            Start-Sleep -Milliseconds 700
            if (Test-Path $exe) {
                $mb = [math]::Round((Get-Item $exe).Length / 1MB)
                Write-Host ("  " + $mb + " MB downloaded") -NoNewline
                Write-Host ([char]13) -NoNewline
            }
        }
        Receive-Job $job | Out-Null
        Remove-Job $job -Force
        Write-Host ''
    }
    if (-not (Test-Path $exe)) { Die "the download failed. Open $url in a browser instead." }
    $size = [math]::Round((Get-Item $exe).Length / 1MB)
    Write-Host ("  " + $size + " MB in " + [math]::Round($sw.Elapsed.TotalSeconds) + " s")

    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$feed/SHA256SUMS.txt" -OutFile (Join-Path $work 'SHA256SUMS.txt')
        $line = Get-Content (Join-Path $work 'SHA256SUMS.txt') | Where-Object { $_ -match [regex]::Escape($name) } | Select-Object -First 1
        if ($line) {
            $want = ($line -split '\s+')[0].ToLower()
            $got = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
            if ($got -ne $want) { Die "the download does not match the release's checksum (got $got, wanted $want). Nothing was installed; try again." }
            Write-Host '  Checksum ok.'
        } else { Write-Host '  (this release publishes no checksum for it; continuing)' -ForegroundColor DarkYellow }
    } catch { Write-Host '  (could not read the checksums; continuing)' -ForegroundColor DarkYellow }

    Write-Host '  Installing (this takes a few seconds)...'
    $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { Die "the installer exited with code $($p.ExitCode). Run it by hand: $exe" }

    $app = Join-Path $env:LOCALAPPDATA 'QuChen\QuChen.exe'
    if (-not (Test-Path $app)) {
        $found = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'QuChen') -Filter 'QuChen.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $app = $found.FullName }
    }
    Write-Host ''
    Write-Host "  QuChen $version is installed." -ForegroundColor Green
    if ($app -and (Test-Path $app)) {
        Write-Host "  $app"
        if ($env:QUCHEN_NO_START -ne '1') {
            Write-Host '  Starting QuChen...'
            Start-Process -FilePath $app
        } else { Write-Host '  Start it from the Start menu: QuChen' }
    } else {
        Write-Host '  Start it from the Start menu: QuChen'
    }
    Write-Host '  It updates itself: QuChen reads the same release page when it starts.' -ForegroundColor DarkGray
    Write-Host ''
} finally {
    if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}
}
