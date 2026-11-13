# 构建单机兵器库：把程序化换模层注入上游产物（原版 → 涂装库 → 兵器库）
# 用法：pwsh ./build.ps1 -BaseHtml ../index.html -OutHtml ../index.html
# 说明：只追加 <style> 与 <script> 两处，其余字节不动；对已含兵器库的文件会拒绝，避免重复注入。仅作用于单机 index.html，不动 mp/。

param(
  [Parameter(Mandatory = $true)][string]$BaseHtml,
  [string]$OutHtml = (Join-Path (Split-Path -Parent $PSScriptRoot) 'index.html')
)

$ErrorActionPreference = 'Stop'

foreach ($p in @($BaseHtml, (Join-Path $PSScriptRoot 'arsenal.css'), (Join-Path $PSScriptRoot 'arsenal.js'))) {
  if (-not (Test-Path -LiteralPath $p)) { throw "缺少文件：$p" }
}

$t = [IO.File]::ReadAllText($BaseHtml)
if (([regex]::Matches($t, '</head>')).Count -ne 1) { throw '输入文件中 </head> 不唯一，停止注入' }
if (([regex]::Matches($t, '</body>')).Count -ne 1) { throw '输入文件中 </body> 不唯一，停止注入' }
if ($t.Contains('id="ka-arsenal-js"')) { throw '输入文件已含兵器库补丁，请改用未注入兵器库的上游产物' }

$css = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'arsenal.css'))
$js  = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'arsenal.js'))

if ($js.Contains('</script')) { throw 'arsenal.js 包含 </script，无法内联' }

$styleBlock  = "`n<style id=`"ka-arsenal-css`">`n" + $css + "`n</style>`n</head>"
$scriptBlock = "`n<script id=`"ka-arsenal-js`">`n" + $js + "`n</script>`n</body>"

$n = $t.Replace('</head>', $styleBlock).Replace('</body>', $scriptBlock)

[IO.File]::WriteAllText($OutHtml, $n, (New-Object Text.UTF8Encoding($false)))

"{0,-14}{1}" -f '输入字符数', $t.Length
"{0,-14}{1}" -f '输出字符数', $n.Length
"{0,-14}{1}" -f '注入字符数', ($n.Length - $t.Length)
"{0,-14}{1}" -f '兵器库样式', $n.Contains('ka-arsenal-css')
"{0,-14}{1}" -f '兵器库脚本', $n.Contains('__kaArsenal')
"{0,-14}{1}" -f '皮肤仍在', $n.Contains('__kaSkin')
"{0,-14}{1}" -f '联机未动', -not $n.Contains('ka-mp-js')
"输出：$OutHtml"
