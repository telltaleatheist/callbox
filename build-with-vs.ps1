# Build script that uses Visual Studio 2026 environment
# This script imports the VS environment variables and runs npm commands

param(
    [string]$Command = "install"
)

# Path to VS 2026 Community edition VsDevCmd.bat
$vsDevCmdPath = "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"

# Check if BuildTools path exists if Community doesn't
if (-not (Test-Path $vsDevCmdPath)) {
    $vsDevCmdPath = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat"
}

if (-not (Test-Path $vsDevCmdPath)) {
    Write-Error "Could not find Visual Studio 2026 installation"
    exit 1
}

Write-Host "Setting up Visual Studio 2026 environment..." -ForegroundColor Cyan

# Create a temporary batch file that will:
# 1. Call VsDevCmd.bat to set up the environment
# 2. Run the npm command directly in the same cmd session

$tempBatchFile = [System.IO.Path]::GetTempFileName() + ".bat"

# Determine npm command
$npmCommand = switch ($Command) {
    "install" { "npm install" }
    "package:win-x64" { "npm run package:win-x64" }
    default { "npm $Command" }
}

# Create batch file that sets up VS environment and runs npm in same session
@"
@echo off
call "$vsDevCmdPath" -arch=x64 -host_arch=x64
echo.
echo Visual Studio environment loaded. Running $npmCommand...
echo.
REM Tell node-gyp to use VS 2022 as a compatible version (it will use the actual VS 2026 tools from the environment)
set GYP_MSVS_VERSION=2022
set npm_config_msvs_version=2022
cd /d "C:\Users\tellt\Projects\callbox"
$npmCommand
exit /b %ERRORLEVEL%
"@ | Out-File -FilePath $tempBatchFile -Encoding ASCII

# Run the batch file
$result = cmd /c $tempBatchFile
$exitCode = $LASTEXITCODE

# Clean up temp file
Remove-Item $tempBatchFile -ErrorAction SilentlyContinue

exit $exitCode
