export interface DownloadPageRelease {
  version: string
  fileName: string
  size: number
  sha256: string
  publishedAt: string
  notes: string
}

export interface DownloadPagePortable {
  name: string
  size: number
  sha256: string
  publishedAt: string
  version: string
}

export interface DesktopDownloadPageInput {
  latest: DownloadPageRelease | null
  releases: DownloadPageRelease[]
  portables: DownloadPagePortable[]
  serverVersion: string
}

/** 下载页与工作台共用同一枚 EAB 品牌方块，避免浏览器标签落回默认圆点图标。 */
const BRAND_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#0f766e"/>
  <text x="32" y="35" text-anchor="middle" dominant-baseline="middle" fill="#ffffff"
    font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="28" font-weight="700">EAB</text>
</svg>`
const BRAND_ICON_HREF = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(BRAND_ICON_SVG)}`

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char)
}

function mb(bytes: number): string {
  if (!bytes) return '—'
  return (bytes / 1024 / 1024).toFixed(1)
}

function shortVersion(version: string): string {
  return version ? `v${version.replace(/^v/i, '')}` : '未构建'
}

function shortSha(value: string): string {
  return value && value.length > 16 ? `${value.slice(0, 12)}…` : value || '—'
}

function formatDate(value: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10) || '—'
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function releaseHref(version: string): string {
  return `/download/desktop/setup?version=${encodeURIComponent(version)}`
}

