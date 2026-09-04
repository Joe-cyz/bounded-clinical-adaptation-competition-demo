param(
  [string]$OutputDirectory = "",
  [switch]$IncludeSpeech,
  [string]$SpeechRuntimeDirectory = "",
  [string]$SpeechModelPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$archiveName = if ($IncludeSpeech) {
  "bounded-clinical-adaptation-windows-voice-portable"
} else {
  "bounded-clinical-adaptation-windows-portable"
}
$folderName = if ($IncludeSpeech) { "clinical-demo-voice" } else { "clinical-demo" }
$targetRoot = if ($OutputDirectory) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  Join-Path $projectRoot "portable-output"
}
$targetDirectory = Join-Path $targetRoot $folderName
$targetZip = Join-Path $targetRoot "$archiveName.zip"

if ((Test-Path -LiteralPath $targetDirectory) -or (Test-Path -LiteralPath $targetZip)) {
  throw "The portable output already exists. Move or rename it before rebuilding."
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$pnpmCommand = Get-Command pnpm.cmd -ErrorAction Stop
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) "bca-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$stagingDirectory = Join-Path $stagingRoot $folderName

function Assert-FileHash {
  param(
    [string]$Path,
    [string]$ExpectedHash
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "A required speech file is missing: $([System.IO.Path]::GetFileName($Path))"
  }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedHash.ToLowerInvariant()) {
    throw "A speech file failed its SHA-256 check: $([System.IO.Path]::GetFileName($Path))"
  }
}

function Copy-DirectoryTree {
  param(
    [string]$Source,
    [string]$Destination,
    [switch]$ExcludeJunctions
  )
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $copyOptions = @("/E", "/COPY:DAT", "/DCOPY:DAT", "/R:2", "/W:1", "/NP", "/NFL", "/NDL", "/NJH", "/NJS")
  if ($ExcludeJunctions) { $copyOptions += "/XJ" }
  & robocopy.exe $Source $Destination $copyOptions | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "A directory could not be copied: $Source"
  }
}

