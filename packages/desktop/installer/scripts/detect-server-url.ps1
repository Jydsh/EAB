param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

# 读取 Windows 下载标记 Zone.Identifier 中的 HostUrl / ReferrerUrl。
# 浏览器从某个 EAB 服务器下载安装包时会写入这个流，安装器据此自动绑定来源服务器。
$ErrorActionPreference = 'SilentlyContinue'
$lines = Get-Content -LiteralPath $Path -Stream Zone.Identifier
if (-not $lines) { exit 1 }

$candidates = @()
foreach ($line in @($lines)) {
  if ($line -match '^(HostUrl|ReferrerUrl)=(.+)$') {
    $candidates += $Matches[2].Trim()
  }
}

foreach ($candidate in $candidates) {
  try {
    $uri = [Uri]$candidate
    if ($uri.Scheme -notin @('http', 'https')) { continue }
    if ([string]::IsNullOrWhiteSpace($uri.Host)) { continue }
    if ($uri.UserInfo) { continue }
    $origin = $uri.GetLeftPart([UriPartial]::Authority)
    if ([string]::IsNullOrWhiteSpace($origin)) { continue }
    [Console]::Out.Write($origin.TrimEnd('/'))
    exit 0
  } catch {
    continue
  }
}

exit 1
