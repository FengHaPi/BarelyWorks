[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
$resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $resolvedArchive -PathType Leaf)) {
  throw "FFmpeg 压缩包不存在：$resolvedArchive"
}
if ([System.IO.Path]::GetExtension($resolvedArchive) -ne '.zip') {
  throw '当前安装脚本只接受 ZIP 压缩包，避免依赖额外解压软件。'
}

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$toolsRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'tools\ffmpeg'))
$targetBin = [System.IO.Path]::GetFullPath((Join-Path $toolsRoot 'bin'))
$expectedPrefix = $projectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $targetBin.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "便携工具目标路径越界：$targetBin"
}

$actualSha256 = (Get-FileHash -LiteralPath $resolvedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
  throw "SHA-256 校验失败。期望 $($ExpectedSha256.ToLowerInvariant())，实际 $actualSha256。未解压、未修改现有工具。"
}

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporaryRoot = [System.IO.Path]::GetFullPath((Join-Path $temporaryBase ("ai-video-studio-ffmpeg-" + [System.Guid]::NewGuid().ToString('N'))))
$temporaryPrefix = $temporaryBase.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $temporaryRoot.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "临时路径越界：$temporaryRoot"
}

$targetFfmpeg = Join-Path $targetBin 'ffmpeg.exe'
$targetFfprobe = Join-Path $targetBin 'ffprobe.exe'
$hadFfmpeg = Test-Path -LiteralPath $targetFfmpeg -PathType Leaf
$hadFfprobe = Test-Path -LiteralPath $targetFfprobe -PathType Leaf
$backupDirectory = $null
$installStarted = $false

try {
  New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
  Expand-Archive -LiteralPath $resolvedArchive -DestinationPath $temporaryRoot -Force

  $ffmpegSource = Get-ChildItem -LiteralPath $temporaryRoot -Recurse -File -Filter 'ffmpeg.exe' |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'ffprobe.exe') -PathType Leaf } |
    Select-Object -First 1
  if (-not $ffmpegSource) {
    throw '压缩包中没有找到位于同一目录的 ffmpeg.exe 与 ffprobe.exe。未修改现有工具。'
  }
  $ffprobeSource = Get-Item -LiteralPath (Join-Path $ffmpegSource.DirectoryName 'ffprobe.exe')

  $ffmpegVersionOutput = @(& $ffmpegSource.FullName -version 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "压缩包内 ffmpeg.exe 无法运行（退出码 $LASTEXITCODE）。" }
  $ffprobeVersionOutput = @(& $ffprobeSource.FullName -version 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "压缩包内 ffprobe.exe 无法运行（退出码 $LASTEXITCODE）。" }
  $encoderOutput = (@(& $ffmpegSource.FullName -hide_banner -encoders 2>&1) -join "`n")
  if ($LASTEXITCODE -ne 0) { throw "FFmpeg 编码器探测失败（退出码 $LASTEXITCODE）。" }
  if ($encoderOutput -notmatch '(?m)^\s*[A-Z.]{6}\s+libx264(?:\s|$)') {
    throw '该 FFmpeg 构建缺少 libx264，不能满足当前粗剪契约。'
  }
  if ($encoderOutput -notmatch '(?m)^\s*[A-Z.]{6}\s+aac(?:\s|$)') {
    throw '该 FFmpeg 构建缺少 AAC 编码器，不能满足当前粗剪契约。'
  }

  New-Item -ItemType Directory -Path $targetBin -Force | Out-Null
  if ($hadFfmpeg -or $hadFfprobe) {
    $backupDirectory = Join-Path $toolsRoot ("backups\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    if ($hadFfmpeg) { Copy-Item -LiteralPath $targetFfmpeg -Destination (Join-Path $backupDirectory 'ffmpeg.exe') }
    if ($hadFfprobe) { Copy-Item -LiteralPath $targetFfprobe -Destination (Join-Path $backupDirectory 'ffprobe.exe') }
  }

  $installStarted = $true
  Copy-Item -LiteralPath $ffmpegSource.FullName -Destination $targetFfmpeg -Force
  Copy-Item -LiteralPath $ffprobeSource.FullName -Destination $targetFfprobe -Force

  $licenseDirectory = Join-Path $toolsRoot 'licenses'
  $licenseFiles = Get-ChildItem -LiteralPath $temporaryRoot -Recurse -File |
    Where-Object { $_.Name -match '^(LICENSE|COPYING|README)(\..*)?$' } |
    Select-Object -First 10
  if ($licenseFiles) {
    New-Item -ItemType Directory -Path $licenseDirectory -Force | Out-Null
    foreach ($licenseFile in $licenseFiles) {
      Copy-Item -LiteralPath $licenseFile.FullName -Destination (Join-Path $licenseDirectory $licenseFile.Name) -Force
    }
  }

  $installedAt = (Get-Date).ToUniversalTime().ToString('o')
  $metadata = [ordered]@{
    installedAt = $installedAt
    archivePath = $resolvedArchive
    archiveSha256 = $actualSha256
    ffmpegVersion = [string]$ffmpegVersionOutput[0]
    ffprobeVersion = [string]$ffprobeVersionOutput[0]
    libx264 = $true
    aac = $true
    backupDirectory = $backupDirectory
  }
  $metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $toolsRoot 'installation.json') -Encoding UTF8

  [pscustomobject]@{
    Installed = $true
    Ffmpeg = $targetFfmpeg
    Ffprobe = $targetFfprobe
    Sha256 = $actualSha256
    Version = [string]$ffmpegVersionOutput[0]
    Backup = $backupDirectory
    NextStep = '重启 AI Video Studio 本地服务，然后查看生成中心 MEDIA PREFLIGHT。'
  } | Format-List
} catch {
  if ($installStarted) {
    if ($hadFfmpeg -and $backupDirectory) {
      Copy-Item -LiteralPath (Join-Path $backupDirectory 'ffmpeg.exe') -Destination $targetFfmpeg -Force
    } elseif (Test-Path -LiteralPath $targetFfmpeg -PathType Leaf) {
      Remove-Item -LiteralPath $targetFfmpeg -Force
    }
    if ($hadFfprobe -and $backupDirectory) {
      Copy-Item -LiteralPath (Join-Path $backupDirectory 'ffprobe.exe') -Destination $targetFfprobe -Force
    } elseif (Test-Path -LiteralPath $targetFfprobe -PathType Leaf) {
      Remove-Item -LiteralPath $targetFfprobe -Force
    }
  }
  throw
} finally {
  if ((Test-Path -LiteralPath $temporaryRoot) -and
      $temporaryRoot.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
      ([System.IO.Path]::GetFileName($temporaryRoot) -like 'ai-video-studio-ffmpeg-*')) {
    for ($cleanupAttempt = 1; $cleanupAttempt -le 5; $cleanupAttempt += 1) {
      try {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
        break
      } catch {
        if ($cleanupAttempt -eq 5) {
          Write-Warning "FFmpeg 已安装，但临时目录仍被 Windows 占用，可稍后安全删除：$temporaryRoot"
        } else {
          Start-Sleep -Milliseconds 400
        }
      }
    }
  }
}