try {
  Push-Location $projectRoot
  try {
    & $pnpmCommand.Source build
    if ($LASTEXITCODE -ne 0) { throw "The production build failed." }
  } finally {
    Pop-Location
  }

  $standaloneRoot = Join-Path $projectRoot ".next\standalone"
  New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
  Copy-DirectoryTree -Source (Join-Path $standaloneRoot ".next") -Destination (Join-Path $stagingDirectory ".next") -ExcludeJunctions
  Copy-DirectoryTree -Source (Join-Path $standaloneRoot "node_modules") -Destination (Join-Path $stagingDirectory "node_modules") -ExcludeJunctions
  Copy-Item -LiteralPath (Join-Path $standaloneRoot "package.json") -Destination $stagingDirectory -Force
  Copy-Item -LiteralPath (Join-Path $standaloneRoot "server.js") -Destination $stagingDirectory -Force

  $sourceNodeModules = Join-Path $projectRoot "node_modules"
  $linkCommands = @("@echo off")
  $junctionTargets = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  Get-ChildItem -LiteralPath $standaloneRoot -Recurse -Force -Attributes ReparsePoint | ForEach-Object {
    $linkPath = $_.FullName.Substring($standaloneRoot.Length).TrimStart("\")
    $linkTarget = [string]($_.Target | Select-Object -First 1)
    if (-not $linkTarget.StartsWith($sourceNodeModules, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "An unexpected standalone junction target was found: $linkTarget"
    }
    $targetPath = "node_modules\" + $linkTarget.Substring($sourceNodeModules.Length).TrimStart("\")
    [void]$junctionTargets.Add($targetPath)
    $linkCommands += "rmdir `"$linkPath`" 2>nul"
    $linkCommands += "mklink /J `"$linkPath`" `"%CD%\$targetPath`" >nul"
    $linkCommands += "if errorlevel 1 exit /b 1"
  }
  $linkCommands += "exit /b 0"
  Set-Content -LiteralPath (Join-Path $stagingDirectory "prepare-links.cmd") -Value $linkCommands -Encoding ascii

  $standaloneNextPattern = '^node_modules\\\.pnpm\\next@.+\\node_modules\\next$'
  foreach ($targetPath in $junctionTargets) {
    if ($targetPath -match $standaloneNextPattern) { continue }
    Copy-DirectoryTree -Source (Join-Path $projectRoot $targetPath) -Destination (Join-Path $stagingDirectory $targetPath) -ExcludeJunctions
  }

  $nextDirectory = Join-Path $stagingDirectory ".next"
  New-Item -ItemType Directory -Path $nextDirectory -Force | Out-Null
  Copy-DirectoryTree -Source (Join-Path $projectRoot ".next\static") -Destination (Join-Path $nextDirectory "static")
  Copy-DirectoryTree -Source (Join-Path $projectRoot "public") -Destination (Join-Path $stagingDirectory "public")
  Copy-DirectoryTree -Source (Join-Path $projectRoot "data") -Destination (Join-Path $stagingDirectory "data")
  New-Item -ItemType Directory -Path (Join-Path $stagingDirectory "data\runtime") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingDirectory "runtime") -Force | Out-Null
  Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $stagingDirectory "runtime\node.exe") -Force
  Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination (Join-Path $stagingDirectory "LICENSE.txt") -Force

  if ($IncludeSpeech) {
    if (-not $SpeechRuntimeDirectory -or -not $SpeechModelPath) {
      throw "-IncludeSpeech requires -SpeechRuntimeDirectory and -SpeechModelPath."
    }
    $resolvedRuntime = [System.IO.Path]::GetFullPath($SpeechRuntimeDirectory)
    $resolvedModel = [System.IO.Path]::GetFullPath($SpeechModelPath)
    $whisperExecutable = Join-Path $resolvedRuntime "whisper-cli.exe"
    Assert-FileHash -Path $whisperExecutable -ExpectedHash "95e3c0b0e778ad9499eb0125f97c1dcf437dd9eb4ea77050b043574f93c2631d"
    Assert-FileHash -Path $resolvedModel -ExpectedHash "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"

    $speechDirectory = Join-Path $stagingDirectory "speech-runtime"
    New-Item -ItemType Directory -Path $speechDirectory -Force | Out-Null
    Copy-Item -LiteralPath $whisperExecutable -Destination $speechDirectory -Force
    Get-ChildItem -LiteralPath $resolvedRuntime -Filter "*.dll" -File | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $speechDirectory -Force
    }
    Copy-Item -LiteralPath $resolvedModel -Destination (Join-Path $speechDirectory "ggml-small.bin") -Force
    New-Item -ItemType Directory -Path (Join-Path $stagingDirectory "third-party-licenses") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot "third-party-licenses\whisper.cpp-LICENSE.txt") -Destination (Join-Path $stagingDirectory "third-party-licenses") -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot "third-party-licenses\openai-whisper-LICENSE.txt") -Destination (Join-Path $stagingDirectory "third-party-licenses") -Force
  }

  $startScript = @'
@echo off
setlocal
cd /d "%~dp0"

if not exist "runtime\node.exe" goto missing_runtime
if not exist "server.js" goto missing_app

set "NODE_ENV=production"
set "HOSTNAME=127.0.0.1"
set "PORT=3210"
set "APP_RUNTIME_MODE=local-research"
set "LLM_PROVIDER=mock"
set "DEEPSEEK_ENABLED=false"
set "DEEPSEEK_API_KEY="
set "PWR08D_REAL_PROVIDER_ENABLED=false"
set "PWR08D_REAL_REQUEST_LIMIT=0"
set "PWR08C_FAKE_FETCH=false"
set "DATABASE_PATH=%CD%\data\runtime\competition-demo.sqlite"
set "SPEECH_PROVIDER=disabled"
set "VOICE_STATUS=not included"

call prepare-links.cmd
if errorlevel 1 goto link_failed

