'use strict';

const path = require('path');
const { execFile: defaultExecFile } = require('child_process');

const AUDIO_RENDER_ENDPOINT = /^\{0\.0\.0\.[^}]+\}\.\{[^}]+\}$/i;
const MMDEVAPI_PREFIX = /^SWD\\MMDEVAPI\\/i;

const ENUMERATE_AUDIO_OUTPUTS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$renderPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
$devices = @(
  Get-ChildItem -LiteralPath $renderPath |
    Where-Object { (Get-ItemPropertyValue -LiteralPath $_.PSPath -Name DeviceState) -eq 1 } |
    ForEach-Object {
      $properties = Get-ItemProperty -LiteralPath (Join-Path $_.PSPath 'Properties')
      $connector = [string]$properties.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
      $device = [string]$properties.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
      $name = if ($connector -and $device -and $connector -ne $device) {
        "$connector ($device)"
      } elseif ($connector) { $connector } else { $device }
      [PSCustomObject]@{
        id = "{0.0.0.00000000}.$($_.PSChildName)"
        name = $name
      }
    }
)
ConvertTo-Json -InputObject $devices -Compress
`;

function normalizeWindowsAudioEndpoints(value) {
  const source = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  const unique = new Map();

  for (const entry of source) {
    const id = String(entry && entry.id || '').replace(MMDEVAPI_PREFIX, '').trim();
    const name = String(entry && entry.name || '').replace(/[\u0000\r\n]+/g, ' ').trim();
    if (!AUDIO_RENDER_ENDPOINT.test(id) || !name) continue;
    const key = id.toLowerCase();
    if (!unique.has(key)) unique.set(key, { id, name, source: 'windows' });
  }

  return [...unique.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  );
}

function execute(execFile, executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').trim();
        if (detail) error.message = `${error.message}: ${detail}`;
        reject(error);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

async function listWindowsAudioOutputs(options = {}) {
  const execFile = options.execFile || defaultExecFile;
  const windowsRoot = options.windowsRoot || process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const stdout = await execute(execFile, powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ENUMERATE_AUDIO_OUTPUTS_SCRIPT
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 5000,
    maxBuffer: 1024 * 1024
  });

  const text = stdout.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  return normalizeWindowsAudioEndpoints(JSON.parse(text));
}

module.exports = {
  ENUMERATE_AUDIO_OUTPUTS_SCRIPT,
  listWindowsAudioOutputs,
  normalizeWindowsAudioEndpoints
};
