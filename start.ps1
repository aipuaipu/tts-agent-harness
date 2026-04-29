[CmdletBinding()]
param(
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $Root ".env"
$EnvDevFile = Join-Path $Root ".env.dev"
$LogsDir = Join-Path $Root ".omx\logs"
$ProxyEnvVars = @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

function Write-Step([string]$Message) {
  Write-Host "==> $Message"
}

function Invoke-WithoutProxy(
  [Parameter(Mandatory = $true)]
  [scriptblock]$ScriptBlock
) {
  $saved = @{}
  foreach ($varName in $ProxyEnvVars) {
    $saved[$varName] = [Environment]::GetEnvironmentVariable($varName, "Process")
    [Environment]::SetEnvironmentVariable($varName, $null, "Process")
  }

  try {
    return & $ScriptBlock
  } finally {
    foreach ($varName in $ProxyEnvVars) {
      [Environment]::SetEnvironmentVariable($varName, $saved[$varName], "Process")
    }
  }
}

function Invoke-Native(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [string[]]$ArgumentList = @()
) {
  # docker compose 等工具将正常进度信息写到 stderr。
  # 用 2>&1 合并 stderr 到 stdout，避免 PowerShell 将其记入错误流
  # 导致 -File 模式下脚本退出码非零。
  # 错误检测仍通过 $LASTEXITCODE 保证。
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    & $FilePath @ArgumentList 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        Write-Host $_.Exception.Message
      } else {
        Write-Host $_
      }
    }
  } finally {
    $ErrorActionPreference = $prevEAP
  }
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    $renderedArgs = ($ArgumentList | ForEach-Object {
      if ($_ -match "\s") {
        '"{0}"' -f $_
      } else {
        $_
      }
    }) -join " "
    $commandText = if ($renderedArgs) { "$FilePath $renderedArgs" } else { $FilePath }
    throw "Command failed with exit code ${exitCode}: $commandText"
  }
}

function Invoke-Docker([string[]]$ArgumentList = @()) {
  Invoke-WithoutProxy {
    Invoke-Native "docker" $ArgumentList
  }
}

function Import-DotEnv([string]$Path) {
  if (-not (Test-Path $Path)) {
    return
  }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }
    $pair = $line -split "=", 2
    [Environment]::SetEnvironmentVariable($pair[0], $pair[1], "Process")
  }
}

function Test-PortListening([int]$Port) {
  try {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
  } catch {
    return $false
  }
}

function Get-LogExcerpt([string]$Path, [int]$Tail = 20) {
  if (-not (Test-Path $Path)) {
    return $null
  }

  $content = Get-Content -Path $Path -Tail $Tail -ErrorAction SilentlyContinue
  if (-not $content) {
    return $null
  }

  return ($content -join [Environment]::NewLine).Trim()
}

function Wait-PortListening(
  [string]$Name,
  [int]$Port,
  [int]$TimeoutSec = 30
) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)

  while ((Get-Date) -lt $deadline) {
    if (Test-PortListening $Port) {
      return
    }
    Start-Sleep -Milliseconds 500
  }

  throw "$Name did not start listening on :$Port within ${TimeoutSec}s"
}

function Test-DockerDaemonReady {
  try {
    $null = Get-Command docker -ErrorAction Stop
    $exitCode = Invoke-WithoutProxy {
      & docker info *> $null
      $LASTEXITCODE
    }
    return ($exitCode -eq 0)
  } catch {
    return $false
  }
}

function Get-DockerDesktopPath {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Docker\Docker\Docker Desktop.exe")
  ) | Where-Object { $_ -and (Test-Path $_) }

  return $candidates | Select-Object -First 1
}

