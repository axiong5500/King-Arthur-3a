param(
  [string]$BaseHtml = "",
  [string]$OutHtml  = "",
  [string]$PeerLib  = ""
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$repo = Split-Path $here -Parent

if (-not $BaseHtml) { $BaseHtml = Join-Path $repo "index.html" }
if (-not $OutHtml)  { $OutHtml  = Join-Path $repo "mp\index.html" }
if (-not $PeerLib)  { $PeerLib  = Join-Path $here "peerjs.min.js" }

foreach ($f in @($BaseHtml, $PeerLib, (Join-Path $here "net.css"), (Join-Path $here "net.js"))) {
  if (-not (Test-Path -LiteralPath $f)) { throw "缺少输入：$f" }
}

$enc = New-Object Text.UTF8Encoding $false
$base = [IO.File]::ReadAllText($BaseHtml)
$css  = [IO.File]::ReadAllText((Join-Path $here "net.css"))
$js   = [IO.File]::ReadAllText((Join-Path $here "net.js"))
$lib  = [IO.File]::ReadAllText($PeerLib)

if ($base.Contains('id="ka-mp-js"')) { throw "目标已注入过联机层，请换一个干净基底：$BaseHtml" }
if ($lib.Contains('</script'))       { throw "PeerJS 包含 </script，无法内联" }
if ($js.Contains('</script'))        { throw "net.js 包含 </script，无法内联" }

$headBlock = "<style id=`"ka-mp-css`">`r`n$css`r`n</style>`r`n"
$base = $base.Replace("</head>", $headBlock + "</head>")

$bodyBlock = "<script id=`"ka-mp-lib`">`r`n$lib`r`n</script>`r`n<script id=`"ka-mp-js`">`r`n$js`r`n</script>`r`n"
$idx = $base.LastIndexOf("</body>")
if ($idx -lt 0) { throw "基底缺少 </body>" }
$base = $base.Substring(0, $idx) + $bodyBlock + $base.Substring($idx)

$dir = Split-Path $OutHtml -Parent
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[IO.File]::WriteAllText($OutHtml, $base, $enc)

$out = [IO.File]::ReadAllText($OutHtml)
[pscustomobject]@{
  Out          = $OutHtml
  Bytes        = (Get-Item -LiteralPath $OutHtml).Length
  Chars        = $out.Length
  HasCss       = $out.Contains('id="ka-mp-css"')
  HasLib       = $out.Contains('id="ka-mp-lib"')
  HasJs        = $out.Contains('id="ka-mp-js"')
  HasLaunch    = $out.Contains('ka-mp-launch')
  SkinIntact   = $out.Contains('__kaSkin')
  CloudIntact  = -not $out.Contains('__kaWeather')
} | Format-List
