$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$archive = Join-Path $dist "VideoDrop-Full-$version.zip"
$setup = Join-Path $dist "VideoDrop-Setup-$version.exe"
$framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'

if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The Windows .NET Framework C# compiler is required.'
}

& node (Join-Path $root 'tools\package-chrome.mjs')
if ($LASTEXITCODE -ne 0) { throw 'VideoDrop packaging failed.' }

$buildInfo = Join-Path $dist 'SetupVersion.cs'
Set-Content -LiteralPath $buildInfo -Encoding ASCII -Value (
    '[assembly: System.Reflection.AssemblyVersion("' + $version + '")]'
)
try {
    & $compiler /nologo /target:winexe /optimize+ "/out:$setup" "/resource:$archive,VideoDrop.zip" `
        "/win32manifest:$(Join-Path $PSScriptRoot 'Setup.manifest')" `
        /reference:System.Drawing.dll /reference:System.Windows.Forms.dll `
        /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
        (Join-Path $PSScriptRoot 'Setup.cs') $buildInfo
    if ($LASTEXITCODE -ne 0) { throw 'VideoDrop installer compilation failed.' }
} finally {
    Remove-Item -LiteralPath $buildInfo -ErrorAction SilentlyContinue
}

$sums = foreach ($asset in @($setup, $archive)) {
    $hash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $(Split-Path -Leaf $asset)"
}
$sums | Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ASCII
Write-Output "Built $setup"
