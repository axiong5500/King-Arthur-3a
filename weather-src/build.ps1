# 构建网页版：把「变换多端的天气」注入上游产物（原版 → 涂装库 → 天气）
# 用法：pwsh ./build.ps1 -BaseHtml ../index.html -OutHtml ../index.html
# 说明：只追加 <style> 与 <script> 两处，其余字节不动；对已含天气的文件会拒绝，避免重复注入

param(
  [Parameter(Mandatory = $true)][string]$BaseHtml,
  [string]$OutHtml = (Join-Path (Split-Path -Parent $PSScriptRoot) 'index.html')
)

$ErrorActionPreference = 'Stop'

foreach ($p in @($BaseHtml, (Join-Path $PSScriptRoot 'weather.css'), (Join-Path $PSScriptRoot 'weather.js'))) {
  if (-not (Test-Path -LiteralPath $p)) { throw "缺少文件：$p" }
}

$t = [IO.File]::ReadAllText($BaseHtml)
if (([regex]::Matches($t, '</head>')).Count -ne 1) { throw '输入文件中 </head> 不唯一，停止注入' }
if (([regex]::Matches($t, '</body>')).Count -ne 1) { throw '输入文件中 </body> 不唯一，停止注入' }
if ($t.Contains('id="ka-wx-panel"')) { throw '输入文件已含天气补丁，请改用未注入天气的上游产物' }

$css = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'weather.css'))
$js = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'weather.js'))

$styleBlock = "`n<style id=`"ka-wx-css`">`n" + $css + "`n</style>`n</head>"
$scriptBlock = "`n<script id=`"ka-wx-js`">`n" + $js + "`n</script>`n</body>"

$n = $t.Replace('</head>', $styleBlock).Replace('</body>', $scriptBlock)

[IO.File]::WriteAllText($OutHtml, $n, (New-Object Text.UTF8Encoding($false)))

"{0,-14}{1}" -f '输入字符数', $t.Length
"{0,-14}{1}" -f '输出字符数', $n.Length
"{0,-14}{1}" -f '注入字符数', ($n.Length - $t.Length)
"{0,-14}{1}" -f '天气样式', $n.Contains('ka-wx-css')
"{0,-14}{1}" -f '天气脚本', $n.Contains('__kaWeather')
"{0,-14}{1}" -f '皮肤仍在', $n.Contains('__kaSkin')
"输出：$OutHtml"
