# QuChen Terminal launcher for PowerShell. It finds a Python in a fixed order and hands over to quchen.py.
# It installs nothing and downloads nothing.
#   1. $env:QUCHEN_PYTHON                  an explicit override, always wins
#   2. <root>\python\python.exe            the private runtime shipped in the terminal archive
#   3. <root>\.venv\Scripts\python.exe     a source checkout set up by SETUP.bat
#   4. py -3 / python on PATH, 3.10+       a developer convenience, never a requirement
# If scripts are blocked on this PC, use bin\quchen.cmd, or:  powershell -ExecutionPolicy Bypass -File bin\quchen.ps1 ...
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = if (Test-Path -LiteralPath (Join-Path $here 'quchen.py')) { $here } else { Split-Path -Parent $here }
$app = Join-Path $root 'quchen.py'
if (-not (Test-Path -LiteralPath $app)) {
    [Console]::Error.WriteLine("quchen: cannot find quchen.py next to $here or its parent; the installation looks incomplete")
    exit 5
}

function Test-Python([string[]]$cmd) {
    try {
        $rest = @($cmd | Select-Object -Skip 1) + @('-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)')
        & $cmd[0] @rest *> $null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

$py = $null
$bundled = Join-Path $root 'python\python.exe'
$venv = Join-Path $root '.venv\Scripts\python.exe'
if ($env:QUCHEN_PYTHON) {
    if (-not (Test-Path -LiteralPath $env:QUCHEN_PYTHON)) {
        [Console]::Error.WriteLine("quchen: QUCHEN_PYTHON=$($env:QUCHEN_PYTHON) does not exist")
        exit 5
    }
    $py = @($env:QUCHEN_PYTHON)
} elseif (Test-Path -LiteralPath $bundled) {
    # the private runtime: nothing from the user's site-packages or PYTHONHOME/PYTHONPATH may leak in
    $env:PYTHONNOUSERSITE = '1'
    Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    $py = @($bundled)
} elseif (Test-Path -LiteralPath $venv) {
    $py = @($venv)
} elseif (Test-Python @('py', '-3')) {
    $py = @('py', '-3')
} elseif (Test-Python @('python')) {
    $py = @('python')
}
if (-not $py) {
    [Console]::Error.WriteLine("quchen: no usable Python found.")
    [Console]::Error.WriteLine("        This archive carries its own runtime in python\: it is missing from this install.")
    [Console]::Error.WriteLine("        Reinstall the archive, or set QUCHEN_PYTHON to a Python 3.10 or newer.")
    exit 5
}
# UTF-8 text in Python, not the Windows code page: folders with Cyrillic or other letters stay intact (#3202)
$env:PYTHONUTF8 = '1'
$rest = @($py | Select-Object -Skip 1)
& $py[0] @rest $app @args
exit $LASTEXITCODE