if exist "speech-runtime\whisper-cli.exe" if exist "speech-runtime\ggml-small.bin" (
  set "SPEECH_PROVIDER=local-whisper"
  set "SPEECH_LOCAL_WHISPER_EXECUTABLE_PATH=%CD%\speech-runtime\whisper-cli.exe"
  set "SPEECH_LOCAL_WHISPER_MODEL_PATH=%CD%\speech-runtime\ggml-small.bin"
  set "SPEECH_LOCAL_WHISPER_TEMP_ROOT=%CD%\data\runtime\speech-temp"
  set "VOICE_STATUS=offline voice enabled"
)

if "%DEMO_NO_BROWSER%"=="1" goto start_server
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3210'"

:start_server
echo Starting the competition demo...
echo Voice: %VOICE_STATUS%
echo Open http://127.0.0.1:3210 if the browser does not open automatically.
echo Close this window or press Ctrl+C to stop.
echo.
"runtime\node.exe" server.js
if errorlevel 1 goto run_failed
exit /b 0

:missing_runtime
echo The portable Node runtime is missing. Please extract the complete ZIP again.
pause
exit /b 1

:missing_app
echo The web application files are missing. Please extract the complete ZIP again.
pause
exit /b 1

:link_failed
echo The local runtime links could not be prepared. Please move the folder to a writable location and try again.
pause
exit /b 1

:run_failed
echo.
echo The demo could not start. Port 3210 may already be in use.
pause
exit /b 1
'@
  Set-Content -LiteralPath (Join-Path $stagingDirectory "start-demo.cmd") -Value $startScript -Encoding ascii

  $usageBase64 = if ($IncludeSpeech) {
    "6Kej5Y6L5a6M5pW05Y6L57yp5YyF77yM5Y+M5Ye7IHN0YXJ0LWRlbW8uY21k44CC6aaW5qyh5b2V6Z+z5pe25YWB6K645rWP6KeI5Zmo5L2/55So6bqm5YWL6aOO44CC5b2V6Z+z5Y+q5Zyo5pys5py65aSE55CG77yM5pyA6ZW/MTXnp5LvvIzor4bliKvnu5PmnpzpnIDmiYvliqjnoa7orqTjgILor7fli7/ovpPlhaXnnJ/lrp7mgqPogIXkv6Hmga/jgII="
  } else {
    "6Kej5Y6L5a6M5pW05Y6L57yp5YyF77yM5Y+M5Ye7IHN0YXJ0LWRlbW8uY21k44CC5q2k6L276YeP54mI5LiN5YyF5ZCr56a757q/6K+t6Z+z5qih5Z6L77yM5LiN5Lya6K+35rGC6bqm5YWL6aOO44CC6K+35Yu/6L6T5YWl55yf5a6e5oKj6ICF5L+h5oGv44CC"
  }
  $usage = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($usageBase64))
  Set-Content -LiteralPath (Join-Path $stagingDirectory "README-WINDOWS.txt") -Value $usage -Encoding utf8

  New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
  Copy-DirectoryTree -Source $stagingDirectory -Destination $targetDirectory
  & tar.exe -a -c -f $targetZip -C $targetRoot $folderName
  if ($LASTEXITCODE -ne 0) { throw "The portable ZIP could not be created." }

  $files = Get-ChildItem -LiteralPath $stagingDirectory -Recurse -File
  [pscustomobject]@{
    Directory = $targetDirectory
    Zip = $targetZip
    Files = $files.Count
    Bytes = ($files | Measure-Object Length -Sum).Sum
    ZipBytes = (Get-Item -LiteralPath $targetZip).Length
    SpeechIncluded = [bool]$IncludeSpeech
    Sha256 = (Get-FileHash -LiteralPath $targetZip -Algorithm SHA256).Hash.ToLowerInvariant()
  } | Format-List
} finally {
  $resolvedStaging = [System.IO.Path]::GetFullPath($stagingRoot)
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ((Test-Path -LiteralPath $resolvedStaging) -and $resolvedStaging.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
  }
}