function osIcon(kind: string): string {
  const svg = (body: string) =>
    `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  if (kind === 'windows') {
    return svg('<rect x="3" y="3" width="8" height="8" rx="1.4"/><rect x="13" y="3" width="8" height="8" rx="1.4"/><rect x="3" y="13" width="8" height="8" rx="1.4"/><rect x="13" y="13" width="8" height="8" rx="1.4"/>')
  }
  if (kind === 'macos') {
    return svg('<rect x="3.2" y="4.6" width="17.6" height="12.4" rx="2.2"/><path d="M1.8 19.4h20.4M9.4 20.4h5.2"/>')
  }
  if (kind === 'linux') {
    return svg('<rect x="2.6" y="4" width="18.8" height="14.2" rx="2.6"/><path d="m6.4 9 2.6 2.6-2.6 2.6M12 14.4h4.4"/>')
  }
  if (kind === 'android') {
    return svg('<rect x="6.1" y="7.2" width="11.8" height="14" rx="3.2"/><path d="M9 4.1 7.3 2.3M15 4.1l1.7-1.8M3.8 9.2v8M20.2 9.2v8M9.2 10.4h.01M14.8 10.4h.01"/>')
  }
  if (kind === 'ios') {
    return svg('<rect x="6" y="2.2" width="12" height="19.6" rx="3.4"/><path d="M10 5h4M9.6 19.2h4.8"/>')
  }
  return svg('<circle cx="12" cy="12" r="8.4"/><path d="M5.8 8.2c3.1 4.8 9.1 5.6 12.5 2.8M9.8 18.6c-1.1-5 1.9-9.4 8.1-9.8"/>')
}

interface PlatformTile {
  id: string
  group: 'desktop' | 'mobile'
  title: string
  meta: string
  icon: string
  state: 'available' | 'building' | 'planned'
  stateLabel: string
  detail: string
  action?: string
}

function platformTile(tile: PlatformTile): string {
  const action =
    tile.state === 'available' && tile.action
      ? `<a class="tile-action" href="${tile.action}">下载<span aria-hidden="true">↓</span></a>`
      : `<span class="tile-action is-soon">${tile.state === 'building' ? '构建中' : '预留通道'}</span>`
  return `<article class="platform-tile is-${tile.state}" data-platform="${escapeHtml(tile.id)}">
    <div class="tile-top">
      <span class="os-mark">${osIcon(tile.icon)}</span>
      <span class="tile-badges">
        <span class="device-chip">当前设备</span>
        <span class="state-pill">${escapeHtml(tile.stateLabel)}</span>
      </span>
    </div>
    <h3>${escapeHtml(tile.title)}</h3>
    <p>${escapeHtml(tile.meta)}</p>
    <div class="tile-foot">
      <span class="tile-detail">${escapeHtml(tile.detail)}</span>
      ${action}
    </div>
  </article>`
}

function versionRow(release: DownloadPageRelease, index: number): string {
  const isLatest = index === 0
  return `<div class="version-row">
    <div class="version-primary">
      <div class="version-title">
        <span class="version-number">${escapeHtml(shortVersion(release.version))}</span>
        ${isLatest ? '<span class="latest-chip">最新</span>' : '<span class="history-chip">历史</span>'}
      </div>
      <div class="file-name" title="${escapeHtml(release.fileName)}">${escapeHtml(release.fileName)}</div>
    </div>
    <div class="version-facts">
      <span>${escapeHtml(mb(release.size))} MB</span>
      <span>${escapeHtml(formatDate(release.publishedAt))}</span>
    </div>
    <div class="version-sha" title="${escapeHtml(release.sha256 || '未提供校验值')}">
      <span>SHA256</span>
      <code>${escapeHtml(shortSha(release.sha256))}</code>
    </div>
    <a class="row-download" href="${releaseHref(release.version)}" aria-label="下载 ${escapeHtml(shortVersion(release.version))} Windows 安装包">
      下载<span aria-hidden="true">↓</span>
    </a>
  </div>`
}

function portableRow(release: DownloadPagePortable): string {
  return `<a class="portable-history-row" href="/download/desktop/portable?version=${encodeURIComponent(release.version)}">
    <span class="portable-row-version">${escapeHtml(shortVersion(release.version))}</span>
    <span class="portable-row-meta">${escapeHtml(mb(release.size))} MB · ${escapeHtml(formatDate(release.publishedAt))}</span>
    <span class="portable-row-download" aria-hidden="true">↓</span>
  </a>`
}

export function desktopDownloadPage(input: DesktopDownloadPageInput): string {
  const { latest, releases, portables, serverVersion } = input
  const latestPortable = portables[0] || null
  const versionLabel = shortVersion(latest?.version || '')
  const latestSize = latest ? `${mb(latest.size)} MB` : '等待构建'
  const setupHref = latest ? releaseHref(latest.version) : ''
  const setupDisabled = latest ? '' : ' is-disabled'
  const setupAria = latest ? '' : ' aria-disabled="true"'
  const portableSize = latestPortable ? mb(latestPortable.size) : '—'
  const portableVersion = latestPortable?.version ? shortVersion(latestPortable.version) : '当前构建'
  const portableSha = latestPortable?.sha256 ? `${latestPortable.sha256.slice(0, 12)}…` : '—'
  const portableDate = latestPortable?.publishedAt ? formatDate(latestPortable.publishedAt) : '—'
  const olderPortables = portables.slice(1)
  const archiveCount = releases.length + portables.length
  const note = latest?.notes ? escapeHtml(latest.notes) : ''

  const desktopTiles = [
    {
      id: 'windows-x64',
      group: 'desktop',
      title: 'Windows x64',
      meta: 'Windows 10 / 11 · x64 · .exe',
      icon: 'windows',
      state: 'available',
      stateLabel: '可下载',
      detail: releases.length ? `${releases.length} 个版本` : '等待首个构建',
      action: latest ? setupHref : '#versions',
    },
    {
      id: 'windows-arm64',
      group: 'desktop',
      title: 'Windows ARM64',
      meta: 'Windows 11 on ARM · arm64 · .exe',
      icon: 'windows',
      state: 'building',
      stateLabel: '构建中',
      detail: '原生通道预留',
    },
    {
      id: 'macos-arm64',
      group: 'desktop',
      title: 'macOS · Apple Silicon',
      meta: 'macOS 14+ · arm64 · .dmg',
      icon: 'macos',
      state: 'planned',
      stateLabel: '规划中',
      detail: '版本位已预留',
    },
    {
      id: 'macos-intel',
      group: 'desktop',
      title: 'macOS · Intel',
      meta: 'macOS 12+ · x64 · .dmg',
      icon: 'macos',
      state: 'planned',
      stateLabel: '规划中',
      detail: '版本位已预留',
    },
    {
      id: 'linux-x64',
      group: 'desktop',
      title: 'Linux x64',
      meta: 'Ubuntu / Debian · x64 · .deb / AppImage',
      icon: 'linux',
      state: 'planned',
      stateLabel: '规划中',
      detail: '版本位已预留',
    },
  ] satisfies PlatformTile[]

  const mobileTiles = [
    {
      id: 'android',
      group: 'mobile',
      title: 'Android',
      meta: 'Android 8+ · arm64 / x64 · .apk',
      icon: 'android',
      state: 'planned',
      stateLabel: '规划中',
      detail: '移动端版本位已预留',
    },
    {
      id: 'ios',
      group: 'mobile',
      title: 'iOS / iPadOS',
      meta: 'iOS 15+ · arm64 · TestFlight / .ipa',
      icon: 'ios',
      state: 'planned',
      stateLabel: '规划中',
      detail: '移动端版本位已预留',
    },
    {
      id: 'harmony',
      group: 'mobile',
      title: 'HarmonyOS NEXT',
      meta: 'HarmonyOS 5+ · arm64 · .hap',
      icon: 'harmony',
      state: 'planned',
      stateLabel: '规划中',
      detail: '移动端版本位已预留',
    },
  ] satisfies PlatformTile[]

  const setupRows = releases.length
    ? releases.map(versionRow).join('')
    : `<div class="version-empty">
        <strong>暂时没有可下载的 Windows 安装包</strong>
        <span>发布目录里还没有 EAB-Setup-*-x64.exe，构建完成后版本档案会自动出现。</span>
      </div>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>下载 EAB · 桌面版与移动端</title>
  <link id="eab-favicon" rel="icon" type="image/svg+xml" href="${BRAND_ICON_HREF}" />
  <meta name="theme-color" content="#0f766e" />
  <style>
    :root {
      --brand: #0b7253;
      --brand-deep: #07503b;
      --brand-soft: #e5f3ec;
      --brand-wash: #f1f8f4;
      --ink: #10251d;
      --body: #34483f;
      --muted: #66786f;
      --faint: #8a9991;
      --line: #dce7e1;
      --line-strong: #c8d7cf;
      --paper: #f4f7f3;
      --surface: #ffffff;
      --amber: #a56a22;
      --amber-soft: #fbf2e5;
      --shadow: 0 24px 70px rgba(18, 45, 34, 0.09);
      --radius: 22px;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-width: 320px;
      color: var(--ink);
      overflow-x: hidden;
      background:
        radial-gradient(1150px 580px at 78% -8%, rgba(15, 122, 90, 0.13), transparent 62%),
        radial-gradient(880px 520px at -4% 12%, rgba(190, 151, 86, 0.10), transparent 65%),
        var(--paper);
      font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.32;
      background-image:
        linear-gradient(rgba(13, 80, 58, 0.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(13, 80, 58, 0.045) 1px, transparent 1px);
      background-size: 96px 96px;
      mask-image: linear-gradient(to bottom, #000 0%, transparent 42%);
    }
    a { color: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    .shell { width: min(1180px, calc(100% - 64px)); margin: 0 auto; position: relative; z-index: 1; }
    .topbar {
      height: 84px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      border-bottom: 1px solid rgba(200, 215, 207, 0.7);
    }
    .brand { display: inline-flex; align-items: center; gap: 12px; text-decoration: none; }
    .brand-mark {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, #0f7f5e, #07503b);
      color: #fff;
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 0.04em;
      box-shadow: 0 8px 18px rgba(8, 80, 59, 0.22);
    }
    .brand-copy { display: grid; gap: 1px; }
    .brand-copy strong { font-size: 15px; letter-spacing: 0.01em; }
    .brand-copy small { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; }
    .nav { display: flex; align-items: center; gap: 28px; }
    .nav a { color: var(--muted); text-decoration: none; font-size: 13px; transition: color 160ms ease; }
    .nav a:hover { color: var(--ink); }
    .nav .nav-primary {
      height: 38px;
      padding: 0 16px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      color: var(--ink);
      background: rgba(255, 255, 255, 0.6);
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.04fr) minmax(0, 0.96fr);
      gap: clamp(42px, 6vw, 88px);
      align-items: center;
      padding: 78px 0 62px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 24px;
      color: var(--brand-deep);
      font-family: Consolas, "Courier New", monospace;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.16em;
    }
    .eyebrow-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--brand);
      box-shadow: 0 0 0 6px rgba(11, 114, 83, 0.10);
    }
    h1 {
      margin: 0;
      font-size: clamp(44px, 5.5vw, 72px);
      line-height: 1.14;
      letter-spacing: -0.055em;
      font-weight: 800;
    }
    h1 em { color: var(--brand); font-style: normal; display: inline-block; }
    .hero-copy > p {
      max-width: 560px;
      margin: 24px 0 0;
      color: var(--body);
      font-size: 15px;
      line-height: 1.85;
    }
    .detect-card {
      margin-top: 28px;
      min-height: 76px;
      padding: 14px 16px;
      border: 1px solid var(--line);
      border-radius: 16px;
      display: flex;
      align-items: center;
      gap: 14px;
      background: rgba(255, 255, 255, 0.72);
      box-shadow: 0 10px 30px rgba(20, 52, 39, 0.05);
      backdrop-filter: blur(12px);
    }
    .radar {
      flex: 0 0 38px;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      position: relative;
      display: grid;
      place-items: center;
      background: var(--brand-soft);
      color: var(--brand);
    }
    .radar::before, .radar::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 50%;
      border: 1px solid rgba(11, 114, 83, 0.32);
      animation: pulse 2.8s ease-out infinite;
    }
    .radar::after { animation-delay: 1.4s; }
    .radar svg { width: 18px; height: 18px; position: relative; z-index: 1; }
    @keyframes pulse {
      0% { transform: scale(0.7); opacity: 0.75; }
      75%, 100% { transform: scale(1.55); opacity: 0; }
    }
    .detect-copy { min-width: 0; display: grid; gap: 3px; }
    .detect-copy strong { font-size: 13px; }
    .detect-copy span { color: var(--muted); font-size: 12px; line-height: 1.55; }
    .detect-tag {
      flex: 0 0 auto;
      margin-left: auto;
      padding: 6px 9px;
      border-radius: 8px;
      background: var(--brand-soft);
      color: var(--brand-deep);
      font-family: Consolas, "Courier New", monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      white-space: nowrap;
    }
    .hero-actions { display: flex; flex-wrap: wrap; align-items: stretch; gap: 12px; margin-top: 20px; }
    .primary-download, .secondary-action {
      min-height: 60px;
      border-radius: 14px;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      transition: transform 180ms ease, box-shadow 180ms ease, background 180ms ease;
    }
    .primary-download {
      gap: 14px;
      padding: 0 22px;
      color: #fff;
      background: linear-gradient(135deg, #0d7b58, #07543f);
      box-shadow: 0 16px 34px rgba(9, 91, 67, 0.22);
    }
    .primary-download:hover { transform: translateY(-2px); box-shadow: 0 20px 40px rgba(9, 91, 67, 0.28); }
    .download-arrow {
      width: 32px;
      height: 32px;
      flex: 0 0 32px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      background: rgba(255, 255, 255, 0.13);
      font-size: 18px;
    }
    .download-copy { display: grid; gap: 2px; line-height: 1.2; }
    .download-copy strong { font-size: 14px; }
    .download-copy small { color: rgba(255, 255, 255, 0.72); font-size: 11px; }
    .secondary-action {
      padding: 0 19px;
      border: 1px solid var(--line-strong);
      color: var(--ink);
      background: rgba(255, 255, 255, 0.74);
      font-size: 13px;
      font-weight: 650;
    }
    .secondary-action:hover { background: #fff; transform: translateY(-2px); }
    .primary-download.is-disabled { pointer-events: none; opacity: 0.55; box-shadow: none; }
    .primary-download.is-plan { background: #fff; color: var(--brand-deep); border: 1px solid var(--line-strong); box-shadow: none; }
    .primary-download.is-plan .download-arrow { background: var(--brand-soft); font-size: 15px; }
    .primary-download.is-plan .download-copy small { color: var(--muted); }
    .hero-facts { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--muted); font-size: 11px; }
    .hero-facts span { display: inline-flex; align-items: center; gap: 6px; }
    .hero-facts span::before {
      content: "";
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--brand);
      opacity: 0.7;
    }
    .hero-visual { position: relative; min-width: 0; padding: 12px 8px 24px; }
    .visual-frame {
      min-height: 390px;
      position: relative;
      display: grid;
      place-items: center;
      isolation: isolate;
    }
    .visual-frame::before {
      content: "";
      position: absolute;
      width: 330px;
      height: 330px;
      border-radius: 50%;
      background: radial-gradient(circle at 50% 50%, rgba(109, 190, 154, 0.24), rgba(109, 190, 154, 0) 68%);
      filter: blur(4px);
      z-index: -1;
    }
    .window-mock {
      width: min(480px, 100%);
      border: 1px solid rgba(201, 217, 208, 0.95);
      border-radius: 18px;
      overflow: hidden;
      background: #fff;
      box-shadow: 0 30px 70px rgba(14, 43, 31, 0.17), 0 2px 0 rgba(255, 255, 255, 0.9) inset;
      transform: rotate(-1.5deg);
      transition: transform 260ms ease;
    }
    .visual-frame:hover .window-mock { transform: rotate(0deg) translateY(-4px); }
    .window-top {
      height: 38px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid #e8efeb;
      background: #f8fbf9;
    }
    .window-dots { display: flex; gap: 5px; }
    .window-dots i { width: 7px; height: 7px; border-radius: 50%; background: #d2ded8; display: block; }
    .window-dots i:first-child { background: #86bda7; }
    .address {
      flex: 1;
      height: 22px;
      border-radius: 6px;
      background: #fff;
      border: 1px solid #e6eee9;
      display: flex;
      align-items: center;
      padding: 0 8px;
      color: #8d9d95;
      font-family: Consolas, "Courier New", monospace;
      font-size: 8.5px;
      letter-spacing: 0.02em;
      overflow: hidden;
      white-space: nowrap;
    }
    .local-pill { font-size: 8px; color: var(--brand); font-weight: 700; letter-spacing: 0.08em; }
    .window-body { display: grid; grid-template-columns: 62px minmax(0, 1fr); min-height: 282px; }
    .window-side {
      padding: 14px 9px;
      border-right: 1px solid #e8efeb;
      background: #fbfdfc;
      display: grid;
      align-content: start;
      gap: 11px;
    }
    .mini-brand {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      background: var(--brand);
      color: #fff;
      display: grid;
      place-items: center;
      font-size: 8px;
      font-weight: 800;
      margin-bottom: 5px;
    }
    .side-line { height: 6px; border-radius: 4px; background: #e4ece7; }
    .side-line.s1 { width: 82%; background: #cfe8dc; }
    .side-line.s2 { width: 68%; }
    .side-line.s3 { width: 76%; }
    .side-line.s4 { width: 58%; }
    .window-main { min-width: 0; display: grid; grid-template-rows: auto 1fr; }
    .mock-tabs {
      height: 42px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 12px;
      border-bottom: 1px solid #e9f0ec;
      overflow: hidden;
    }
    .mock-tab {
      height: 26px;
      padding: 0 10px;
      border-radius: 7px 7px 0 0;
      display: inline-flex;
      align-items: center;
      color: #7e8f87;
      font-size: 8.5px;
      white-space: nowrap;
    }
    .mock-tab.active { color: var(--brand-deep); background: var(--brand-wash); font-weight: 700; box-shadow: inset 0 -2px 0 var(--brand); }
    .mock-plus { margin-left: auto; color: #8b9d94; font-size: 12px; }
    .mock-content { padding: 16px 16px 14px; display: grid; gap: 11px; align-content: start; }
    .mock-kicker { color: var(--faint); font-family: Consolas, "Courier New", monospace; font-size: 7.5px; letter-spacing: 0.12em; }
    .mock-question { justify-self: end; width: 68%; padding: 8px 10px; border-radius: 10px 10px 3px 10px; background: #eef7f2; color: #2e5747; font-size: 8.5px; line-height: 1.5; }
    .mock-answer { width: 96%; padding: 11px 12px; border: 1px solid #e5eee9; border-radius: 4px 11px 11px 11px; background: #fff; display: grid; gap: 7px; box-shadow: 0 8px 18px rgba(19, 56, 40, 0.05); }
    .answer-head { display: flex; align-items: center; gap: 6px; color: var(--brand); font-size: 8px; font-weight: 700; }
    .answer-head::before { content: ""; width: 12px; height: 12px; border-radius: 4px; background: var(--brand); }
    .answer-line { height: 5px; border-radius: 3px; background: #e6efea; }
    .answer-line.w90 { width: 90%; }
    .answer-line.w76 { width: 76%; }
    .answer-line.w60 { width: 60%; }
    .answer-card-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 2px; }
    .answer-small-card { height: 38px; border-radius: 6px; background: #f4f9f6; border: 1px solid #e6efea; display: grid; place-items: center; color: #6a8177; font-size: 7px; }
    .float-badge {
      position: absolute;
      padding: 10px 13px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.7);
      background: rgba(255, 255, 255, 0.82);
      box-shadow: 0 16px 34px rgba(15, 50, 35, 0.11);
      backdrop-filter: blur(12px);
      display: grid;
      gap: 1px;
      animation: float 5.5s ease-in-out infinite;
    }
    .float-badge b { color: var(--brand-deep); font-size: 10px; letter-spacing: 0.02em; }
    .float-badge span { color: var(--muted); font-size: 9px; }
    .badge-a { right: -4px; top: 34px; }
    .badge-b { left: -6px; bottom: 26px; animation-delay: -2.8s; }
    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-7px); }
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      border-top: 1px solid var(--line-strong);
      border-bottom: 1px solid var(--line-strong);
    }
    .stat {
      padding: 22px 26px;
      border-right: 1px solid var(--line);
    }
    .stat:first-child { padding-left: 0; }
    .stat:last-child { border-right: 0; }
    .stat strong { display: block; color: var(--ink); font-size: 21px; letter-spacing: -0.03em; line-height: 1.25; }
    .stat span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; }
    section { scroll-margin-top: 24px; }
    .section { padding: 84px 0 0; }
    .section-head {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
      gap: 44px;
      align-items: end;
      margin-bottom: 34px;
    }
    .kicker {
      display: block;
      margin-bottom: 12px;
      color: var(--brand);
      font-family: Consolas, "Courier New", monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.16em;
    }
    .section h2 {
      margin: 0;
      font-size: clamp(28px, 3.2vw, 42px);
      line-height: 1.18;
      letter-spacing: -0.045em;
    }
    .section-head > p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.85; }
    .platform-group { margin-top: 26px; }
    .platform-group + .platform-group { margin-top: 42px; }
    .group-head {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 14px;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.04em;
    }
    .group-head strong { color: var(--ink); font-size: 13px; letter-spacing: 0; }
    .group-head::after { content: ""; flex: 1; height: 1px; background: var(--line); }
    .platform-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .platform-tile {
      min-height: 186px;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 17px;
      background: rgba(255, 255, 255, 0.78);
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
      transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
    }
    .platform-tile:hover { transform: translateY(-3px); border-color: var(--line-strong); box-shadow: 0 18px 38px rgba(18, 48, 35, 0.07); }
    .platform-tile.is-available {
      background: linear-gradient(155deg, #ffffff 0%, #eef8f2 100%);
      border-color: rgba(11, 114, 83, 0.34);
      box-shadow: 0 16px 36px rgba(10, 83, 59, 0.08);
    }
    .platform-tile.is-available::after {
      content: "";
      position: absolute;
      right: -34px;
      bottom: -54px;
      width: 170px;
      height: 170px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(20, 143, 103, 0.14), transparent 65%);
      pointer-events: none;
    }
    .platform-tile.is-building { background: linear-gradient(155deg, #fffdf8, #fbf7ef); border-color: #eadcc4; }
    .platform-tile.is-planned { background: rgba(255, 255, 255, 0.58); }
    .platform-tile.is-planned h3 { color: #51645b; }
    .platform-tile.is-detected { box-shadow: 0 0 0 2px rgba(11, 114, 83, 0.34), 0 18px 40px rgba(10, 83, 59, 0.10); border-color: rgba(11, 114, 83, 0.46); }
    .tile-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    .tile-badges { display: flex; align-items: center; gap: 5px; }
    .os-mark {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      color: var(--brand);
      background: var(--brand-soft);
    }
    .is-building .os-mark { color: var(--amber); background: var(--amber-soft); }
    .is-planned .os-mark { color: #7c8d84; background: #eef3f0; }
    .state-pill {
      padding: 5px 8px;
      border-radius: 999px;
      color: var(--brand-deep);
      background: rgba(11, 114, 83, 0.10);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .is-building .state-pill { color: var(--amber); background: var(--amber-soft); }
    .is-planned .state-pill { color: #7f9087; background: #f0f4f2; }
    .platform-tile h3 { margin: 0; font-size: 16px; letter-spacing: -0.02em; }
    .platform-tile > p { margin: 5px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
    .tile-foot { margin-top: auto; padding-top: 22px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .tile-detail { color: var(--faint); font-size: 10px; }
    .tile-action { display: inline-flex; align-items: center; gap: 4px; color: var(--brand); text-decoration: none; font-size: 11px; font-weight: 700; }
    .tile-action span { font-size: 12px; transition: transform 160ms ease; }
    .tile-action:hover span { transform: translateY(2px); }
    .tile-action.is-soon { color: #98a69f; font-weight: 600; }
    .device-chip {
      display: none;
      padding: 4px 7px;
      border-radius: 6px;
      background: var(--brand);
      color: #fff;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.06em;
      box-shadow: 0 4px 10px rgba(8, 80, 59, 0.22);
      white-space: nowrap;
    }
    .platform-tile.is-detected .device-chip { display: inline-flex; }
    .version-shell {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255, 255, 255, 0.82);
      box-shadow: var(--shadow);
      padding: 10px;
      display: grid;
      grid-template-columns: minmax(0, 1.55fr) minmax(280px, 0.75fr);
      gap: 10px;
    }
    .package-block {
      border-radius: 15px;
      background: #fff;
      border: 1px solid #e7efeb;
      padding: 22px;
      min-width: 0;
    }
    .package-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
    .package-title { display: flex; gap: 12px; min-width: 0; }
    .package-icon {
      flex: 0 0 42px;
      width: 42px;
      height: 42px;
      border-radius: 11px;
      display: grid;
      place-items: center;
      background: var(--brand-soft);
      color: var(--brand-deep);
      font-family: Consolas, "Courier New", monospace;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.04em;
    }
    .package-title h3, .portable-title h3 { margin: 1px 0 3px; font-size: 16px; letter-spacing: -0.02em; }
    .package-title p, .portable-title p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .package-count {
      flex: 0 0 auto;
      padding: 5px 8px;
      border-radius: 7px;
      color: var(--muted);
      background: #f4f7f5;
      font-size: 9px;
      white-space: nowrap;
    }
    .release-note {
      margin: -4px 0 16px;
      padding: 10px 12px;
      border-left: 2px solid rgba(11, 114, 83, 0.35);
      background: var(--brand-wash);
      border-radius: 0 8px 8px 0;
      color: #557067;
      font-size: 10.5px;
      line-height: 1.65;
    }
    .version-list { display: grid; gap: 7px; }
    .version-row {
      display: grid;
      grid-template-columns: minmax(0, 1.18fr) 94px 154px auto;
      gap: 14px;
      align-items: center;
      padding: 14px 14px;
      border: 1px solid #e9f0ec;
      border-radius: 11px;
      background: #fbfdfc;
      transition: border-color 150ms ease, background 150ms ease;
    }
    .version-row:first-child { background: linear-gradient(90deg, #f4faf7, #fbfdfc); border-color: #d9e9e1; }
    .version-row:hover { border-color: #cadbd2; background: #fff; }
    .version-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .version-number { font-family: Consolas, "Courier New", monospace; font-size: 13px; font-weight: 700; letter-spacing: -0.02em; }
    .latest-chip, .history-chip {
      padding: 3px 6px;
      border-radius: 5px;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    .latest-chip { color: var(--brand-deep); background: #dff1e8; }
    .history-chip { color: #7d8f86; background: #eef3f0; }
    .file-name {
      margin-top: 4px;
      color: var(--faint);
      font-family: Consolas, "Courier New", monospace;
      font-size: 8.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .version-facts { display: grid; gap: 3px; color: var(--muted); font-size: 9.5px; }
    .version-facts span:first-child { color: var(--ink); font-size: 11px; font-weight: 650; }
    .version-sha { display: grid; gap: 3px; min-width: 0; }
    .version-sha span { color: var(--faint); font-size: 8px; letter-spacing: 0.08em; }
    .version-sha code {
      color: #5e7268;
      font-family: Consolas, "Courier New", monospace;
      font-size: 9px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row-download {
      height: 32px;
      padding: 0 12px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--brand-deep);
      background: #fff;
      border: 1px solid #cfe0d7;
      text-decoration: none;
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
      transition: background 150ms ease, color 150ms ease;
    }
    .row-download:hover { background: var(--brand-deep); border-color: var(--brand-deep); color: #fff; }
    .version-empty { padding: 26px 18px; border: 1px dashed var(--line-strong); border-radius: 11px; display: grid; gap: 5px; }
    .version-empty strong { font-size: 13px; }
    .version-empty span { color: var(--muted); font-size: 11px; line-height: 1.65; }
    .portable-block {
      display: flex;
      flex-direction: column;
      background: linear-gradient(155deg, #fbfdfc 0%, #f3f9f5 100%);
      border-color: #e1ece6;
    }
    .portable-title { display: flex; gap: 12px; align-items: flex-start; }
    .portable-size { margin: 26px 0 3px; font-size: 38px; font-weight: 800; letter-spacing: -0.06em; line-height: 1; color: var(--brand-deep); }
    .portable-size small { margin-left: 5px; color: var(--muted); font-size: 12px; letter-spacing: 0; font-weight: 500; }
    .portable-caption { color: var(--muted); font-size: 10.5px; line-height: 1.6; }
    .portable-meta { margin-top: 8px; color: var(--faint); font-size: 9.5px; }
    .portable-sha { margin-top: 4px; color: var(--faint); font-family: Consolas, "Courier New", monospace; font-size: 8.5px; overflow: hidden; text-overflow: ellipsis; }
    .portable-archive { margin-top: 18px; padding-top: 14px; border-top: 1px solid #e2ede7; max-height: 156px; overflow-y: auto; }
    .portable-archive-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; color: var(--muted); font-size: 9.5px; }
    .portable-archive-head strong { color: var(--ink); font-size: 10px; }
    .portable-history-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      padding: 7px 8px;
      margin-top: 5px;
      border: 1px solid #e7efeb;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.72);
      text-decoration: none;
      transition: border-color 150ms ease, background 150ms ease;
    }
    .portable-history-row:hover { border-color: #cbdcd3; background: #fff; }
    .portable-row-version { color: var(--brand-deep); font-family: Consolas, "Courier New", monospace; font-size: 9px; font-weight: 700; white-space: nowrap; }
    .portable-row-meta { color: var(--faint); font-size: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .portable-row-download { color: var(--brand); font-size: 11px; font-weight: 700; }
    .portable-download {
      margin-top: auto;
      padding-top: 24px;
    }
    .portable-download a {
      height: 42px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--brand-deep);
      background: #fff;
      border: 1px solid #cfe0d7;
      text-decoration: none;
      font-size: 11px;
      font-weight: 700;
      transition: background 150ms ease, color 150ms ease;
    }
    .portable-download a:hover { background: var(--brand-deep); border-color: var(--brand-deep); color: #fff; }
    .portable-download a.is-disabled { pointer-events: none; opacity: 0.5; }
    .archive-note { margin-top: 14px; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 10.5px; line-height: 1.7; }
    .archive-note::before { content: ""; width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--brand); opacity: 0.7; }
    .install-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .install-step {
      padding: 22px 20px;
      border: 1px solid var(--line);
      border-radius: 15px;
      background: rgba(255, 255, 255, 0.7);
    }
    .step-no { font-family: Consolas, "Courier New", monospace; color: var(--brand); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; }
    .install-step h3 { margin: 15px 0 7px; font-size: 14px; letter-spacing: -0.01em; }
    .install-step p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.75; }
    .install-step code, .notice code {
      padding: 1px 4px;
      border-radius: 4px;
      background: #edf4f0;
      font-family: Consolas, "Courier New", monospace;
      font-size: 9.5px;
      color: #486257;
    }
    .notice {
      margin-top: 24px;
      padding: 18px 20px;
      border: 1px solid #eadcc3;
      border-radius: 14px;
      background: linear-gradient(135deg, #fffdf8, #fcf6ec);
      display: flex;
      gap: 14px;
      align-items: flex-start;
    }
    .notice-mark {
      flex: 0 0 30px;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: #f8ead3;
      color: var(--amber);
      font-size: 13px;
      font-weight: 800;
    }
    .notice-copy { display: grid; gap: 4px; min-width: 0; }
    .notice-copy strong { color: #7e5724; font-size: 12px; }
    .notice-copy span { color: #8a775a; font-size: 10.5px; line-height: 1.75; }
    .footer {
      margin-top: 84px;
      padding: 26px 0 38px;
      border-top: 1px solid var(--line-strong);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      color: var(--muted);
      font-size: 10.5px;
    }
    .footer-left { display: flex; align-items: center; gap: 10px; }
    .footer-mark {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      background: var(--brand);
      color: #fff;
      font-size: 8px;
      font-weight: 800;
    }
    .footer-links { display: flex; gap: 18px; }
    .footer-links a { color: var(--muted); text-decoration: none; }
    .footer-links a:hover { color: var(--ink); }
    .footer-version { font-family: Consolas, "Courier New", monospace; color: var(--faint); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    @media (max-width: 1000px) {
      .hero { grid-template-columns: minmax(0, 1fr) minmax(0, 0.92fr); gap: 34px; }
      .version-shell { grid-template-columns: minmax(0, 1fr); }
      .portable-block { min-height: 210px; }
      .portable-download { padding-top: 18px; }
      .install-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 820px) {
      .shell { width: min(100% - 40px, 680px); }
      .nav { gap: 16px; }
      .nav a:not(.nav-primary) { display: none; }
      .hero { grid-template-columns: minmax(0, 1fr); padding-top: 52px; gap: 34px; }
      .hero-copy > p { max-width: none; }
      .hero-visual { order: 2; max-width: 520px; margin: 0 auto; width: 100%; }
      .section-head { grid-template-columns: minmax(0, 1fr); gap: 14px; }
      .section-head > p { max-width: 620px; }
      .platform-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stat:nth-child(2) { border-right: 0; }
      .stat:nth-child(3), .stat:nth-child(4) { border-top: 1px solid var(--line); }
      .stat:nth-child(3) { padding-left: 0; }
      .version-row { grid-template-columns: minmax(0, 1fr) 96px auto; }
      .version-sha { display: none; }
    }
    @media (max-width: 560px) {
      .shell { width: calc(100% - 32px); }
      .topbar { height: 70px; }
      .brand-copy small { display: none; }
      .nav .nav-primary { height: 34px; padding: 0 12px; font-size: 11px; }
      .hero { padding: 42px 0 38px; }
      h1 { font-size: clamp(38px, 12vw, 54px); }
      .detect-card { align-items: flex-start; }
      .detect-tag { display: none; }
      .hero-actions { display: grid; grid-template-columns: 1fr; }
      .primary-download, .secondary-action { justify-content: center; }
      .visual-frame { min-height: 320px; }
      .window-mock { transform: none; }
      .window-body { grid-template-columns: 50px minmax(0, 1fr); }
      .badge-a { right: -2px; top: 10px; }
      .badge-b { left: -2px; bottom: 4px; }
      .stats { grid-template-columns: 1fr 1fr; }
      .stat { padding: 16px 12px; }
      .stat strong { font-size: 18px; }
      .stat span { font-size: 9.5px; }
      .section { padding-top: 56px; }
      .platform-grid { grid-template-columns: 1fr; }
      .platform-tile { min-height: 164px; }
      .version-shell { padding: 8px; }
      .package-block { padding: 16px; }
      .package-head { gap: 10px; }
      .package-count { display: none; }
      .version-row { grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 13px 12px; }
      .version-facts { grid-column: 1; grid-row: 2; display: flex; gap: 10px; padding-left: 0; }
      .row-download { grid-column: 2; grid-row: 1 / span 2; }
      .version-sha { display: none; }
      .install-grid { grid-template-columns: 1fr; }
      .notice { padding: 15px; }
      .footer { flex-direction: column; align-items: flex-start; gap: 14px; margin-top: 56px; }
      .footer-links { gap: 14px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
      html { scroll-behavior: auto; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/chat" aria-label="EAB 企业智能体基座">
        <span class="brand-mark">EAB</span>
        <span class="brand-copy"><strong>企业智能体基座</strong><small>下载中心 · DESKTOP &amp; MOBILE</small></span>
      </a>
      <nav class="nav" aria-label="下载页导航">
        <a href="#platforms">支持平台</a>
        <a href="#versions">版本档案</a>
        <a href="#install">安装说明</a>
        <a class="nav-primary" href="/chat">进入工作台</a>
      </nav>
    </header>

    <main>
      <section class="hero" aria-labelledby="page-title">
        <div class="hero-copy">
          <span class="eyebrow"><i class="eyebrow-dot"></i>EAB DESKTOP / MOBILE</span>
          <h1 id="page-title">把企业工作台，<br /><em>装进每一块屏幕。</em></h1>
          <p>同一套聊天、Agent、审批与云空间。Windows 桌面版把右侧网页工作台升级为原生 Chromium 标签，真实键鼠、音视频、下载和内网系统都能直接在窗口里使用。</p>

          <div class="detect-card" id="deviceCard">
            <span class="radar" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/><path d="M8 9h8M8 12h5"/></svg>
            </span>
            <span class="detect-copy" aria-live="polite">
              <strong id="detectTitle">正在识别当前设备</strong>
              <span id="detectDetail">读取系统与架构信息，为你匹配对应的安装通道。</span>
            </span>
            <span class="detect-tag" id="detectTag">检测中</span>
          </div>

          <div class="hero-actions">
            <a class="primary-download${setupDisabled}" id="primaryDownload" href="${setupHref || '#versions'}" ${setupAria} data-windows-href="${setupHref}" data-windows-label="下载 Windows 安装包" data-windows-sub="${escapeHtml(versionLabel)} · ${escapeHtml(latestSize)} · x64">
              <span class="download-arrow" aria-hidden="true">↓</span>
              <span class="download-copy">
                <strong id="primaryLabel">下载 Windows 安装包</strong>
                <small id="primarySub">${escapeHtml(versionLabel)} · ${escapeHtml(latestSize)} · x64</small>
              </span>
            </a>
            <a class="secondary-action" id="secondaryAction" href="#versions">查看版本档案</a>
          </div>
          <div class="hero-facts">
            <span>自动识别系统与架构</span>
            <span>安装包独立 SHA256</span>
            <span>内网服务器直连</span>
          </div>
        </div>

        <div class="hero-visual" aria-label="EAB 桌面端界面示意">
          <div class="visual-frame">
            <div class="window-mock">
              <div class="window-top">
                <span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="address">127.0.0.1:8787 / workspace</span>
                <span class="local-pill">本地</span>
              </div>
              <div class="window-body">
                <aside class="window-side" aria-hidden="true">
                  <span class="mini-brand">E</span>
                  <span class="side-line s1"></span>
                  <span class="side-line s2"></span>
                  <span class="side-line s3"></span>
                  <span class="side-line s4"></span>
                </aside>
                <div class="window-main">
                  <div class="mock-tabs" aria-hidden="true">
                    <span class="mock-tab active">工作台</span>
                    <span class="mock-tab">内网系统</span>
                    <span class="mock-tab">云空间</span>
                    <span class="mock-plus">＋</span>
                  </div>
                  <div class="mock-content" aria-hidden="true">
                    <span class="mock-kicker">EAB AGENT WORKSPACE</span>
                    <span class="mock-question">把本周审批待办和内网系统巡检结果整理一下。</span>
                    <div class="mock-answer">
                      <span class="answer-head">EAB Agent</span>
                      <span class="answer-line w90"></span>
                      <span class="answer-line w76"></span>
                      <span class="answer-line w60"></span>
                      <div class="answer-card-row">
                        <span class="answer-small-card">审批摘要</span>
                        <span class="answer-small-card">巡检结果</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <span class="float-badge badge-a"><b>原生 Chromium</b><span>右侧工作台标签</span></span>
            <span class="float-badge badge-b"><b>SHA256</b><span>安装包完整性校验</span></span>
          </div>
        </div>
      </section>

      <div class="stats" aria-label="下载概况">
        <div class="stat"><strong>${releases.length || 0}</strong><span>个 Windows 安装版本</span></div>
        <div class="stat"><strong>${archiveCount}</strong><span>个可回溯的安装包归档</span></div>
        <div class="stat"><strong>8</strong><span>个桌面与移动平台位</span></div>
        <div class="stat"><strong>SHA256</strong><span>每个包独立校验值</span></div>
      </div>

      <section class="section" id="platforms" aria-labelledby="platforms-title">
        <div class="section-head">
          <div>
            <span class="kicker">PLATFORM MATRIX</span>
            <h2 id="platforms-title">先把 Windows 做好，<br />再把同一套体验铺到更多设备。</h2>
          </div>
          <p>打开页面时会读取当前电脑的系统与架构，并高亮对应的安装通道。尚未发布的桌面端和手机端平台已经预留版本位与文件类型，后续发布不需要重做下载页。</p>
        </div>

        <div class="platform-group">
          <div class="group-head"><strong>桌面端</strong><span>Windows · macOS · Linux</span></div>
          <div class="platform-grid">
            ${desktopTiles.map(platformTile).join('')}
          </div>
        </div>

        <div class="platform-group">
          <div class="group-head"><strong>移动端</strong><span>手机与平板 · 版本位预留</span></div>
          <div class="platform-grid">
            ${mobileTiles.map(platformTile).join('')}
          </div>
        </div>
      </section>

      <section class="section" id="versions" aria-labelledby="versions-title">
        <div class="section-head">
          <div>
            <span class="kicker">RELEASE ARCHIVE</span>
            <h2 id="versions-title">每一个版本，<br />都留一条可回滚的下载路径。</h2>
          </div>
          <p>新版不会覆盖旧包。每种安装通道独立维护版本档案，可按版本号、文件大小、发布日期和 SHA256 核对后下载，方便回滚和兼容性排查。</p>
        </div>

        <div class="version-shell">
          <article class="package-block">
            <div class="package-head">
              <div class="package-title">
                <span class="package-icon">EXE</span>
                <div>
                  <h3>Windows x64 安装包</h3>
                  <p>安装向导 · 默认安装到 C:\\Program Files\\EAB · 自动更新</p>
                </div>
              </div>
              <span class="package-count">${releases.length} 个版本</span>
            </div>
            ${note ? `<div class="release-note"><strong>最新构建说明：</strong>${note}</div>` : ''}
            <div class="version-list">
              ${setupRows}
            </div>
          </article>

          <aside class="package-block portable-block" aria-label="Windows 便携版">
            <div class="portable-title">
              <span class="package-icon">ZIP</span>
              <div>
                <h3>Windows x64 便携版</h3>
                <p>解压即用 · 不写注册表 · 适合受控环境</p>
              </div>
            </div>
            <div class="portable-size">${escapeHtml(portableSize)}${latestPortable ? '<small>MB</small>' : ''}</div>
            <div class="portable-caption">${latestPortable ? `随 ${escapeHtml(portableVersion)} 构建归档` : '尚未生成便携包'}</div>
            <div class="portable-meta">${escapeHtml(portableDate)} · ${portables.length} 个归档</div>
            <div class="portable-sha" title="${escapeHtml(latestPortable?.sha256 || '未提供校验值')}">SHA256 ${escapeHtml(portableSha)}</div>
            ${olderPortables.length ? `<div class="portable-archive">
              <div class="portable-archive-head"><strong>更早归档</strong><span>${olderPortables.length} 个版本</span></div>
              ${olderPortables.map(portableRow).join('')}
            </div>` : ''}
            <div class="portable-download">
              <a class="${latestPortable ? '' : 'is-disabled'}" href="${latestPortable ? `/download/desktop/portable?version=${encodeURIComponent(latestPortable.version)}` : '#versions'}" ${latestPortable ? '' : 'aria-disabled="true"'}>下载便携版<span aria-hidden="true">↓</span></a>
            </div>
          </aside>
        </div>
        <div class="archive-note">版本档案由发布目录自动扫描生成；新增平台或新版本安装包后，页面与下载入口会同步出现。</div>
      </section>

      <section class="section" id="install" aria-labelledby="install-title">
        <div class="section-head">
          <div>
            <span class="kicker">INSTALL FLOW</span>
            <h2 id="install-title">四步进入桌面工作台。</h2>
          </div>
          <p>安装包会记住当前下载来源服务器，首次启动自动连接。桌面端后续更新同样通过当前 EAB 服务器分发，并做 SHA256 校验。</p>
        </div>
        <div class="install-grid">
          <article class="install-step">
            <span class="step-no">01 / INSTALL</span>
            <h3>运行安装包</h3>
            <p>双击 <code>EAB-Setup</code>，在向导里确认或修改安装位置，默认目录为 <code>C:\\Program Files\\EAB</code>。</p>
          </article>
          <article class="install-step">
            <span class="step-no">02 / CONNECT</span>
            <h3>首次自动连接</h3>
            <p>安装包已绑定当前下载来源服务器，首次启动不再要求手动填写 EAB 地址。</p>
          </article>
          <article class="install-step">
            <span class="step-no">03 / SIGN IN</span>
            <h3>登录并进入工作台</h3>
            <p>在桌面窗口登录后直接进入；开始菜单和桌面会生成 EAB 快捷方式，后续打开可保持登录。</p>
          </article>
          <article class="install-step">
            <span class="step-no">04 / UPDATE</span>
            <h3>检查更新或卸载</h3>
            <p>桌面端会自动检查新版本并校验更新包；卸载可在 Windows“设置 &gt; 应用”中完成，并选择是否保留本机登录状态。</p>
          </article>
        </div>
        <div class="notice">
          <span class="notice-mark" aria-hidden="true">!</span>
          <span class="notice-copy">
            <strong>安装包尚未做代码签名</strong>
            <span>Windows 可能提示“未知发布者”，请确认来源后再运行。每个安装包都提供独立 SHA256 校验值；Web 版仍然可用，桌面版是可选的高性能形态。</span>
          </span>
        </div>
      </section>
    </main>

    <footer class="footer">
      <div class="footer-left">
        <span class="footer-mark">EAB</span>
        <span>企业智能体基座 · 下载中心</span>
      </div>
      <div class="footer-links">
        <a href="/chat">进入工作台</a>
        <a href="#platforms">平台支持</a>
        <a href="#versions">版本档案</a>
      </div>
      <span class="footer-version">service ${escapeHtml(serverVersion || '—')} · desktop ${escapeHtml(versionLabel)}</span>
    </footer>
  </div>

  <script>
    (() => {
      const primary = document.getElementById('primaryDownload');
      const secondary = document.getElementById('secondaryAction');
      const primaryLabel = document.getElementById('primaryLabel');
      const primarySub = document.getElementById('primarySub');
      const detectTitle = document.getElementById('detectTitle');
      const detectDetail = document.getElementById('detectDetail');
      const detectTag = document.getElementById('detectTag');
      const tiles = Array.from(document.querySelectorAll('[data-platform]'));
      if (!primary || !primaryLabel || !primarySub || !detectTitle || !detectDetail || !detectTag) return;

      const windowsHref = primary.dataset.windowsHref || '';
      const windowsLabel = primary.dataset.windowsLabel || '下载 Windows 安装包';
      const windowsSub = primary.dataset.windowsSub || '';

      const selectTile = (id) => {
        tiles.forEach((tile) => tile.classList.toggle('is-detected', tile.dataset.platform === id));
      };

      const setCopy = (title, detail, tag) => {
        detectTitle.textContent = title;
        detectDetail.textContent = detail;
        detectTag.textContent = tag;
      };

      const setWindowsDownload = (sub) => {
        primary.href = windowsHref || '#versions';
        primary.classList.remove('is-plan');
        primaryLabel.textContent = windowsLabel;
        primarySub.textContent = sub;
        if (secondary) {
          secondary.href = '#versions';
          secondary.textContent = '查看版本档案';
        }
      };

      const setPlanMode = (title, detail, tag, tileId) => {
        selectTile(tileId);
        setCopy(title, detail, tag);
        primary.href = '#platforms';
        primary.classList.add('is-plan');
        primaryLabel.textContent = '查看平台支持计划';
        primarySub.textContent = '当前系统版本位已预留';
        if (secondary && windowsHref) {
          secondary.href = windowsHref;
          secondary.textContent = '下载 Windows x64 版';
        }
      };

      const detect = async () => {
        let architecture = '';
        let bitness = '';
        let platform = '';
        try {
          if (navigator.userAgentData) {
            platform = navigator.userAgentData.platform || '';
            const values = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness']);
            architecture = values.architecture || '';
            bitness = values.bitness || '';
          }
        } catch {
          // 浏览器不支持 Client Hints 时继续用 UA 兜底。
        }
        const ua = navigator.userAgent || '';
        const isWindows = platform === 'Windows' || /Windows/i.test(ua);
        const isAndroid = /Android/i.test(ua);
        const isHarmony = /HarmonyOS|OpenHarmony/i.test(ua);
        const isIOS = /iPhone|iPad|iPod/i.test(ua) || (platform === 'macOS' && navigator.maxTouchPoints > 1);
        const isMac = !isIOS && (platform === 'macOS' || /Macintosh|Mac OS X/i.test(ua));
        const isLinux = !isAndroid && !isHarmony && /Linux/i.test(ua);
        const isARM = /arm|aarch64/i.test(architecture) || /ARM64|aarch64/i.test(ua);
        const is32 = bitness === '32';
        const archLabel = isARM ? 'ARM64' : is32 ? '32 位' : 'x64';

        if (isWindows) {
          if (isARM) {
            selectTile('windows-arm64');
            setCopy('检测到 Windows · ARM64', '原生 ARM64 安装包正在构建，当前可先使用 x64 兼容安装包运行。', 'Windows · ARM64');
            setWindowsDownload('x64 兼容 · ' + windowsSub);
          } else {
            selectTile('windows-x64');
            setCopy('检测到 Windows · ' + archLabel, '已匹配 Windows x64 安装包，可直接下载或回滚历史版本。', 'Windows · ' + archLabel);
            setWindowsDownload(windowsSub);
          }
          return;
        }
        if (isAndroid) {
          setPlanMode('检测到 Android', '移动端安装包已经预留版本位，发布后会在这里自动出现。', 'Android', 'android');
          return;
        }
        if (isHarmony) {
          setPlanMode('检测到 HarmonyOS', 'HarmonyOS NEXT 安装通道已经预留，发布后会在这里自动出现。', 'HarmonyOS', 'harmony');
          return;
        }
        if (isIOS) {
          setPlanMode('检测到 iPhone / iPad', 'iOS 与 iPadOS 安装通道已经预留，发布后会在这里自动出现。', 'iOS', 'ios');
          return;
        }
        if (isMac) {
          const tileId = isARM ? 'macos-arm64' : 'macos-intel';
          setPlanMode('检测到 macOS · ' + (isARM ? 'Apple Silicon' : 'Intel'), 'macOS 客户端正在规划中，当前可先下载 Windows x64 版用于其他设备。', 'macOS · ' + archLabel, tileId);
          return;
        }
        if (isLinux) {
          setPlanMode('检测到 Linux · ' + archLabel, 'Linux 客户端正在规划中，当前可先下载 Windows x64 版用于其他设备。', 'Linux · ' + archLabel, 'linux-x64');
          return;
        }
        selectTile('windows-x64');
        setCopy('未识别当前系统', '已展示当前可用的 Windows x64 安装包；你也可以查看已经预留的其他平台通道。', '未知设备');
      };

      detect();
    })();
  </script>
  <script>
    (() => {
      const icon = document.getElementById('eab-favicon');
      if (!icon) return;
      const xml = (value) => String(value).replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
      const textIcon = (text) => {
        const value = xml(String(text || 'EAB').slice(0, 8));
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#0f766e"/><text x="32" y="35" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="28" font-weight="700">' + value + '</text></svg>';
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      };
      const apply = (brand) => {
        if (!brand) return;
        const dataUrl = typeof brand.iconDataUrl === 'string' && brand.iconDataUrl.startsWith('data:image/') ? brand.iconDataUrl : '';
        const match = /^data:(image\/[^;]+)/i.exec(dataUrl);
        icon.type = dataUrl ? (match ? match[1] : 'image/png') : 'image/svg+xml';
        icon.href = dataUrl || textIcon(brand.logoText);
      };
      fetch('/api/branding', { headers: { accept: 'application/json' }, cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => apply(body && body.data && body.data.branding ? body.data.branding.chat : null))
        .catch(() => {});
    })();
  </script>
</body>
</html>`
}
