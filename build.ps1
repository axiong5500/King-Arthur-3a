# 网页版总构建：原版 → 涂装库 → 天气 → index.html
# 用法：pwsh ./build.ps1 -BaseHtml ../_src/base_web.html -OutHtml ./index.html
# 说明：每次从干净原版重跑两层注入，不在既有成品上叠加

param(
  [Parameter(Mandatory = $true)][string]$BaseHtml,
  [string]$OutHtml = (Join-Path $PSScriptRoot 'index.html')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $BaseHtml)) { throw "缺少原版文件：$BaseHtml" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('ka_skin_stage_' + [guid]::NewGuid().ToString('N') + '.html')
try {
  # 第一层：枪械皮肤
  & (Join-Path $PSScriptRoot 'skin-src\build.ps1') -BaseHtml $BaseHtml -OutHtml $tmp | Out-String | Write-Verbose
  if (-not (Test-Path -LiteralPath $tmp)) { throw '皮肤层构建失败' }

  # 第二层：天气
  & (Join-Path $PSScriptRoot 'weather-src\build.ps1') -BaseHtml $tmp -OutHtml $OutHtml | Out-String
}
finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
}

$n = [IO.File]::ReadAllText($OutHtml)
"{0,-14}{1}" -f '成品字符数', $n.Length
"{0,-14}{1}" -f '层·皮肤', $n.Contains('__kaSkin')
"{0,-14}{1}" -f '层·天气', $n.Contains('__kaWeather')
"{0,-14}{1}" -f '亚瑟王中王', ([regex]::Matches($n, '亚瑟王中王').Count)
"输出：$OutHtml"