function Ensure-DockerReady([int]$TimeoutSec = 180) {
  $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $dockerCommand) {
    throw "Docker CLI not found in PATH. Install Docker Desktop first."
  }

  if (Test-DockerDaemonReady) {
    return
  }

  $dockerDesktop = Get-DockerDesktopPath
  if (-not $dockerDesktop) {
    throw "Docker daemon is not running, and Docker Desktop.exe was not found. Start Docker Desktop and retry."
  }

  Write-Step "Docker daemon not ready, starting Docker Desktop"
  Start-Process -FilePath $dockerDesktop | Out-Null

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  Write-Host -NoNewline "  waiting for Docker"
  while ((Get-Date) -lt $deadline) {
    if (Test-DockerDaemonReady) {
      Write-Host " ready"
      return
    }
    Write-Host -NoNewline "."
    Start-Sleep -Seconds 2
  }

  Write-Host ""
  throw "Docker Desktop did not become ready within ${TimeoutSec}s"
}

function Test-DockerImage([string]$Image) {
  try {
    $exitCode = Invoke-WithoutProxy {
      & docker image inspect $Image *> $null
      $LASTEXITCODE
    }
    return ($exitCode -eq 0)
  } catch {
    return $false
  }
}

function Ensure-WhisperXImage {
  if (Test-DockerImage "whisperx-svc:dev") {
    return
  }

  Write-Step "Building WhisperX image (whisperx-svc:dev)"
  Push-Location (Join-Path $Root "whisperx-svc")
  try {
    Invoke-Docker @("build", "-t", "whisperx-svc:dev", ".")
  } finally {
    Pop-Location
  }
}

function Get-WhisperXPythonPath {
  $candidates = @(
    (Join-Path $Root ".venv\Scripts\python.exe"),
    (Join-Path $Root "whisperx-svc\.venv\Scripts\python.exe")
  ) | Where-Object { Test-Path $_ }

  return $candidates | Select-Object -First 1
}

function Start-BackgroundProcess(
  [string]$Name,
  [int]$Port,
  [string]$Command,
  [string]$StdoutPath,
  [string]$StderrPath,
  [int]$StartupTimeoutSec = 30
) {
  if (Test-PortListening $Port) {
    Write-Host "  $Name already listening on :$Port"
    return
  }

  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $Command) `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -PassThru

  Start-Sleep -Seconds 2
  if ($process.HasExited -and -not (Test-PortListening $Port)) {
    $excerpt = Get-LogExcerpt $StderrPath
    if (-not $excerpt) {
      $excerpt = Get-LogExcerpt $StdoutPath
    }
    if ($excerpt) {
      throw "$Name exited during startup.`n$excerpt"
    }
    throw "$Name exited during startup. Check logs: $StdoutPath / $StderrPath"
  }

  Wait-PortListening $Name $Port $StartupTimeoutSec
  Write-Host "  $Name ready on :$Port (pid $($process.Id))"
}

function Wait-ContainerHealthy([string]$Name, [int]$TimeoutSec = 120) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  Write-Host -NoNewline "  waiting for $Name"

  while ((Get-Date) -lt $deadline) {
    $status = ""
    try {
      $status = Invoke-WithoutProxy {
        & docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $Name 2>$null
      }
    } catch {
      $status = ""
    }

    if ($status -match "healthy|running") {
      Write-Host " ready"
      return
    }

    Write-Host -NoNewline "."
    Start-Sleep -Seconds 2
  }

  Write-Host ""
  throw "Container not ready: $Name"
}

if (-not (Test-Path $EnvFile)) {
  Copy-Item $EnvDevFile $EnvFile
  Write-Step "Created .env from .env.dev"
}

Import-DotEnv $EnvFile

$ApiPort = if ($env:API_PORT) { [int]$env:API_PORT } else { 8100 }
$WebPort = if ($env:WEB_PORT) { [int]$env:WEB_PORT } else { 3010 }
$PrefectPort = if ($env:PREFECT_PORT) { [int]$env:PREFECT_PORT } else { 54200 }
$WhisperxMode = if ($env:WHISPERX_MODE) { $env:WHISPERX_MODE } else { "local" }
$LogLevel = if ($env:LOG_LEVEL) { $env:LOG_LEVEL } else { "info" }
$WhisperxPython = Get-WhisperXPythonPath

