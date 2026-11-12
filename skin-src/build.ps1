# 构建网页版：把 PAC-9 涂装库（皮肤功能）注入未打补丁的原版 HTML
# 用法：pwsh ./build.ps1 -BaseHtml ../../_src/base_web.html -OutHtml ../index.html
# 说明：每次从原版重新注入，不叠加；除两处追加与 title 外不改动任何字节

param(
  [Parameter(Mandatory = $true)][string]$BaseHtml,
  [string]$OutHtml = (Join-Path (Split-Path -Parent $PSScriptRoot) 'index.html')
)

$ErrorActionPreference = 'Stop'

foreach ($p in @($BaseHtml, (Join-Path $PSScriptRoot 'skin.css'), (Join-Path $PSScriptRoot 'skin.js'))) {
  if (-not (Test-Path -LiteralPath $p)) { throw "缺少文件：$p" }
}

$t = [IO.File]::ReadAllText($BaseHtml)
if (([regex]::Matches($t, '</head>')).Count -ne 1) { throw '原文件中 </head> 不唯一，停止注入' }
if (([regex]::Matches($t, '</body>')).Count -ne 1) { throw '原文件中 </body> 不唯一，停止注入' }
if ($t.Contains('id="ka-skin-panel"')) { throw '原文件已含皮肤补丁，请改用未注入的原版' }

$css = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'skin.css'))
$js = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'skin.js'))

$styleBlock = "`n<style id=`"ka-skin-css`">`n" + $css + "`n</style>`n</head>"
$scriptBlock = "`n<script id=`"ka-skin-js`">`n" + $js + "`n</script>`n</body>"

$n = $t.Replace('</head>', $styleBlock).Replace('</body>', $scriptBlock)

[IO.File]::WriteAllText($OutHtml, $n, (New-Object Text.UTF8Encoding($false)))

"{0,-14}{1}" -f '原字符数', $t.Length
"{0,-14}{1}" -f '输出字符数', $n.Length
"{0,-14}{1}" -f '注入字符数', ($n.Length - $t.Length)
"{0,-14}{1}" -f '皮肤样式', $n.Contains('ka-skin-css')
"{0,-14}{1}" -f '皮肤脚本', $n.Contains('__kaSkin')
"{0,-14}{1}" -f '亚瑟王中王', ([regex]::Matches($n, '亚瑟王中王').Count)
"输出：$OutHtml"
