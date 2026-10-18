$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20+ is required. Install the current Node.js LTS release first.'
}

if ([int](node -p "process.versions.node.split('.')[0]") -lt 20) {
  throw 'Node.js 20 or newer is required.'
}

Set-Location $PSScriptRoot
$env:LABELPRINT_HOST = '127.0.0.1'
$env:LABELPRINT_PORT = '5179'
$env:LABELPRINT_DATA_DIR = Join-Path $PSScriptRoot 'data'

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
}

npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

Write-Host 'Label Designer is starting at http://127.0.0.1:5179'
Write-Host 'Press Ctrl+C in this window to stop it.'
npm start
