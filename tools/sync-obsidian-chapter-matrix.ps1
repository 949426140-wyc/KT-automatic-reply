param(
  [string]$SourceRoot = 'D:\AI\酷太\产品知识库\01_MD章节矩阵',
  [string]$VaultRoot = 'D:\AI\产品自动回复\Dify知识库导入包\_Dify上传合集',
  [string]$TargetFolder = '11_未拆分章节矩阵原文'
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$source = [System.IO.Path]::GetFullPath($SourceRoot)
$vault = [System.IO.Path]::GetFullPath($VaultRoot)
$target = [System.IO.Path]::GetFullPath((Join-Path $vault $TargetFolder))

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw "源章节矩阵不存在：$source"
}
if (-not (Test-Path -LiteralPath (Join-Path $vault '.obsidian') -PathType Container)) {
  throw "目标不是已初始化的 Obsidian 仓库：$vault"
}
if (-not $target.StartsWith($vault, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "目标目录不在 Obsidian 仓库内：$target"
}

New-Item -ItemType Directory -Path $target -Force | Out-Null
$sourceFiles = Get-ChildItem -LiteralPath $source -File -Recurse -Force | Sort-Object FullName
$copied = 0
foreach ($file in $sourceFiles) {
  $relative = $file.FullName.Substring($source.Length).TrimStart('\')
  $destination = Join-Path $target $relative
  $destinationDir = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  $copied += 1
}

$routes = @(
  '| 问题类型 | 优先查看 | 需要时补充 |',
  '| --- | --- | --- |',
  '| 不知道产品叫什么、确认系列 | [[02-产品体系总览]] | [[03-产品明细清单]]、[[11-命名逻辑与竞品]] |',
  '| 抽屉结构、产品区别、抽中抽 | [[04-抽屉产品详解]] | [[03-产品明细清单]] |',
  '| 升降机规格、承重、定制 | [[05-升降机系列详解]] | [[03-产品明细清单]] |',
  '| 置物架、台面架、转角、高柜 | [[06-置物架系列详解]] | [[08A-全屋收纳产品应用]] |',
  '| 收纳模块、配件、电子设备 | [[07-收纳模块与电子设备]] | [[03-产品明细清单]] |',
  '| 空间应用、衣帽间、全屋收纳 | [[08A-全屋收纳产品应用]] | 对应产品详解 |',
  '| 材质、轨道、工艺 | [[09-材质与工艺]] | 对应产品详解 |',
  '| 宽度/深度/高度公式、安装 | [[10-尺寸体系与安装]] | [[10A-极限安装]]、对应产品详解 |',
  '| 极限尺寸、特殊安装条件 | [[10A-极限安装]] | [[10-尺寸体系与安装]] |',
  '| 公司定位、设计理念 | [[01-公司概况与设计理念]] | [[02-产品体系总览]] |'
)

$nav = [System.Collections.Generic.List[string]]::new()
$nav.Add('---')
$nav.Add('tags: [Obsidian导航, 未拆分原文, 产品知识]')
$nav.Add('source_root: "D:/AI/酷太/产品知识库/01_MD章节矩阵"')
$nav.Add('sync_mode: 原文件完整复制')
$nav.Add('---')
$nav.Add('')
$nav.Add('# 未拆分章节矩阵导航')
$nav.Add('')
$nav.Add('> 这里保留未拆散的完整章节，用于先定位产品与问题类型，再进入具体标题读取上下文。自动回复的已核验精准知识卡仍是直接回答层；发现冲突时，应回查本目录原文并同步修正精准知识卡。')
$nav.Add('')
$nav.Add('## 推荐检索顺序')
$nav.Add('')
$nav.Add('1. 先从当前问题和同一会话前文确认：产品名/系列、问题类型、尺寸、门型、图片中的页面或产品。')
$nav.Add('2. 按下表进入一份完整章节，不要只取脱离标题路径的单段内容。')
$nav.Add('3. 尺寸和安装问题同时读取“对应产品详解 + 尺寸体系 + 极限安装”。')
$nav.Add('4. 如果上下文仍不能唯一定位产品，或图片只是商城/付款/订单页面，不生成产品答案。')
$nav.Add('')
$nav.Add('## 意图路由')
$nav.Add('')
foreach ($line in $routes) { $nav.Add($line) }
$nav.Add('')
$nav.Add('## 文档与标题索引')
$nav.Add('')

$markdownFiles = Get-ChildItem -LiteralPath $target -File -Recurse -Filter '*.md' |
  Where-Object { $_.Name -ne '_00_Obsidian导航.md' } |
  Sort-Object Name

foreach ($file in $markdownFiles) {
  $relative = $file.FullName.Substring($target.Length).TrimStart('\').Replace('\', '/')
  $wikiPath = $relative -replace '\.md$', ''
  $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
  $titleMatch = [regex]::Match($content, '(?m)^#\s+(.+?)\s*$')
  $title = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() } else { [System.IO.Path]::GetFileNameWithoutExtension($file.Name) }
  $nav.Add("### [[$wikiPath|$title]]")
  $nav.Add('')
  $headingMatches = [regex]::Matches($content, '(?m)^(#{2,3})\s+(.+?)\s*$')
  foreach ($match in $headingMatches) {
    $level = $match.Groups[1].Value.Length
    $heading = $match.Groups[2].Value.Trim()
    $indent = if ($level -eq 3) { '  ' } else { '' }
    $nav.Add("$indent- [[$wikiPath#$heading|$heading]]")
  }
  if ($headingMatches.Count -eq 0) { $nav.Add('- （本文无二级标题）') }
  $nav.Add('')
}

$navPath = Join-Path $target '_00_Obsidian导航.md'
[System.IO.File]::WriteAllText($navPath, ($nav -join "`n") + "`n", $utf8NoBom)

$entry = @(
  '---',
  'tags: [Obsidian导航, 产品知识]',
  '---',
  '',
  '# 未拆分产品知识章节矩阵入口',
  '',
  "- [[${TargetFolder}/_00_Obsidian导航|打开章节矩阵导航]]",
  "- [[${TargetFolder}/00-AI检索入口|AI 检索入口（原文）]]",
  "- [[${TargetFolder}/00-矩阵索引|矩阵索引（原文）]]",
  '',
  '> 本入口指向完整原文层。产品自动回复仍应先做上下文业务分类；只有确认是具体产品问题后，才进入产品知识检索。',
  ''
)
$entryPath = Join-Path $vault '00_未拆分章节矩阵入口.md'
[System.IO.File]::WriteAllText($entryPath, ($entry -join "`n"), $utf8NoBom)

$mismatches = @()
foreach ($file in $sourceFiles) {
  $relative = $file.FullName.Substring($source.Length).TrimStart('\')
  $destination = Join-Path $target $relative
  $sourceHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  $targetHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
  if ($sourceHash -ne $targetHash) { $mismatches += $relative }
}
if ($mismatches.Count -gt 0) {
  throw "复制后哈希校验失败：$($mismatches -join '、')"
}

Write-Output "已复制并校验 $copied 个文件。"
Write-Output "Obsidian 目录：$target"
Write-Output "导航：$navPath"
Write-Output "仓库入口：$entryPath"