if (-not (Test-Path (Join-Path $Root ".venv-server\Scripts\python.exe"))) {
  throw "Missing server virtualenv: .venv-server\Scripts\python.exe. Create it before using one-click startup."
}

if (-not (Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue)) {
  throw "pnpm.cmd was not found in PATH. Install pnpm before using one-click startup."
}

if ($WhisperxMode -eq "local" -and -not $WhisperxPython) {
  Write-Warning "WHISPERX_MODE=local but no local WhisperX virtualenv was found. Falling back to Docker mode."
  $WhisperxMode = "docker"
}

Ensure-DockerReady
Write-Step "Starting infrastructure"
Invoke-Docker @(
  "compose",
  "--env-file", $EnvFile,
  "-f", (Join-Path $Root "docker\docker-compose.dev.yml"),
  "-p", "tts-harness",
  "up", "-d"
)

Write-Step "Waiting for infrastructure"
Wait-ContainerHealthy "tts-harness-postgres"
Wait-ContainerHealthy "tts-harness-minio"
Wait-ContainerHealthy "tts-harness-prefect-server"

Write-Step "Running migrations"
Push-Location (Join-Path $Root "server")
Invoke-Native (Join-Path $Root ".venv-server\Scripts\alembic.exe") @("upgrade", "head")
Pop-Location

Import-DotEnv $EnvFile

$apiCommand = @"
Set-Location '$Root'
`$env:NO_PROXY = 'localhost,127.0.0.1'
& '$Root\.venv-server\Scripts\python.exe' -m uvicorn server.api.main:app --host 0.0.0.0 --port $ApiPort --log-level $LogLevel
"@

$webCommand = @"
Set-Location '$Root\web'
`$env:NEXT_PUBLIC_API_URL = 'http://localhost:$ApiPort'
& 'pnpm.cmd' dev
"@

Write-Step "Starting API and Web"
Start-BackgroundProcess "API" $ApiPort $apiCommand (Join-Path $LogsDir "api.out.log") (Join-Path $LogsDir "api.err.log") 30
Start-BackgroundProcess "Web" $WebPort $webCommand (Join-Path $LogsDir "web.out.log") (Join-Path $LogsDir "web.err.log") 60

try {
  if ($WhisperxMode -eq "docker") {
    Ensure-WhisperXImage
    Write-Step "Starting WhisperX container"
    try {
      Invoke-WithoutProxy {
        & docker rm -f whisperx-svc *> $null
      } | Out-Null
    } catch {
    }
    Invoke-Docker @(
      "run", "-d",
      "--name", "whisperx-svc",
      "-p", "7860:7860",
      "-v", "whisperx-models:/models",
      "-e", "WHISPER_MODEL=large-v3",
      "-e", "WHISPER_DEVICE=cpu",
      "whisperx-svc:dev"
    )
  } elseif (-not (Test-PortListening 7860)) {
    Write-Step "Starting WhisperX local service"
$whisperCommand = @"
Set-Location '$Root\whisperx-svc'
& '$WhisperxPython' -m uvicorn server:app --host 0.0.0.0 --port 7860 --log-level $LogLevel
"@
    Start-BackgroundProcess "WhisperX" 7860 $whisperCommand (Join-Path $LogsDir "whisperx.out.log") (Join-Path $LogsDir "whisperx.err.log") 120
  } else {
    Write-Step "WhisperX already listening on :7860"
  }
} catch {
  Write-Warning "WhisperX failed to start: $_"
  Write-Warning "The main services (API + Web) are running. WhisperX (ASR) is unavailable."
}

Write-Host ""
Write-Host "TTS Harness started"
Write-Host "Frontend: http://localhost:$WebPort"
Write-Host "API:      http://localhost:$ApiPort"
Write-Host "Prefect:  http://localhost:$PrefectPort"
Write-Host "Logs:     $LogsDir"

if ($OpenBrowser) {
  Start-Process "http://localhost:$WebPort"
}
