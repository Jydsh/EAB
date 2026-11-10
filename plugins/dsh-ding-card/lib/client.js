window.__ModuleLoader__.load({
  id: 'dsh-ding-card',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const PLUGIN_VERSION = '2026.11.06';
    // 轻量提取音频播放器（Music/AudioPlayer）变量绑定：
    // 兼容旧卡片（修复前导入，design.audioPlayer 缺失）——从绑定的模板 JSON 兜底扫描，
    // 与 lib/import.js 的 extractAudioPlayer 同逻辑。
    function extractAudioPlayerFromTree(tree) {
      let found = null;
      const varNameOf = (value) => {
        if (!value || typeof value !== 'object') return '';
        if (typeof value.variable === 'string' && value.variable.trim()) return value.variable.trim();
        if (typeof value.content === 'string') {
          const match = value.content.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
          if (match) return match[1];
        }
        return '';
      };
      const scan = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const item of node) scan(item);
          return;
        }
        const name = node.componentName ?? node.component ?? '';
        if ((name === 'Music' || name === 'AudioPlayer') && !found) {
          const props = node.props ?? {};
          found = {
            url: varNameOf(props.music) || varNameOf(props.url),
            coverUrl: varNameOf(props.cover) || varNameOf(props.coverUrl),
            title: varNameOf(props.title),
            artist: varNameOf(props.artist),
          };
          return;
        }
        if (Array.isArray(node.children)) scan(node.children);
        const props = node.props;
        if (props && typeof props === 'object') {
          for (const value of Object.values(props)) {
            if (value && typeof value === 'object') {
              if (Array.isArray(value.value)) scan(value.value);
              else if (typeof value.componentName === 'string' || typeof value.component === 'string') scan(value);
            }
          }
        }
      };
      scan(tree);
      if (!found) return null;
      const result = {};
      for (const [key, value] of Object.entries(found)) {
        if (value) result[key] = value;
      }
      return Object.keys(result).length > 0 ? result : null;
    }
    // 从卡片绑定的模板 JSON 中兜底提取音频播放器绑定（旧卡片 design.audioPlayer 缺失时）。
    function resolveAudioPlayer(card) {
      const direct = card?.design?.audioPlayer ?? null;
      if (direct && typeof direct === 'object') return direct;
      const source = typeof card?.sourceJson === 'string' && card.sourceJson.trim() ? card.sourceJson : '';
      if (!source) return null;
      try {
        const raw = JSON.parse(source);
        const editor = raw?.editorData && typeof raw.editorData === 'string' ? JSON.parse(raw.editorData) : raw;
        return extractAudioPlayerFromTree(editor?.schema?.componentsTree ?? raw?.schema?.componentsTree ?? []);
      } catch {
        return null;
      }
    }

    const NAMESPACE = 'dsh-ding-card';
    const RPC_CHANNEL = 'dsh-ding-card';
    const PANEL_ID = 'dsh-ding-card';

    // 侧边栏入口显隐：由「通用设计」里的侧边栏入口配置控制。
    let sidebarVisible = true;
    // apply 内会挂一个回调：根据 sidebarVisible 动态注册/注销 sidebar.panellist 入口。
    let syncSidebarFn = null;
    function setSidebarVisible(visible) {
      sidebarVisible = Boolean(visible);
      if (syncSidebarFn) syncSidebarFn();
    }

    const zh = { '钉卡片': '钉卡片', '打开钉卡片': '打开钉卡片' };
    const en = { '钉卡片': 'Ding Cards', '打开钉卡片': 'Open Ding Cards' };

    const CARD_TYPES = [
      { value: 'message', label: '消息卡片', deliverable: true, hint: '在钉钉会话中直接投放，支持按钮回调。' },
      { value: 'ceiling', label: '吊顶卡片', deliverable: true, hint: '固定在单聊会话顶部，需要会话管理权限。' },
      { value: 'contact', label: '通讯录卡片', deliverable: false, hint: '通讯录场景使用，当前仅支持设计与导出。' },
      { value: 'workbench', label: '工作台卡片', deliverable: false, hint: '工作台场景使用，当前仅支持设计与导出。' },
      { value: 'calendar', label: '日程卡片', deliverable: false, hint: '日程场景使用，当前仅支持设计与导出。' },
      { value: 'standard', label: '标准卡片', deliverable: true, hint: '钉钉标准卡片，适合展示结构化信息。' },
    ];
    const TYPE_MAP = Object.fromEntries(CARD_TYPES.map((type) => [type.value, type]));
    // 音乐播放器四槽位：手动绑定（拖拽/输入）写入 design.audioPlayer 的对应字段。
    const AUDIO_BIND_SLOTS = [
      { key: 'url', label: '音频地址' },
      { key: 'coverUrl', label: '封面' },
      { key: 'title', label: '标题' },
      { key: 'artist', label: '歌手' },
    ];
    const THEMES = [
      { value: 'blue', color: '#3370ff', soft: '#eaf1ff' },
      { value: 'green', color: '#1a9d63', soft: '#e6f7ef' },
      { value: 'orange', color: '#d97706', soft: '#fff4e5' },
      { value: 'red', color: '#d54941', soft: '#fdeceb' },
      { value: 'neutral', color: '#646a73', soft: '#f2f3f5' },
    ];

    const DEFAULT_VARIABLES = {
      title: 'title',
      subtitle: 'subtitle',
      content: 'content',
      fields: 'fields',
      image: 'image',
      state: 'state',
      actions: 'actions',
      optionVars: ['option1', 'option2', 'option3', 'option4', 'option5', 'option6'],
      actionsMode: 'fixed',
      optionParam: 'dsh_option',
      maxOptions: 4,
    };

    const styles = `
.ddc-page { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box; color: var(--dsw-alias-label-primary, #1f2329); }
/* 顶部固定区（页头 + 标签栏 + Tab 顶部操作区）与下方滚动内容区分层：
   pageTop 固定不滚，pageBody 独立滚动，tabSticky 相对 pageBody 顶部吸附。 */
.ddc-pageTop { flex: 0 0 auto; min-height: 0; padding: 24px clamp(16px, 4vw, 48px) 14px; box-sizing: border-box; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.ddc-pageBody { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 clamp(16px, 4vw, 48px) 32px; box-sizing: border-box; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.ddc-shell { width: min(1180px, 100%); margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.ddc-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.ddc-brand { display: flex; flex-direction: column; gap: 4px; }
.ddc-brand h1 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 800; letter-spacing: .02em; }
.ddc-brand p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; }
.ddc-version { color: var(--dsw-alias-label-tertiary, #8f959e); font: 500 10px/16px ui-monospace, SFMono-Regular, Menlo, monospace; margin-left: 8px; cursor: pointer; }
.ddc-versionNew { color: #d97706; background: rgba(217, 119, 6, .12); padding: 0 6px; border-radius: 999px; }
.ddc-envBadge { margin-left: 8px; padding: 0 7px; border-radius: 999px; font: 600 10px/16px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-secondary, #4e5969); background: var(--dsw-alias-fill-secondary, rgba(0, 0, 0, .06)); }
.ddc-envBadge[data-env="web"] { color: #2563eb; background: rgba(37, 99, 235, .12); }
.ddc-envBadge[data-env="desktop"] { color: #059669; background: rgba(5, 150, 105, .12); }
.ddc-updateBanner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border: 1px solid rgba(217, 119, 6, .35); border-radius: 10px; font-size: 12px; line-height: 18px; color: #92400e; background: rgba(217, 119, 6, .08); }
.ddc-updateBanner code { font: 500 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; color: #78350f; background: rgba(217, 119, 6, .1); padding: 2px 6px; border-radius: 6px; word-break: break-all; }
.ddc-updateBannerActions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.ddc-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.ddc-search { flex: 0 1 220px; min-width: 140px; padding: 6px 10px; border: 1px solid #dfe1e5; border-radius: 8px; font-size: 13px; outline: none; background: #fff; color: #1f2329; }
.ddc-search:focus { border-color: #3370ff; box-shadow: 0 0 0 2px rgba(51, 112, 255, 0.12); }
.ddc-button { min-height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 13px; cursor: pointer; transition: background .15s ease, border-color .15s ease; }
.ddc-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.ddc-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.ddc-button:disabled { opacity: .55; cursor: not-allowed; }
.ddc-buttonPrimary { border-color: var(--dsw-alias-state-business-primary, #3370ff); color: #fff; background: var(--dsw-alias-state-business-primary, #3370ff); }
.ddc-buttonPrimary:hover:not(:disabled) { background: #2b64e6; }
.ddc-iconButton { width: 34px; height: 34px; padding: 0; }
.ddc-iconButton svg { display: block; }
.ddc-buttonDanger { color: var(--dsw-alias-state-error-primary, #d54941); }
.ddc-buttonSmall { min-height: 28px; padding: 0 9px; font-size: 12px; border-radius: 7px; }
.ddc-tabs { display: flex; gap: 4px; padding: 4px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); width: max-content; max-width: 100%; overflow-x: auto; }
.ddc-tab { min-height: 32px; padding: 0 14px; border: 0; border-radius: 7px; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
.ddc-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 3px rgb(31 35 41 / 12%); }
.ddc-tab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.ddc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.ddc-card { border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 2px rgb(31 35 41 / 3%); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.ddc-card h2 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 650; }
.ddc-card p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; }
.ddc-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; font-size: 12px; line-height: 18px; }
.ddc-kv dt { color: var(--dsw-alias-label-tertiary, #8f959e); }
.ddc-kv dd { margin: 0; color: var(--dsw-alias-label-primary, #1f2329); overflow-wrap: anywhere; }
.ddc-pill { display: inline-flex; align-items: center; gap: 6px; min-height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--dsw-alias-bg-module-platform, #f2f3f5); color: var(--dsw-alias-label-secondary, #646a73); }
.ddc-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.ddc-pill[data-tone="success"] { color: var(--dsw-alias-state-success-primary, #20a162); background: color-mix(in srgb, currentColor 10%, transparent); }
.ddc-pill[data-tone="warning"] { color: var(--dsw-alias-state-warn-primary, #d97706); background: color-mix(in srgb, currentColor 10%, transparent); }
.ddc-pill[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, currentColor 10%, transparent); }
.ddc-form { display: flex; flex-direction: column; gap: 16px; }
/* Tab 页顶部固定区（变量集 / 卡片库）：整块平贴页面顶部，向下滚动时保持可见，只有下方列表滚动。
   不使用悬浮/阴影样式，背景与页面同色系，仅以细分割线与列表区分。 */
.ddc-tabSticky { position: sticky; top: 0; z-index: 15; display: flex; flex-direction: column; gap: 10px; padding: 12px 0 10px; margin: -4px 0 0; background: var(--dsw-alias-bg-module-platform, #f7f8fa); border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.ddc-section { border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.ddc-sectionHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ddc-sectionHead h2 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 650; }
.ddc-sectionHead span { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.ddc-field { display: grid; gap: 6px; }
.ddc-field > label { color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; font-weight: 560; }
.ddc-field input[type="text"], .ddc-field input[type="url"], .ddc-field input[type="number"], .ddc-field select, .ddc-field textarea {
  width: 100%; box-sizing: border-box; min-height: 36px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: 13px/34px ui-monospace, SFMono-Regular, Menlo, monospace;
}
.ddc-field textarea { min-height: 92px; padding: 8px 10px; line-height: 1.6; resize: vertical; font-family: inherit; }
.ddc-field input:focus-visible, .ddc-field select:focus-visible, .ddc-field textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 1px; }
.ddc-hint { margin: 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 17px; }
.ddc-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.ddc-rowTight { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) max-content; gap: 8px; align-items: end; }
.ddc-switch { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.ddc-switch input { width: 18px; height: 18px; accent-color: var(--dsw-alias-state-business-primary, #3370ff); cursor: pointer; flex: none; }
.ddc-switch span { font-size: 13px; }
.ddc-switch small { display: block; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.ddc-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 0; }
.ddc-saveHint { margin-top: 4px; padding: 10px 12px; border: 1px dashed #dfe1e5; border-radius: 8px; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; background: #fafbfc; }
.ddc-notice { padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.ddc-notice[data-tone="warning"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 30%, var(--dsw-alias-border-l2, #dfe1e5)); color: var(--dsw-alias-state-warn-primary, #d97706); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.ddc-notice[data-tone="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 30%, var(--dsw-alias-border-l2, #dfe1e5)); color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.ddc-code { display: block; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); color: var(--dsw-alias-label-primary, #1f2329); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; white-space: pre-wrap; }
.ddc-logs { display: flex; flex-direction: column; gap: 6px; }
.ddc-log { display: grid; grid-template-columns: 150px 62px minmax(0, 1fr); gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 8px; font-size: 12px; line-height: 17px; }
.ddc-log time { color: var(--dsw-alias-label-tertiary, #8f959e); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.ddc-log em { font-style: normal; font-weight: 650; }
.ddc-log em[data-level="warn"] { color: var(--dsw-alias-state-warn-primary, #d97706); }
.ddc-log em[data-level="error"] { color: var(--dsw-alias-state-error-primary, #d54941); }
.ddc-log span { overflow-wrap: anywhere; }
.ddc-empty { padding: 28px; text-align: center; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 13px; }
.ddc-pluginOpen { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 14px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 13px; cursor: pointer; }
.ddc-pluginOpen:hover { background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.ddc-pluginOpen:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 3px; }
.ddc-pluginPage { height: 100%; min-height: 0; overflow: auto; box-sizing: border-box; padding: 24px clamp(16px, 4vw, 48px) 32px; color: var(--dsw-alias-label-primary, #1f2329); }
.ddc-sidebarIcon { flex: none; }
.ddc-cardList { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.ddc-cardItem { display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); padding: 16px; box-shadow: 0 1px 2px rgb(31 35 41 / 3%); }
.ddc-cardItemHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ddc-cardItemTitle { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ddc-cardItemTitle strong { font-size: 15px; line-height: 20px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ddc-cardItemTitle span { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.ddc-cardItemDesc { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; min-height: 18px; }
.ddc-typeBadge { display: inline-flex; align-items: center; gap: 5px; min-height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11px; font-weight: 650; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f2f3f5); white-space: nowrap; }
.ddc-typeBadge[data-deliverable="false"] { color: var(--dsw-alias-label-tertiary, #8f959e); }
.ddc-bindRow { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 8px; align-items: center; }
.ddc-bindRow input { width: 100%; box-sizing: border-box; height: 34px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.ddc-bindRow input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 1px; }
.ddc-cardItemActions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ddc-editorLayout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); gap: 18px; align-items: start; }
@media (max-width: 900px) { .ddc-editorLayout { grid-template-columns: minmax(0, 1fr); } }
.ddc-varsLayout { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 18px; align-items: start; }
/* 变量集统一网格：按容器宽度自适应，每行最少 1 条、最多 3 条。 */
.ddc-varsGrid { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; align-items: stretch; }
.ddc-varCard { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid #dfe1e5; border-radius: 12px; background: #fafbfc; min-width: 0; }
.ddc-varCardHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.ddc-varCardTags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ddc-varSrc { padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 18px; border: 1px solid #dfe1e5; background: #fff; color: #646a73; white-space: nowrap; }
.ddc-varSrcTemplate { border-color: #b9d0ff; background: #e8f1ff; color: #3370ff; }
.ddc-varDesc { margin: 0; font-size: 13px; line-height: 1.5; color: #4e5969; word-break: break-word; }
.ddc-varNote { margin: 0; font-size: 12px; color: #8f959e; }
.ddc-varCardFoot { display: flex; align-items: center; gap: 6px; justify-content: flex-end; border-top: 1px dashed #e5e6eb; padding-top: 8px; }
.ddc-varsSectionHead { margin: 4px 0 8px; }
.ddc-hintNote { color: #8f959e; font-size: 12px; margin-right: 8px; }
.ddc-varsPane { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ddc-varsPane .ddc-sectionHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ddc-varsPane .ddc-sectionHead h2 { white-space: nowrap; }
.ddc-varsCount { color: #646a73; font-size: 12px; }
.ddc-varsList { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.ddc-varRow { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid #dfe1e5; border-radius: 10px; background: #fafbfc; }
.ddc-varName { font: 12px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #3370ff; background: rgba(51, 112, 255, 0.08); padding: 1px 6px; border-radius: 4px; align-self: flex-start; }
.ddc-varType { align-self: flex-start; padding: 0 7px; border: 1px solid #dfe1e5; border-radius: 999px; color: #4e5969; font-size: 11px; line-height: 18px; background: #fff; white-space: nowrap; }
.ddc-varMock { align-self: flex-start; color: #8f959e; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-all; max-width: 100%; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; border: none; background: transparent; padding: 0; text-align: left; cursor: pointer; line-height: 1.6; transition: color 160ms ease; }
.ddc-varMock:hover { color: #3370ff; text-decoration: underline; text-underline-offset: 2px; }
/* Mock 编辑/查看弹窗：可调整大小的文本框（右下角拖拽），长内容完整展示与编辑。 */
.ddc-mockTextarea, .ddc-mockViewText { width: 100%; min-height: 96px; resize: both; box-sizing: border-box; padding: 8px 10px; border: 1px solid #dfe1e5; border-radius: 8px; font: inherit; font-size: 13px; line-height: 1.6; color: #1f2329; background: #fff; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ddc-mockViewText { min-height: 200px; background: #fafbfc; cursor: text; }
.ddc-mockViewModal { width: min(680px, 92vw); }
.ddc-varBind { align-self: flex-start; margin: 0; color: #3370ff; font-size: 11px; background: rgba(51, 112, 255, 0.08); border-radius: 4px; padding: 1px 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ddc-bindBox { position: relative; }
.ddc-bindDropdown { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; right: 0; max-height: 220px; overflow-y: auto; background: #fff; border: 1px solid #dfe1e5; border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12); padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.ddc-bindCandidate { display: block; width: 100%; text-align: left; border: 0; border-radius: 6px; background: transparent; color: #3370ff; font-size: 13px; line-height: 30px; padding: 0 10px; cursor: pointer; transition: background 140ms ease, color 140ms ease; }
.ddc-bindCandidate:hover { background: #f0f5ff; color: #1f4fd8; }
.ddc-bindEmpty { margin: 0; padding: 8px 10px; font-size: 12px; color: #8f959e; }
.ddc-mockRows { display: flex; flex-direction: column; gap: 8px; }
.ddc-mockRow { display: flex; align-items: center; gap: 8px; border: 1px solid transparent; border-radius: 8px; padding: 2px; transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease; }
.ddc-mockRow[data-row-idx] { will-change: transform; }
.ddc-mockRow .ddc-mockDragHandle { flex: 0 0 auto; width: 16px; align-self: stretch; padding: 0 2px; display: flex; align-items: center; justify-content: center; }
.ddc-mockRow.ddc-varDragging { opacity: 0.55; border-color: #3370ff; box-shadow: 0 4px 14px rgba(51, 112, 255, 0.16); background: #f5f8ff; }
.ddc-mockRow.ddc-varDropTarget { border-color: #3370ff; background: #f5f8ff; box-shadow: 0 2px 8px rgba(51, 112, 255, 0.12); }
.ddc-mockObject { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid #dfe1e5; border-radius: 10px; background: #fafbfc; }
.ddc-mockOptionPair { display: flex; gap: 12px; align-items: flex-start; }
.ddc-mockOptionPair > div { flex: 1; min-width: 0; }
.ddc-mockObjectHead { display: flex; align-items: center; justify-content: space-between; font-size: 13px; font-weight: 600; color: #4e5969; }
.ddc-varDesc { color: #4e5969; font-size: 13px; line-height: 18px; }
.ddc-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; padding: 20px; }
.ddc-modal { background: #fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18); min-width: 360px; max-width: 520px; max-height: 80vh; display: flex; flex-direction: column; }
/* 变量集弹框：头部 / 内容 / 底部按钮 */
.ddc-modalHead { display: flex; flex-direction: column; gap: 4px; padding: 18px 20px 12px; border-bottom: 1px solid #eef0f3; }
/* 发送测试弹窗顶部固定栏：标题、说明与右侧消息图标同一行 */
.ddc-modalHeadRow { flex-direction: row; align-items: center; gap: 8px; position: relative; }
.ddc-headSpacer { flex: 1 1 auto; }
/* 模板变量配置浮动面板：hover 图标显示，移出消失（面板内支持滚动） */
.ddc-msgIconWrap { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; color: #86909c; cursor: pointer; transition: background 160ms ease, color 160ms ease; flex: 0 0 auto; }
.ddc-msgIconWrap:hover, .ddc-msgIconWrap:focus-within { background: #eef3ff; color: #3370ff; }
.ddc-msgIcon { display: inline-flex; align-items: center; }
.ddc-msgPopover { display: none; position: absolute; top: calc(100% + 8px); right: 0; z-index: 30; width: 420px; max-width: 78vw; max-height: 56vh; overflow-y: auto; background: #fff; border: 1px solid #dfe1e5; border-radius: 10px; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14); padding: 12px; animation: ddcPopIn 180ms ease; }
.ddc-msgIconWrap:hover .ddc-msgPopover { display: block; }
@keyframes ddcPopIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
.ddc-modalHead h3 { margin: 0; font-size: 15px; font-weight: 600; color: #1f2329; }
.ddc-modalHead h2 { margin: 0; font-size: 16px; font-weight: 600; color: #1f2329; display: flex; align-items: center; gap: 8px; }
.ddc-modalHead h2 .ddc-headMark { width: 8px; height: 20px; border-radius: 4px; background: linear-gradient(180deg, #3370ff, #6f8dff); }
.ddc-modalHead p { margin: 0; font-size: 12px; color: #8f959e; }
.ddc-modalBody { padding: 16px 20px; overflow: auto; display: flex; flex-direction: column; gap: 14px; }
.ddc-modalFoot { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid #eef0f3; }
/* 删除确认弹框 */
.ddc-delBody { padding: 26px 24px 20px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; }
.ddc-delIcon { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(213, 73, 65, 0.12); color: #d54941; margin-bottom: 8px; }
.ddc-delTitle { margin: 0; font-size: 16px; font-weight: 600; color: #1f2329; }
.ddc-delDesc { margin: 0; font-size: 13px; color: #646a73; line-height: 20px; }
.ddc-delName { font: 13px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #d54941; font-weight: 600; }
.ddc-buttonDangerSolid { border-color: #d54941; color: #fff; background: #d54941; }
.ddc-buttonDangerSolid:hover:not(:disabled) { background: #c13a33; }
.ddc-pickerBody { display: flex; flex-direction: column; gap: 12px; padding: 18px; overflow: auto; flex: 1; min-height: 0; }
.ddc-pickerBody h3 { margin: 0; font-size: 15px; }
.ddc-pickerList { display: flex; flex-direction: column; gap: 6px; max-height: 280px; overflow-y: auto; }
.ddc-chatArea { display: flex; flex-direction: column; gap: 10px; min-height: 120px; padding: 12px; border: 1px dashed var(--dsw-alias-border-l3, #d3d6dd); border-radius: 10px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.ddc-chatEmpty { align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; line-height: 18px; text-align: center; }
.ddc-chatError { color: var(--dsw-alias-state-error-primary, #d54941); border-color: color-mix(in srgb, currentColor 40%, transparent); }
.ddc-chatErrorStrong { font-weight: 600; }
.ddc-jsonBlock { display: flex; flex-direction: column; gap: 8px; }
.ddc-tplVars { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; max-height: 340px; overflow-y: auto; }
.ddc-tplVarRow { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 6px 8px; background: #f7f8fa; border-radius: 6px; }
.ddc-tplVarType { color: #646a73; white-space: nowrap; }
.ddc-tplVarExample { color: #86909c; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ddc-jsonPreview { margin: 0; padding: 10px; max-height: 220px; overflow: auto; border: 1px solid #dfe1e5; border-radius: 8px; background: #0f172a; color: #d6e2ff; font: 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
.ddc-varTag { display: inline-flex; align-items: center; font: 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #3370ff; background: rgba(51, 112, 255, 0.08); padding: 0 6px; border-radius: 4px; margin-left: 6px; }
.ddc-modalWideL { max-width: 1000px; width: 94vw; }
.ddc-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: stretch; max-height: min(70vh, 640px); }
@media (max-width: 880px) { .ddc-split { grid-template-columns: minmax(0, 1fr); max-height: none; } }
.ddc-leftPane, .ddc-rightPane { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; overflow-y: auto; }
.ddc-rightPane { gap: 12px; }
.ddc-paneBlock { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid #eef0f3; border-radius: 10px; background: #fafbfc; }
.ddc-paneBlock .ddc-chatArea { min-height: 96px; }
.ddc-cardPreview { display: flex; flex-direction: column; gap: 8px; padding: 14px; border: 1px solid #e5e6eb; border-radius: 10px; background: #fff; }
.ddc-cardPreviewState { align-self: flex-start; font-size: 11px; color: #3370ff; background: rgba(51, 112, 255, 0.08); padding: 1px 8px; border-radius: 10px; }
.ddc-cardPreviewTitle { margin: 0; font-size: 15px; font-weight: 600; color: #1f2329; }
.ddc-cardPreviewSub { margin: 0; font-size: 12px; color: #646a73; }
.ddc-cardPreviewBody { margin: 0; font-size: 13px; line-height: 20px; color: #1f2329; white-space: pre-wrap; word-break: break-word; }
.ddc-cardPreviewFields { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #4e5969; }
.ddc-cardPreviewOpts { display: flex; flex-wrap: wrap; gap: 8px; }
.ddc-cardPreviewOpt { padding: 5px 14px; border: 1px solid #3370ff; color: #3370ff; background: #fff; border-radius: 16px; font-size: 12px; }
.ddc-pickerRow { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; text-align: left; padding: 9px 11px; border: 1px solid #dfe1e5; border-radius: 8px; background: #fafbfc; color: #1f2329; font-size: 13px; cursor: pointer; }
button.ddc-pickerRow:hover { border-color: #3370ff; }
.ddc-pickerRow input[type='checkbox'] { margin: 0; }
.ddc-modalWide { max-width: 760px; }
.ddc-testParams { display: flex; flex-direction: column; gap: 12px; padding: 12px 0; border-top: 1px solid #eef0f3; margin-top: 4px; }
.ddc-varDragList { display: flex; flex-direction: column; gap: 10px; }
.ddc-varDragItem { display: flex; align-items: flex-start; gap: 6px; border: 1px solid transparent; border-radius: 8px; transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease; }
.ddc-varDragItem .ddc-field { flex: 1; min-width: 0; }
.ddc-varDragHandle { flex: 0 0 auto; width: 18px; align-self: center; color: #a8abb3; font-size: 14px; letter-spacing: -1px; cursor: grab; text-align: center; user-select: none; padding: 4px 2px; }
/* 选项按钮整体：随左侧变量一起拖拽排序（拖动手柄 + 内容卡片） */
.ddc-optionBlock { flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 10px 12px; border: 1px solid #eef0f3; border-radius: 10px; background: #fafbfc; }
.ddc-optionDragHandle { align-self: flex-start; margin-top: 14px; }
.ddc-varDragHandle:active { cursor: grabbing; }
.ddc-varDragItem.ddc-varDragging { opacity: 0.55; border-color: #3370ff; box-shadow: 0 4px 14px rgba(51, 112, 255, 0.16); background: #f5f8ff; }
.ddc-varDragItem.ddc-varDropTarget { border-color: #3370ff; background: #f5f8ff; box-shadow: 0 2px 8px rgba(51, 112, 255, 0.12); }
.ddc-varDragItem[data-var-name] { will-change: transform; }
.ddc-optionRows, .ddc-varRows { display: flex; flex-direction: column; gap: 8px; }
/* 会话模糊搜索框与全选/刷新按钮一行；「选择会话」标题独占上一行 */
.ddc-chatHead { align-items: stretch; flex-direction: column; row-gap: 8px; }
.ddc-chatHead h2 { flex-basis: auto; }
.ddc-chatTools { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ddc-chatTools .ddc-chatSearch { flex: 1 1 auto; min-width: 120px; margin-left: 0; }
/* 自动刷新提示：说明弹窗打开期间会话列表会自己更新，不必手动点刷新 */
.ddc-chatAutoHint { flex: 0 0 auto; font-size: 11px; color: #86909c; white-space: nowrap; cursor: help; }
/* 已选会话红点角标（类似 QQ 99+ 消息提醒）：0 个不显示，>99 显示 99+ */
.ddc-badgeWrap { position: relative; display: inline-flex; }
.ddc-chatBadge { position: absolute; top: -7px; right: -9px; min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; background: #f53f3f; color: #fff; font-size: 10px; line-height: 16px; text-align: center; font-weight: 700; box-shadow: 0 1px 3px rgba(245, 63, 63, 0.35); animation: ddcPopIn 180ms ease; }
/* 卡片库/变量集下拉多选筛选 */
.ddc-typeFilter { position: relative; display: inline-flex; }
.ddc-typeFilterBtn { display: inline-flex; align-items: center; gap: 4px; }
.ddc-caret { font-size: 10px; opacity: 0.7; }
.ddc-typeMenu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; min-width: 168px; background: #fff; border: 1px solid #dfe1e5; border-radius: 10px; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14); padding: 6px; display: flex; flex-direction: column; gap: 2px; animation: ddcPopIn 180ms ease; }
.ddc-typeOption { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 6px; font-size: 13px; color: #1f2329; cursor: pointer; transition: background 140ms ease; }
.ddc-typeOption:hover { background: #f5f8ff; }
.ddc-typeOption input { margin: 0; }
.ddc-typeOptionHint { margin-left: auto; font-size: 11px; color: #86909c; }
.ddc-typeMenuScroll { max-height: 320px; overflow-y: auto; }
/* 音乐播放器效果预览（AudioPlayer 组件） */
.ddc-audioPreview { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid #e5e6eb; border-radius: 10px; background: #fafbfc; }
.ddc-audioMain { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ddc-audioCover { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; background: linear-gradient(135deg, #6f8dff, #3370ff); }
.ddc-audioCoverEmpty { display: flex; align-items: center; justify-content: center; color: #fff; font-size: 20px; }
.ddc-audioInfo { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ddc-audioTitle { margin: 0; font-size: 13px; font-weight: 600; color: #1f2329; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ddc-audioArtist { margin: 0; font-size: 12px; color: #646a73; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ddc-audioMissing { margin: 2px 0 0; font-size: 11px; color: #f53f3f; word-break: break-all; }
/* 音乐播放器四槽位手动绑定：拖拽/输入变量名，实时持久化。 */
.ddc-audioBind { margin-top: 10px; padding-top: 8px; border-top: 1px dashed #e5e6eb; }
.ddc-audioBindTitle { margin: 0 0 6px; font-size: 11px; color: #8f959e; }
.ddc-audioBindGrid { display: flex; flex-direction: column; gap: 6px; }
.ddc-audioBindSlot { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid #e5e6eb; border-radius: 8px; background: #fff; min-width: 0; transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease; }
.ddc-audioBindSlot.ddc-audioBindDrop { border-color: #3370ff; background: #f5f8ff; box-shadow: 0 0 0 3px rgba(51, 112, 255, 0.12); }
.ddc-audioBindLabel { flex: 0 0 auto; font-size: 11px; color: #4e5969; font-weight: 600; }
.ddc-audioBindChip { display: inline-flex; align-items: center; gap: 4px; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #3370ff; background: #eef4ff; border-radius: 6px; padding: 2px 6px; }
.ddc-audioBindClear { border: none; background: transparent; color: #86909c; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; border-radius: 4px; }
.ddc-audioBindClear:hover { color: #f53f3f; background: #ffece8; }
.ddc-audioBindField { position: relative; flex: 1 1 auto; min-width: 0; }
.ddc-audioBindInput { width: 100%; box-sizing: border-box; border: 1px solid transparent; background: #f7f8fa; border-radius: 6px; padding: 4px 6px; font-size: 12px; color: #1f2329; outline: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ddc-audioBindInput:focus { border-color: #3370ff; background: #fff; }
.ddc-audioBindMenu { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 20; background: #fff; border: 1px solid #e5e6eb; border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08); max-height: 160px; overflow-y: auto; padding: 4px; }
.ddc-audioBindOption { display: block; width: 100%; text-align: left; border: none; background: transparent; padding: 6px 8px; font-size: 12px; color: #1f2329; border-radius: 6px; cursor: pointer; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ddc-audioBindOption:hover { background: #f5f8ff; color: #3370ff; }
.ddc-audioBar { display: flex; align-items: center; gap: 8px; }
.ddc-audioTime { font-size: 11px; color: #86909c; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ddc-audioTrack { flex: 1 1 auto; height: 4px; border-radius: 2px; background: #e5e6eb; overflow: hidden; cursor: pointer; position: relative; }
.ddc-audioTrack:hover { background: #d9dce3; }
.ddc-audioTrackFill { height: 100%; border-radius: 2px; background: #3370ff; transition: width 300ms linear; }
.ddc-audioPlay { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 50%; border: none; background: #3370ff; color: #fff; font-size: 14px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: background 160ms ease, transform 120ms ease; }
.ddc-audioPlay:hover { background: #245bdb; }
.ddc-audioPlay:active { transform: scale(0.94); }
/* 音频加载失败：按钮短暂红色闪烁后恢复（中性提示，不持续占位） */
.ddc-audioPlayError { animation: ddcPlayErrorFlash 700ms ease; }
@keyframes ddcPlayErrorFlash { 0%, 100% { background: #3370ff; } 30%, 60% { background: #f53f3f; } }
.ddc-importText { width: 100%; box-sizing: border-box; min-height: 200px; padding: 10px; border: 1px solid #dfe1e5; border-radius: 8px; color: #1f2329; background: #fff; font: 12px/18px ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
.ddc-previewWrap { position: sticky; top: 12px; display: flex; flex-direction: column; gap: 10px; }
.ddc-importBox { border: 1px dashed #c9cdd4; border-radius: 12px; padding: 14px; background: #fafbfc; display: flex; flex-direction: column; gap: 10px; }
.ddc-importHint { margin: 0; color: #646a73; font-size: 12px; line-height: 18px; }
.ddc-importArea { width: 100%; box-sizing: border-box; font: 12px/18px ui-monospace, SFMono-Regular, Consolas, monospace; border: 1px solid #d0d3d9; border-radius: 8px; padding: 10px; color: #1f2329; background: #fff; resize: vertical; }
.ddc-importActions { display: flex; gap: 8px; flex-wrap: wrap; }
.ddc-fileLabel { cursor: pointer; }
.ddc-designer { display: grid; grid-template-columns: 190px minmax(0, 1fr) minmax(280px, .85fr); gap: 16px; align-items: start; }
.ddc-designerPanel { border: 1px solid #e5e6eb; border-radius: 12px; padding: 12px; background: #fafbfc; }
.ddc-designerTitle { font-size: 13px; font-weight: 700; margin: 0 0 10px; color: #1f2329; }
.ddc-paletteItem { border: 1px solid #e5e6eb; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; background: #fff; cursor: grab; display: flex; flex-direction: column; gap: 2px; }
.ddc-paletteItem:active { cursor: grabbing; }
.ddc-paletteItem span { font-size: 13px; color: #1f2329; }
.ddc-paletteItem small { color: #8f959e; font-size: 11px; line-height: 16px; }
.ddc-block { border: 1px solid #e5e6eb; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; background: #fff; cursor: pointer; }
.ddc-blockActive { border-color: #3370ff; box-shadow: 0 0 0 2px rgb(51 112 255 / 15%); }
.ddc-blockHead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.ddc-blockLabel { font-size: 12px; font-weight: 650; color: #1f2329; }
.ddc-blockDel { color: #f2323f; cursor: pointer; font-size: 12px; padding: 0 4px; }
.ddc-blockBody { color: #646a73; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
@media (max-width: 1100px) { .ddc-designer { grid-template-columns: 1fr; } }
.ddc-previewLabel { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.ddc-preview { border-radius: 16px; padding: 18px; background: #f5f6f7; border: 1px solid #e5e6eb; }
.ddc-previewCard { border-radius: 12px; background: #fff; overflow: hidden; box-shadow: 0 4px 16px rgb(31 35 41 / 8%); border: 1px solid #eef0f3; }
.ddc-previewAccent { height: 4px; }
.ddc-previewBody { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; color: #1f2329; }
.ddc-previewClose { align-self: flex-end; padding: 2px 10px; border: 1px solid #e5e6eb; border-radius: 6px; color: #8f959e; font-size: 11px; line-height: 18px; background: #fff; }
.ddc-previewTitleRow { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.ddc-previewTitle { margin: 0; font-size: 16px; line-height: 22px; font-weight: 700; overflow-wrap: anywhere; }
.ddc-previewTag { flex: none; padding: 2px 8px; border-radius: 999px; font-size: 10px; line-height: 16px; font-weight: 650; }
.ddc-previewSubtitle { margin: 0; color: #646a73; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.ddc-previewContent { margin: 0; color: #1f2329; font-size: 13px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ddc-previewFields { display: grid; gap: 5px; padding: 10px 12px; border-radius: 8px; background: #f7f8fa; }
.ddc-previewField { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px; font-size: 12px; line-height: 18px; }
.ddc-previewField span:first-child { color: #8f959e; }
.ddc-previewField span:last-child { color: #1f2329; overflow-wrap: anywhere; }
.ddc-previewImage { height: 104px; border-radius: 8px; display: grid; place-items: center; color: #8f959e; font-size: 11px; background: repeating-linear-gradient(45deg, #f2f3f5, #f2f3f5 8px, #eef0f3 8px, #eef0f3 16px); }
.ddc-previewState { margin: 0; color: #8f959e; font-size: 11px; line-height: 16px; }
.ddc-previewButtons { display: flex; flex-direction: column; gap: 8px; }
.ddc-previewButton { min-height: 32px; padding: 0 12px; border-radius: 7px; border: 1px solid #dfe1e5; color: #1f2329; background: #fff; font-size: 12px; display: inline-flex; align-items: center; width: 100%; box-sizing: border-box; text-align: left; }
.ddc-previewButton[data-style="fill"] { color: #fff; border-color: transparent; }
.ddc-previewInput { display: flex; gap: 8px; align-items: stretch; }
.ddc-previewInputBox { flex: 1; min-height: 32px; display: flex; align-items: center; padding: 0 10px; border: 1px solid #dfe1e5; border-radius: 7px; color: #8f959e; background: #fff; font-size: 12px; }
.ddc-previewSubmit { min-height: 32px; padding: 0 14px; border: 0; border-radius: 7px; background: #3370ff; color: #fff; font-size: 12px; display: inline-flex; align-items: center; }
.ddc-variableRow { display: flex; flex-wrap: wrap; gap: 6px; }
.ddc-variable { padding: 2px 7px; border-radius: 6px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); color: var(--dsw-alias-label-secondary, #646a73); font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; }
.ddc-editorHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.ddc-editorHead h2 { margin: 0; font-size: 18px; line-height: 24px; font-weight: 700; }
.ddc-editorHead p { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; }
`;

    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      const element = document.createElement('style');
      element.dataset.dshDingCard = 'styles';
      element.textContent = styles;
      document.head.appendChild(element);
      return () => element.remove();
    }

    async function rpcCall(ctx, method, payload = {}, signal) {
      const result = await ctx.connection.rpc.call('/api', RPC_CHANNEL, { method, payload }, signal);
      if (!result || typeof result.ok !== 'boolean') {
        throw new Error('无法访问 DSH 管理接口，请检查 DSH 连接后重试。');
      }
      if (!result.ok) {
        const error = new Error(result.error?.message ?? '操作失败，请稍后重试。');
        error.code = result.error?.code ?? 'operation-failed';
        throw error;
      }
      return result.value;
    }

    function timeText(value) {
      if (!value) return '';
      try {
        return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
      } catch {
        return value;
      }
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function typeMeta(type) {
      return TYPE_MAP[type] ?? TYPE_MAP.message;
    }

    function themeOf(theme) {
      return THEMES.find((item) => item.value === theme) ?? THEMES[0];
    }

    function newCard() {
      return {
        id: `card_${Math.random().toString(36).slice(2, 10)}`,
        name: '未命名卡片',
        type: 'message',
        description: '',
        templateId: '',
        aiCard: false,
        recycleOnDone: false,
        variables: clone(DEFAULT_VARIABLES),
        design: {
          title: '${title}',
          subtitle: '',
          content: '${content}',
          fields: [],
          options: [],
          image: '',
          state: '${state}',
          showButtons: true,
          allowCustom: true,
          showOptionValue: true,
          maxOptions: 4,
          theme: 'blue',
          buttonStyle: 'fill',
        },
      };
    }

    function sampleValues(card) {
      const values = {
        title: card.name || '卡片标题',
        subtitle: typeMeta(card.type).label,
        content: '卡片正文会显示在这里。你可以在左侧编辑标题、正文、字段和按钮。',
        state: '等待处理',
        image: '',
      };
      for (const field of card.design.fields ?? []) {
        const key = String(field.value ?? '').match(/\$\{([A-Za-z0-9_.-]+)\}/)?.[1];
        if (key) values[key] = '示例值';
      }
      return values;
    }

    function substitute(text, values) {
      return String(text ?? '').replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, key) => values[key] ?? '');
    }

    function Field({ label, hint, children, tag }) {
      return h('div', { className: 'ddc-field' },
        h('label', null, label, tag ? h('span', { className: 'ddc-varTag' }, tag) : null),
        children,
        hint ? h('p', { className: 'ddc-hint' }, hint) : null);
    }

    function TextInput({ value, onChange, placeholder, type = 'text' }) {
      return h('input', {
        type,
        value: value ?? '',
        placeholder,
        onChange: (event) => onChange(event.target.value),
      });
    }

    function Toggle({ checked, onChange, title, hint }) {
      return h('label', { className: 'ddc-switch' },
        h('input', { type: 'checkbox', checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }),
        h('span', null, title, hint ? h('small', null, hint) : null));
    }

    function StatusPill({ tone, children }) {
      return h('span', { className: 'ddc-pill', 'data-tone': tone },
        h('span', { className: 'ddc-dot' }), children);
    }

    function TypeBadge({ type }) {
      const meta = typeMeta(type);
      return h('span', { className: 'ddc-typeBadge', 'data-deliverable': String(meta.deliverable) },
        meta.label, meta.deliverable ? '' : ' · 仅导出');
    }

    function CardPreview({ card }) {
      const theme = themeOf(card.design.theme);
      const values = sampleValues(card);
      const title = substitute(card.design.title, values);
      const subtitle = substitute(card.design.subtitle, values);
      const content = substitute(card.design.content, values);
      const fields = (card.design.fields ?? []).map((field) => ({
        label: substitute(field.label, values),
        value: substitute(field.value, values),
      })).filter((field) => field.label || field.value);
      const state = substitute(card.design.state, values);
      const count = Math.max(1, Math.min(6, card.design.maxOptions || 4));
      const designOptions = Array.isArray(card.design.options) ? card.design.options : [];
      const options = Array.from({ length: card.design.showButtons ? count : 0 }, (_item, index) => {
        const item = designOptions[index] ?? {};
        const fallback = ['A', 'B', 'C', 'D', 'E', 'F'][index] ?? String(index + 1);
        const label = item.label || `选项 ${fallback}`;
        const value = item.value ?? label;
        const text = card.design.showOptionValue && value && value !== label ? `${label} — ${value}` : label;
        return { label, value, text };
      });
      return h('div', { className: 'ddc-preview' },
        h('div', { className: 'ddc-previewCard' },
          h('div', { className: 'ddc-previewAccent', style: { background: theme.color } }),
          h('div', { className: 'ddc-previewBody' },
            card.type === 'ceiling' ? h('div', { className: 'ddc-previewClose' }, '✕ 关闭') : null,
            h('div', { className: 'ddc-previewTitleRow' },
              h('h3', { className: 'ddc-previewTitle' }, title || '卡片标题'),
              subtitle ? h('span', {
                className: 'ddc-previewTag',
                style: { color: theme.color, background: theme.soft },
              }, subtitle) : null),
            content ? h('p', { className: 'ddc-previewContent' }, content) : null,
            fields.length ? h('div', { className: 'ddc-previewFields' },
              fields.map((field, index) => h('div', { className: 'ddc-previewField', key: index },
                h('span', null, field.label),
                h('span', null, field.value)))) : null,
            card.design.image ? h('div', { className: 'ddc-previewImage' }, '图片') : null,
            options.length ? h('div', { className: 'ddc-previewButtons' },
              options.map((option, index) => h('span', {
                key: index,
                className: 'ddc-previewButton',
                'data-style': index === 0 ? card.design.buttonStyle : 'outline',
                style: index === 0 && card.design.buttonStyle === 'fill' ? { background: theme.color } : {},
              }, option.label))) : null,
            // 自由输入框已从模板移除（钉钉本地变量不支持文本输入绑定），预览保持一致。
            card.design.allowCustom ? h('p', { className: 'ddc-previewState' }, '提示：不满意选项可直接在会话中回复文本') : null,
            state ? h('p', { className: 'ddc-previewState' }, state) : null)));
    }

    const DESIGN_COMPONENTS = [
      { key: 'title', label: '标题', hint: '主标题，支持 ${title} 占位符' },
      { key: 'subtitle', label: '副标题', hint: '右上角标签' },
      { key: 'content', label: '正文', hint: '支持占位符与换行' },
      { key: 'fields', label: '字段列表', hint: '键值对字段' },
      { key: 'image', label: '图片', hint: '展示图片（占位）' },
      { key: 'buttons', label: '按钮组', hint: '选项按钮' },
      { key: 'state', label: '底部状态', hint: '状态文本' },
    ];
    const DEFAULT_DESIGN_ORDER = ['title', 'subtitle', 'content', 'fields', 'image', 'buttons', 'state'];

    function DesignerLayout({ draft, update, updateDesign, updateField, updateOption }) {
      const [selected, setSelected] = React.useState('title');
      const order = Array.isArray(draft.design.order) && draft.design.order.length
        ? draft.design.order
        : DEFAULT_DESIGN_ORDER;
      const setOrder = (next) => updateDesign({ order: next });
      const moveItem = (from, to) => {
        const next = [...order];
        const [item] = next.splice(from, 1);
        next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
        setOrder(next);
      };
      const addComponent = (key) => {
        if (!order.includes(key)) setOrder([...order, key]);
        setSelected(key);
      };
      const removeComponent = (key) => {
        setOrder(order.filter((k) => k !== key));
        if (selected === key) setSelected(order.find((k) => k !== key) ?? 'title');
      };
      const blockSummary = (key) => {
        switch (key) {
          case 'title': return draft.design.title || '（空）';
          case 'subtitle': return draft.design.subtitle || '（未启用）';
          case 'content': return draft.design.content ? `正文：${draft.design.content.slice(0, 24)}` : '（未启用）';
          case 'fields': return (draft.design.fields ?? []).length ? `字段 ×${draft.design.fields.length}` : '（未添加字段）';
          case 'image': return draft.design.image ? '图片' : '（未启用）';
          case 'buttons': return draft.design.showButtons ? `按钮 ×${(draft.design.options ?? []).length || draft.design.maxOptions}` : '（关闭）';
          case 'state': return draft.design.state || '（空）';
          default: return '';
        }
      };
      const renderProps = (key) => {
        switch (key) {
          case 'title':
            return h(Field, { label: '标题', hint: '支持 ${title} 占位符' },
              h(TextInput, { value: draft.design.title, onChange: (title) => updateDesign({ title }) }));
          case 'subtitle':
            return h(Field, { label: '副标题 / 标签' },
              h(TextInput, { value: draft.design.subtitle, onChange: (subtitle) => updateDesign({ subtitle }) }));
          case 'content':
            return h(Field, { label: '正文', hint: '支持占位符与换行；Agent 发送时填充 ${content}。' },
              h('textarea', { value: draft.design.content, onChange: (event) => updateDesign({ content: event.target.value }) }));
          case 'fields':
            return h('div', null,
              h('div', { className: 'ddc-sectionHead' }, h('h2', null, '字段列表'),
                h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', onClick: () => updateDesign({ fields: [...(draft.design.fields ?? []), { label: '字段', value: '${value}' }] }) }, '添加字段')),
              (draft.design.fields ?? []).length === 0 ? h('p', { className: 'ddc-hint' }, '没有字段。') : null,
              (draft.design.fields ?? []).map((field, i) => h('div', { className: 'ddc-rowTight', key: i },
                h(Field, { label: '字段名' }, h(TextInput, { value: field.label, onChange: (l) => updateField(i, { label: l }) })),
                h(Field, { label: '字段值' }, h(TextInput, { value: field.value, onChange: (v) => updateField(i, { value: v }) })),
                h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-buttonDanger', onClick: () => updateDesign({ fields: (draft.design.fields ?? []).filter((_x, j) => j !== i) }) }, '删除'))));
          case 'image':
            return h(Field, { label: '图片 URL', hint: '可以写 ${image}，由 Agent 发送图片地址。' },
              h(TextInput, { type: 'url', value: draft.design.image, onChange: (image) => updateDesign({ image }) }));
          case 'buttons':
            return h('div', null,
              h(Toggle, { checked: draft.design.showButtons, onChange: (v) => updateDesign({ showButtons: v }), title: '显示选项按钮', hint: '提问/审批卡片需要按钮；普通通知可以关闭。' }),
              draft.design.showButtons ? h('div', { className: 'ddc-row' },
                h(Field, { label: '最多选项数' }, h('select', { value: String(draft.design.maxOptions), onChange: (event) => updateDesign({ maxOptions: Number(event.target.value) }) }, [1, 2, 3, 4, 5, 6].map((n) => h('option', { key: n, value: String(n) }, String(n))))),
                h(Field, { label: '回调参数名' }, h(TextInput, { value: draft.variables.optionParam, onChange: (optionParam) => update({ variables: { ...draft.variables, optionParam } }) }))) : null,
              draft.design.showButtons ? h('div', { className: 'ddc-sectionHead' }, h('h2', null, '预置选项'),
                h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', onClick: () => updateDesign({ options: [...(draft.design.options ?? []), { label: '选项', value: 'value' }] }) }, '添加选项')) : null,
              draft.design.showButtons ? (draft.design.options ?? []).map((opt, i) => h('div', { className: 'ddc-rowTight', key: i },
                h(Field, { label: '显示标签' }, h(TextInput, { value: opt.label, onChange: (l) => updateOption(i, { label: l }) })),
                h(Field, { label: '回传值' }, h(TextInput, { value: opt.value, onChange: (v) => updateOption(i, { value: v }) })),
                h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-buttonDanger', onClick: () => updateDesign({ options: (draft.design.options ?? []).filter((_x, j) => j !== i) }) }, '删除'))) : null);
          case 'state':
            return h(Field, { label: '底部状态' },
              h(TextInput, { value: draft.design.state, onChange: (state) => updateDesign({ state }) }));
          default: return null;
        }
      };
      const renderBlock = (key, index) => {
        const meta = DESIGN_COMPONENTS.find((c) => c.key === key);
        if (!meta) return null;
        return h('div', {
          key, className: selected === key ? 'ddc-block ddc-blockActive' : 'ddc-block',
          draggable: true,
          onDragStart: (event) => { event.dataTransfer.setData('text/plain', `idx:${index}`); },
          onDragOver: (event) => event.preventDefault(),
          onDrop: (event) => {
            event.preventDefault();
            const data = event.dataTransfer.getData('text/plain');
            if (data.startsWith('idx:')) moveItem(Number(data.slice(4)), index);
            else if (data) addComponent(data);
          },
          onClick: () => setSelected(key),
        },
          h('div', { className: 'ddc-blockHead' },
            h('span', { className: 'ddc-blockLabel' }, meta.label),
            h('span', { className: 'ddc-blockDel', role: 'button', onClick: (event) => { event.stopPropagation(); removeComponent(key); } }, '✕')),
          h('div', { className: 'ddc-blockBody' }, blockSummary(key)));
      };
      return h('div', { className: 'ddc-designer' },
        h('div', { className: 'ddc-designerPanel' },
          h('div', { className: 'ddc-designerTitle' }, '组件'),
          DESIGN_COMPONENTS.map((c) => h('div', { key: c.key, className: 'ddc-paletteItem', draggable: true,
            onDragStart: (event) => { event.dataTransfer.setData('text/plain', c.key); },
            onClick: () => addComponent(c.key) },
            h('span', null, c.label), h('small', null, c.hint))),
          h('p', { className: 'ddc-hint' }, '拖到画布或点击添加；画布中可拖拽排序、选中编辑、✕ 删除。')),
        h('div', { className: 'ddc-designerPanel', onDragOver: (event) => event.preventDefault(), onDrop: (event) => {
          const data = event.dataTransfer.getData('text/plain');
          if (data && !data.startsWith('idx:')) addComponent(data);
        } },
          h('div', { className: 'ddc-designerTitle' }, '画布'),
          order.map(renderBlock),
          order.length === 0 ? h('p', { className: 'ddc-hint' }, '从左侧拖入组件开始设计。') : null,
          h('div', { className: 'ddc-previewWrap' }, h('span', { className: 'ddc-previewLabel' }, '实时预览'), h(CardPreview, { card: draft }))),
        h('div', { className: 'ddc-designerPanel' },
          h('div', { className: 'ddc-designerTitle' }, '属性'),
          renderProps(selected) ?? h('p', { className: 'ddc-hint' }, '在画布选择一个组件，编辑它的属性。'),
          h('div', { className: 'ddc-variableRow' },
            ['title', 'subtitle', 'content', 'fields', 'image', 'state', 'option1', 'option2'].map((name) => (
              h('span', { className: 'ddc-variable', key: name }, '${' + name + '}'))))));
    }

    // 钉钉卡片变量类型（与钉钉卡片搭建器「变量类型」一一对应）。
    const DING_VAR_TYPE_META = Object.freeze([
      { id: 'string', label: '普通文本', hint: '字符串内容，如标题、链接、正文文本。' },
      { id: 'stringArray', label: '普通文本数组', hint: '由字符串组成的数组。' },
      { id: 'boolean', label: '布尔值', hint: '布尔值内容，true 或 false。' },
      { id: 'booleanArray', label: '布尔数组', hint: '由布尔值组成的数组。' },
      { id: 'number', label: '数字', hint: '数字内容。' },
      { id: 'numberArray', label: '数字数组', hint: '由数字组成的数组。' },
      { id: 'object', label: '对象', hint: '具有多个属性和对应值的结构体。' },
      { id: 'objectArray', label: '对象数组', hint: '由多个对象构成的数组，常用于循环渲染列表。' },
      { id: 'richText', label: '富文本', hint: 'Markdown 内容，支持彩色文本、加粗、斜体、链接、艾特人等。' },
      { id: 'chart', label: '图表', hint: '供「图表」组件使用的数据（图表变量协议）。' },
      { id: 'table', label: '表格', hint: '供「表格」组件使用的数据（表格变量协议）。' },
      { id: 'form', label: '表单', hint: '供「表单」组件使用的数据（表单变量协议）。' },
      { id: 'dynamicEvent', label: '动态事件', hint: '动态事件数据。' },
      { id: 'buttonGroup', label: '按钮组', hint: '一组按钮（文案与值）。' },
      { id: 'button', label: '按钮', hint: '单个交互按钮：按钮文案与点击回传内容，与发送测试的选项按钮双向绑定。' },
      { id: 'selectArray', label: '下拉选项数组', hint: '下拉选项列表（label 与 value）。' },
      { id: 'user', label: '用户信息', hint: '展示用户信息的数据（如 userId）。' },
      { id: 'userArray', label: '用户信息数组', hint: '多个用户信息构成的数组。' },
    ]);
    const DING_VAR_TYPE_LABEL = Object.fromEntries(DING_VAR_TYPE_META.map((t) => [t.id, t.label]));

    function CardEditor({ draft, onChange, onSave, onCancel, onUpdateJson, busy }) {
      const update = (patch) => onChange({ ...draft, ...patch });
      const fileRef = React.useRef(null);
      const prettyJson = (() => {
        const source = draft.sourceJson ?? '';
        if (!source) return '';
        try { return JSON.stringify(JSON.parse(source), null, 2); } catch { return source; }
      })();
      const head = h('div', { className: 'ddc-editorHead' },
        h('div', null,
          h('h2', null, draft.name || '未命名卡片'),
          h('p', null, '卡片模板在钉钉卡片设计器设计，发布后把模板 ID 填到这里；发送时 dsh 自动按模板变量填充。')),
        h('div', { className: 'ddc-actions' },
          h('button', { type: 'button', className: 'ddc-button', disabled: busy, onClick: onCancel }, '返回列表'),
          h('button', {
            type: 'button', className: 'ddc-button', disabled: busy,
            onClick: () => fileRef.current?.click(),
          }, '更新模板 JSON'),
          h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', disabled: busy, onClick: onSave }, '保存卡片'),
          h('input', {
            ref: fileRef, type: 'file', accept: '.json,application/json', style: { display: 'none' },
            onChange: (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => onUpdateJson(String(reader.result ?? ''), file.name.replace(/\.json$/i, '').trim());
              reader.readAsText(file);
              event.target.value = '';
            },
          })));
      return h('div', { className: 'ddc-form' },
        head,
        h('div', { className: 'ddc-editorLayout' },
          h('div', { className: 'ddc-form' },
            h('section', { className: 'ddc-section' },
              h('div', { className: 'ddc-sectionHead' }, h('h2', null, '基本信息')),
              h('div', { className: 'ddc-row' },
                h(Field, { label: '卡片名称' },
                  h(TextInput, { value: draft.name, onChange: (name) => update({ name }) })),
                h(Field, { label: '卡片类型', hint: typeMeta(draft.type).hint },
                  h('select', { value: draft.type, onChange: (event) => update({ type: event.target.value }) },
                    CARD_TYPES.map((type) => h('option', { key: type.value, value: type.value }, type.label))))),
              h(Field, { label: '说明', hint: '请说明卡片用途、有哪些参数、使用场景；Agent 会依据这份说明自动决策是否使用。' },
                h('textarea', {
                  value: draft.description,
                  onChange: (event) => update({ description: event.target.value }),
                  placeholder: '用途：…\n参数：title 标题 / content 正文 / options 选项…\n场景：如 请假审批、单选提问、信息展示…',
                })),
              h(Field, { label: '卡片模板 ID', hint: '在钉钉卡片平台发布模板后，把模板 ID 绑定到这里；留空时不能投放。' },
                h(TextInput, {
                  value: draft.templateId,
                  onChange: (templateId) => update({ templateId }),
                  placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.schema',
                })),
              h('div', { className: 'ddc-row' },
                h(Toggle, {
                  checked: draft.aiCard !== false,
                  onChange: (aiCard) => update({ aiCard }),
                  title: 'AI 卡片',
                  hint: '默认开启；模板收口与按钮回调依赖此模式。',
                }),
                h(Toggle, {
                  checked: draft.recycleOnDone === true,
                  onChange: (recycleOnDone) => update({ recycleOnDone }),
                  title: '回收卡片',
                  hint: '交互（点击/回复）后，卡片消息从会话中收回，像没出现过；交互信息仍用于对话生成。不勾选则卡片保留在会话。',
                })),
              h('div', { className: 'ddc-boundBox' },
                h('strong', null, '已绑定模板'),
                h('dl', { className: 'ddc-kv' },
                  h('dt', null, '模板 ID'),
                  h('dd', null, draft.templateId || '未绑定'),
                  h('dt', null, '交互'),
                  h('dd', null, `${draft.aiCard === false ? '普通' : 'AI'} 卡片 · ${draft.recycleOnDone === true ? '回收' : '不回收'}`))),
              h('p', { className: 'ddc-hint' }, '发送时 dsh 自动按模板变量填充；要改模板，在钉钉设计器改并发布后，可在这里「更新模板 JSON」或更新模板 ID。')),
            h('p', { className: 'ddc-hint' }, '模板变量与自定义变量请在「变量集」页统一查看与管理。')),
          h('div', { className: 'ddc-varsPane' },
            h('div', { className: 'ddc-sectionHead' },
              h('h2', null, '绑定 JSON 预览'),
              h('span', { className: 'ddc-varsCount' }, draft.sourceJson ? `约 ${Math.max(1, Math.round(draft.sourceJson.length / 1024))} KB` : '未绑定')),
            draft.sourceJson
              ? h('pre', { className: 'ddc-jsonPreview', style: { maxHeight: '70vh' } }, prettyJson)
              : h('p', { className: 'ddc-hint' }, '尚未绑定模板 JSON：导入模板或点击「更新模板 JSON」选择钉钉导出的模板 JSON 文件。'))));
    }

    function CardListItem({ card, busy, onEdit, onDelete, onDuplicate, onBind, onTest }) {
      const [templateId, setTemplateId] = React.useState(card.templateId ?? '');
      React.useEffect(() => { setTemplateId(card.templateId ?? ''); }, [card.templateId]);
      const dirty = templateId !== (card.templateId ?? '');
      const sourceJson = typeof card.sourceJson === 'string' && card.sourceJson.trim() ? card.sourceJson : '';
      const onDownloadSource = () => {
        if (!sourceJson) return;
        downloadJson(`${card.name}.json`, (() => {
          try { return JSON.parse(sourceJson); } catch { return sourceJson; }
        })());
      };
      return h('div', { className: 'ddc-cardItem' },
        h('div', { className: 'ddc-cardItemHead' },
          h('div', { className: 'ddc-cardItemTitle' },
            h('strong', null, card.name),
            h('span', null, `${card.design.maxOptions} 个按钮 · ${card.aiCard ? 'AI 卡片' : '普通卡片'}${card.design.allowCustom ? ' · 可自行输入' : ''}${card.recycleOnDone ? ' · 交互后回收' : ''}`)),
          h(TypeBadge, { type: card.type })),
        h('p', { className: 'ddc-cardItemDesc' }, card.description || '暂无说明'),
        h('div', { className: 'ddc-bindRow' },
          h('input', {
            value: templateId,
            placeholder: '绑定卡片模板 ID',
            onChange: (event) => setTemplateId(event.target.value),
          }),
          h('button', {
            type: 'button',
            className: `ddc-button ddc-buttonSmall${dirty ? ' ddc-buttonPrimary' : ''}`,
            disabled: busy || !dirty,
            onClick: () => onBind(card.id, templateId),
          }, dirty ? '保存 ID' : (card.templateId ? '已绑定' : '未绑定'))),
        h('div', { className: 'ddc-cardItemActions' },
          h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', disabled: busy || !sourceJson, onClick: onDownloadSource, title: sourceJson ? '下载绑定的模板 JSON 文件' : '该卡片未绑定模板 JSON' }, 'JSON'),
          h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', disabled: busy, onClick: () => onEdit(card) }, '编辑'),
          h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', disabled: busy || !card.templateId || !typeMeta(card.type).deliverable, onClick: () => onTest(card) }, '发送测试'),
          h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', disabled: busy, onClick: () => onDuplicate(card) }, '复制'),
          h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-buttonDanger', disabled: busy, onClick: () => onDelete(card) }, '删除')));
    }

    function chatLabel(chat) {
      if (chat.kind !== 'user') return `群 ${chat.openConversationId ?? ''}`;
      return chat.name ? `单聊 ${chat.name}` : `单聊 ${shortUserId(chat.userId)}`;
    }

    /** 没有昵称时把长 userId 缩短，完整 ID 放在 tooltip 与搜索文本里。 */
    function shortUserId(userId) {
      const id = String(userId ?? '');
      if (!id) return '未知会话';
      return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
    }

    /** 会话稳定键：勾选与查找用它，昵称晚到（ID -> 昵称）不会让已勾选丢失。 */
    function chatKey(chat) {
      return chat.kind === 'user' ? `u:${chat.userId ?? ''}` : `g:${chat.openConversationId ?? ''}`;
    }

    /** 搜索文本：昵称与完整 ID 都参与匹配（显示上 ID 是缩短的）。 */
    function chatSearchText(chat) {
      return chat.kind === 'user'
        ? ['单聊', chat.name ?? '', chat.userId ?? ''].join(' ')
        : ['群', chat.openConversationId ?? ''].join(' ');
    }

    /** 选项按钮整体单元在拖拽排序数组中的哨兵名（与变量名同层参与排序）。 */
    const OPTION_BLOCK_MARK = '__option_block__';

    function PickerModal({ picker, onSendSelected, onCancel, setPicker, onReload, onAutoReload, onDataChange, onVarMockSync, onVarOrderChange, onAudioBind, busy }) {
      const cancel = () => onCancel();
      const card = picker.card;
      const data = picker.data ?? {};
      // 左侧变量拖拽排序状态：顺序数组（变量名 + 哨兵 '__option_block__'）、拖拽中的行、容器与 FLIP 动画缓存。
      const [varOrder, setVarOrder] = React.useState(() => []);
      const [dragIdx, setDragIdx] = React.useState(null);
      const [overIdx, setOverIdx] = React.useState(null);
      const varListRef = React.useRef(null);
      const prevRects = React.useRef(null);
      const flipTimer = React.useRef(null);
      const prevCardId = React.useRef(null);
      // 变量集（可编辑）与会话模糊搜索。
      const [chatQuery, setChatQuery] = React.useState('');
      React.useEffect(() => () => { if (flipTimer.current) clearTimeout(flipTimer.current); }, []);
      // 弹窗打开期间自动刷新会话列表：昵称或新会话一旦到位就自动出现，
      // 不用手动点「刷新会话」。回调放 ref 里，避免父组件每次渲染重建定时器。
      const autoReloadRef = React.useRef(onAutoReload);
      React.useEffect(() => { autoReloadRef.current = onAutoReload; });
      React.useEffect(() => {
        const timer = setInterval(() => { autoReloadRef.current?.(); }, 10_000);
        return () => clearInterval(timer);
      }, []);
      const syncData = (next, vars) => {
        onDataChange?.(next, vars ?? customVars);
      };
      const updateData = (patch) => {
        const next = { ...data, ...patch };
        setPicker({ ...picker, data: next });
        syncData(next);
      };
      const updateVars = (name, next) => {
        const nextVars = { ...customVars, [name]: next };
        setPicker({ ...picker, customVars: nextVars });
        syncData(data, nextVars);
        // 双向同步：发送测试中修改的变量内容实时回写到变量库该变量的 Mock。
        onVarMockSync?.(name, next);
      };
      const maxOptions = card?.design?.maxOptions ?? 4;
      const customVars = picker.customVars ?? {};
      const optionVars = Array.isArray(card?.variables?.optionVars) ? card.variables.optionVars : [];
      const optionValueVars = Array.isArray(card?.variables?.optionValueVars) ? card.variables.optionValueVars : [];
      const textValueVars = Array.isArray(card?.design?.textValueVars) ? card.design.textValueVars : [];
      const previewJson = JSON.stringify({
        ...data,
        ...(Object.keys(customVars).length > 0 ? { variables: customVars } : {}),
      }, null, 2);
      const globalVars = picker.globalVars ?? [];
      const templateVars = picker.templateVars ?? [];
      const varInputFor = (v) => {
        const val = customVars[v.name];
        const set = (next) => updateVars(v.name, next);
        switch (v.type) {
          case 'number':
            return h('input', { type: 'number', value: typeof val === 'number' ? val : '', onChange: (event) => set(Number(event.target.value) || 0), style: { minWidth: 0 } });
          case 'boolean':
            return h('select', { value: val === false ? 'false' : 'true', onChange: (event) => set(event.target.value === 'true') },
              h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false'));
          case 'richText':
            return h('textarea', { value: typeof val === 'string' ? val : '', onChange: (event) => set(event.target.value), style: { minHeight: '64px' }, placeholder: 'Markdown 内容' });
          case 'user': case 'string':
            return h(TextInput, {
              value: typeof val === 'string' ? val : (val !== undefined ? JSON.stringify(val) : ''),
              onChange: set,
              placeholder: v.type === 'user' ? 'userId / unionId' : '',
            });
          case 'stringArray': case 'numberArray': case 'booleanArray': case 'userArray':
            return h(MockListEditor, { type: v.type, value: Array.isArray(val) ? val : [], onChange: set });
          case 'object':
            return h(MockKvEditor, { value: val && typeof val === 'object' && !Array.isArray(val) ? val : {}, onChange: set });
          case 'objectArray':
            return h(MockObjectArrayEditor, { value: Array.isArray(val) ? val : [{}], onChange: set });
          case 'buttonGroup':
            return h(MockPairsEditor, { fields: [{ key: 'text', label: '按钮文案' }, { key: 'value', label: '回传值' }], value: Array.isArray(val) ? val : [{ text: '', value: '' }], onChange: set });
          case 'selectArray':
            return h(MockPairsEditor, { fields: [{ key: 'label', label: '选项文案' }, { key: 'value', label: '选项值' }], value: Array.isArray(val) ? val : [{ label: '', value: '' }], onChange: set });
          default: // chart / table / form / dynamicEvent
            return h(JsonEditor, { value: val, onChange: set, onError: () => {} });
        }
      };
      const varTypeLabel = (v) => DING_VAR_TYPE_LABEL[v.type] ?? '普通文本';
      const varHint = (v) => (v.desc || v.note || (DING_VAR_TYPE_META.find((t) => t.id === v.type)?.hint ?? ''));
      // 模板变量配置 = 「模板 JSON 声明 ∩ 变量库（模板标准集 + 自定义变量集）定义」的交集：
      // JSON 有、变量库没有的变量不绑定不显示；变量库有、JSON 没有的也不作为该卡变量。
      // 左侧可编辑区与右侧模板变量配置均只展示这个交集。
      const cardVars = Array.isArray(card?.customVariables) ? card.customVariables : [];
      const definedNames = new Set([...templateVars, ...globalVars].map((v) => v.name));
      const nameRank = new Map();
      templateVars.forEach((v) => { if (!nameRank.has(v.name)) nameRank.set(v.name, 0); });
      globalVars.forEach((v) => { if (!nameRank.has(v.name)) nameRank.set(v.name, 1); });
      cardVars.forEach((v) => { if (!nameRank.has(v.name)) nameRank.set(v.name, 2); });
      const defByRank = (name) => {
        const rank = nameRank.get(name);
        if (rank === 0) return templateVars.find((v) => v.name === name);
        if (rank === 1) return globalVars.find((v) => v.name === name);
        if (rank === 2) return cardVars.find((v) => v.name === name);
        return null;
      };
      // 有效回传变量：优先取按钮变量在变量集的「绑定变量（bindVar，用户可配置）」，
      // 未配置时回退导入识别的 optionValueVars；保证模板变量改名后仍可手动重新绑定。
      const effOptionValueVars = optionVars.map((name, i) => {
        const def = defByRank(name);
        return (def?.bindVar && def.bindVar !== name) ? def.bindVar : ((optionValueVars[i] ?? ''));
      });
      // 模板 JSON 声明的变量名与示例值
      const tplDeclared = (() => {
        try {
          const raw = typeof card?.sourceJson === 'string' ? JSON.parse(card.sourceJson) : card?.sourceJson;
          const editor = raw?.editorData && typeof raw.editorData === 'string' ? JSON.parse(raw.editorData) : raw;
          const list = Array.isArray(editor?.variableList) ? editor.variableList : (Array.isArray(raw?.variableList) ? raw.variableList : []);
          return list
            .map((v) => ({
              name: typeof v?.name === 'string' ? v.name : (v?.varKey ?? ''),
              example: v?.exampleValue ?? v?.example ?? v?.defaultValue ?? v?.default ?? v?.value ?? '',
            }))
            .filter((v) => v.name);
        } catch { return null; }
      })();
      // 交集：JSON 声明 ∩ 变量库定义
      const libraryHits = tplDeclared && tplDeclared.length > 0
        ? tplDeclared.filter((d) => definedNames.has(d.name))
        : null;
      const varsList = libraryHits && libraryHits.length > 0
        ? libraryHits
          .map((d) => {
            const def = defByRank(d.name);
            if (!def) return null;
            const rank = nameRank.get(d.name);
            return { ...def, name: d.name, source: rank === 0 ? '模板' : rank === 1 ? '自定义' : '卡片绑定' };
          })
          .filter(Boolean)
          // 选项按钮变量（optionN 或成组模板的 btnsA/btnsAvalue 等）交给下方「选项按钮」区块输入，避免重复。
          .filter((v) => !(optionVars.includes(v.name) || optionValueVars.includes(v.name)))
        // 老卡片（无 sourceJson）：回退原白名单逻辑（组件绑定 ∩ 变量库定义）。
        : (() => {
          const builtinBound = Object.entries(card?.variables ?? {})
            .filter(([k, v]) => ['title', 'subtitle', 'content', 'fields', 'image', 'state'].includes(k) && v)
            .map(([k]) => k);
          const boundNames = new Set([...builtinBound, ...optionVars, ...cardVars.map((v) => v.name)]);
          return [
            ...templateVars.map((v) => ({ ...v, source: '模板' })),
            ...globalVars.map((v) => ({ ...v, source: '自定义' })),
            ...cardVars.map((v) => ({ ...v, source: '卡片绑定' })),
          ].filter((v) => boundNames.has(v.name) && definedNames.has(v.name))
            .filter((v) => v.name && nameRank.get(v.name) === (v.source === '模板' ? 0 : v.source === '自定义' ? 1 : 2))
            .filter((v) => !(optionVars.includes(v.name) || optionValueVars.includes(v.name)));
        })();
      // 拖拽排序：切换卡片时重置顺序（优先恢复该卡片持久化的 varOrder，否则按默认：变量 + 选项块最后）。
      React.useEffect(() => {
        prevCardId.current = card.id;
        const persisted = Array.isArray(card?.variables?.varOrder) ? card.variables.varOrder : null;
        const base = [...varsList.map((v) => v.name)];
        if (optionVars.length > 0) base.push(OPTION_BLOCK_MARK);
        if (persisted && persisted.length > 0) {
          const valid = persisted.filter((name) => base.includes(name));
          const rest = base.filter((name) => !valid.includes(name));
          setVarOrder([...valid, ...rest]);
        } else {
          setVarOrder(base);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [card.id]);
      const orderedVars = (() => {
        const rankMap = new Map(varOrder.map((name, index) => [name, index]));
        return [...varsList].sort((a, b) => {
          const ia = rankMap.has(a.name) ? rankMap.get(a.name) : Number.MAX_SAFE_INTEGER;
          const ib = rankMap.has(b.name) ? rankMap.get(b.name) : Number.MAX_SAFE_INTEGER;
          return ia - ib;
        });
      })();
      const reorderVar = (from, to) => {
        if (from === to || from < 0 || to < 0 || from >= varOrder.length || to >= varOrder.length) return;
        // 记录 FLIP 动画旧位置（DOM 尚未更新）
        prevRects.current = new Map();
        varListRef.current?.querySelectorAll('[data-var-name]').forEach((el) => {
          prevRects.current.set(el.getAttribute('data-var-name'), el.getBoundingClientRect().top);
        });
        const next = [...varOrder];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        setVarOrder(next);
        // 排序实时持久化：写回该卡片的 variables.varOrder，下次打开同一卡片恢复此顺序。
        onVarOrderChange?.(next);
      };
      // FLIP 过渡动画：位置变化的行平滑移动到新位置。
      React.useEffect(() => {
        if (!prevRects.current || prevRects.current.size === 0) return;
        const prev = prevRects.current;
        prevRects.current = null;
        varListRef.current?.querySelectorAll('[data-var-name]').forEach((el) => {
          const from = prev.get(el.getAttribute('data-var-name'));
          if (from == null) return;
          const dy = from - el.getBoundingClientRect().top;
          if (Math.abs(dy) < 0.5) return;
          el.style.transition = 'none';
          el.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            el.style.transition = 'transform 220ms cubic-bezier(0.2, 0.6, 0.2, 1)';
            el.style.transform = 'translateY(0)';
          }));
        });
        if (flipTimer.current) clearTimeout(flipTimer.current);
        flipTimer.current = setTimeout(() => {
          varListRef.current?.querySelectorAll('[data-var-name]').forEach((el) => {
            el.style.transition = '';
            el.style.transform = '';
          });
        }, 260);
      }, [varOrder]);
      const viewData = { ...data };
      for (const [key, value] of Object.entries(customVars)) {
        if (value !== '' && value !== null && value !== undefined) viewData[key] = value;
      }
      const previewFields = (() => {
        const raw = viewData.fields ?? '';
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
          } catch { /* 走行格式 */ }
          return raw.split('\n').filter(Boolean).map((line) => {
            const idx = line.indexOf('：') >= 0 ? line.indexOf('：') : line.indexOf(':');
            return idx > 0 ? { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() } : { label: line, value: '' };
          });
        }
        return [];
      })();
      // 选项按钮数据：统一为按钮组对象 {text, value}（兼容旧字符串数组），
      // 用按钮组编辑器编辑，发送时映射到模板 optionN 变量。
      const optionItems = optionVars.map((_name, i) => {
        const raw = (data.options ?? [])[i];
        if (raw && typeof raw === 'object') return { text: String(raw.text ?? raw.label ?? ''), value: String(raw.value ?? raw.text ?? raw.label ?? '') };
        return { text: String(raw ?? ''), value: String(raw ?? '') };
      });
      // 渲染顺序：varOrder 未就绪（首帧）时用默认顺序兜底，避免一帧空白。
      const renderOrder = (() => {
        if (varOrder.length > 0) return varOrder;
        const base = [...varsList.map((v) => v.name)];
        if (optionVars.length > 0) base.push(OPTION_BLOCK_MARK);
        return base;
      })();
      const rowByOrder = (name) => {
        if (name === OPTION_BLOCK_MARK) return optionVars.length > 0 ? { kind: 'option' } : null;
        const v = varsList.find((item) => item.name === name);
        return v ? { kind: 'var', v } : null;
      };
      const rowDragOver = (event, idx) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (overIdx !== idx) setOverIdx(idx);
      };
      const rowDragLeave = (event, idx) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOverIdx((cur) => (cur === idx ? null : cur));
      };
      const rowDrop = (event, idx) => {
        event.preventDefault();
        if (dragIdx !== null && dragIdx !== idx) reorderVar(dragIdx, idx);
        setDragIdx(null);
        setOverIdx(null);
      };
      const rowDragStart = (event, idx, name) => {
        setDragIdx(idx);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', name);
      };
      const testParams = h('div', { className: 'ddc-testParams' },
        h('div', { className: 'ddc-sectionHead' },
          h('h2', null, '变量集（可编辑）'),
          h('span', null, `${varsList.length} 个 · 按住拖拽可排序`)),
        varsList.length === 0
          ? h('p', { className: 'ddc-chatEmpty' }, '该卡片暂无可配置变量。')
          : h('div', { className: 'ddc-varDragList', ref: varListRef },
            renderOrder.map((name, idx) => {
              const row = rowByOrder(name);
              if (!row) return null;
              const rowCls = `ddc-varDragItem${dragIdx === idx ? ' ddc-varDragging' : ''}${overIdx === idx && dragIdx !== null && overIdx !== dragIdx ? ' ddc-varDropTarget' : ''}`;
              if (row.kind === 'option') {
                return h('div', {
                  key: OPTION_BLOCK_MARK,
                  className: rowCls,
                  'data-var-name': OPTION_BLOCK_MARK,
                  onDragOver: (event) => rowDragOver(event, idx),
                  onDragLeave: (event) => rowDragLeave(event, idx),
                  onDrop: (event) => rowDrop(event, idx),
                },
                  h('div', {
                    className: 'ddc-varDragHandle ddc-optionDragHandle',
                    'data-idx': idx,
                    draggable: true,
                    title: '拖拽排序',
                    onDragStart: (event) => rowDragStart(event, idx, OPTION_BLOCK_MARK),
                    onDragEnd: () => { setDragIdx(null); setOverIdx(null); },
                  }, '⋮⋮'),
                  h('div', { className: 'ddc-optionBlock' },
                    h('div', { className: 'ddc-sectionHead' },
                      h('h2', null, '选项按钮'),
                      h('span', null, `${optionVars.length} 个 · 绑定 ${optionVars.join('、')} · 固定来自模板 JSON` +
                        (textValueVars.length > 0 ? ' · 回传值显示在卡片文本控件中' : ''))),
                    h(MockPairsEditor, {
                      fields: [{ key: 'text', label: '按钮文案' }, { key: 'value', label: '回传值' }],
                      value: optionItems,
                      fixed: true,
                      // 选项行固定对应 optionN 变量：内容修改实时回写变量库 mock（双向绑定）。
                      // 成组模板（btnsA ↔ btnsAvalue）：文案回写按钮变量，回传内容回写回传变量。
                      onChange: (next) => {
                        updateData({ options: next });
                        next.forEach((rowItem, i) => {
                          if (!optionVars[i]) return;
                          const text = String(rowItem?.text ?? '');
                          const value = String(rowItem?.value ?? '');
                          // 只同步到「显式配置的绑定变量」（未配置绑定则不联动变量集 mock）；
                          // 发送写回传变量仍走 effOptionValueVars（识别回退），保证回调有值。
                          const def = defByRank(optionVars[i]);
                          const bound = def?.bindVar && def.bindVar !== optionVars[i] ? def.bindVar : '';
                          onVarMockSync?.(optionVars[i], { text, value });
                          if (bound) onVarMockSync?.(bound, value);
                        });
                      },
                    })));
              }
              const v = row.v;
              return h('div', {
                key: `${v.source}:${v.name}`,
                className: rowCls,
                'data-var-name': v.name,
                onDragOver: (event) => rowDragOver(event, idx),
                onDragLeave: (event) => rowDragLeave(event, idx),
                onDrop: (event) => rowDrop(event, idx),
              },
                h('div', {
                  className: 'ddc-varDragHandle',
                  'data-idx': idx,
                  draggable: true,
                  title: '拖拽排序',
                  onDragStart: (event) => rowDragStart(event, idx, v.name),
                  onDragEnd: () => { setDragIdx(null); setOverIdx(null); },
                }, '⋮⋮'),
                h(Field, { label: `\${${v.name}}`, tag: `${varTypeLabel(v)} · ${v.source}`, hint: varHint(v) },
                  varInputFor(v)));
            })));
      // 模板变量配置：只展示「模板 JSON 声明 ∩ 变量库定义」的交集变量，
      // 类型取变量库定义（与左侧可编辑控件一致），示例值取 JSON 声明。
      const tplVarItems = libraryHits && libraryHits.length > 0
        ? libraryHits
          .map((d) => {
            const def = defByRank(d.name);
            if (!def) return null;
            return { name: d.name, type: def.type, example: d.example };
          })
          .filter(Boolean)
        : null;
      const jsonBlock = h('div', { className: 'ddc-jsonBlock' },
        h('div', { className: 'ddc-sectionHead' },
          h('h2', null, '模板变量配置'),
          h('span', null, tplVarItems ? `${tplVarItems.length} 个 · 模板 JSON 与变量库交集` : '')),
        tplVarItems === null
          ? h('pre', { className: 'ddc-jsonPreview' }, previewJson)
          : tplVarItems.length === 0
            ? h('p', { className: 'ddc-chatEmpty' }, '暂无可配置变量。')
            : h('ul', { className: 'ddc-tplVars' },
              tplVarItems.map((v, i) => h('li', { className: 'ddc-tplVarRow', key: `${v.name}:${i}` },
                h('span', { className: 'ddc-varTag' }, `\${${v.name}}`),
                h('span', { className: 'ddc-tplVarType' }, DING_VAR_TYPE_LABEL[v.type] ?? '普通文本'),
                v.example !== '' && v.example != null
                  ? h('span', { className: 'ddc-tplVarExample' }, `示例：${typeof v.example === 'string' ? v.example : JSON.stringify(v.example)}`)
                  : null))));
      // 效果预览只渲染「模板变量配置（交集）」中存在的字段，与左侧生成的控件一一对应。
      const hitNames = new Set(varsList.map((v) => v.name));
      // 音频播放器（Music/AudioPlayer）组件：其 url/封面/标题/歌手变量不在普通文本区重复展示，
      // 统一渲染为音乐播放器预览卡片（值与左侧输入/变量库 mock 实时联动）。
      // design.audioPlayer 缺失（旧卡片）时从绑定的模板 JSON 兜底扫描。
      const audioPlayer = resolveAudioPlayer(card);
      // 音乐播放器四槽位手动绑定：初始取模板解析/存储的 audioPlayer；
      // 支持「拖拽左侧变量到槽位」或「输入变量名（带联想下拉）」两种方式绑定并实时持久化。
      const [audioBind, setAudioBind] = React.useState(() => ({
        url: audioPlayer?.url ?? '',
        coverUrl: audioPlayer?.coverUrl ?? '',
        title: audioPlayer?.title ?? '',
        artist: audioPlayer?.artist ?? '',
      }));
      const audioUrl = audioBind.url ? String(viewData[audioBind.url] ?? '') : '';
      const audioRef = React.useRef(null);
      const [playing, setPlaying] = React.useState(false);
      const [curTime, setCurTime] = React.useState(0);
      const [playError, setPlayError] = React.useState(false);
      const [coverFail, setCoverFail] = React.useState(false);
      const [audioDur, setAudioDur] = React.useState(0);
      // 槽位绑定交互状态：{field: {text, open}}（输入文本与联想下拉开关）、拖入高亮字段。
      const [bindUi, setBindUi] = React.useState({});
      const [bindDrop, setBindDrop] = React.useState(null);
      // 音频地址变化时重置播放状态（新音频从 0 开始），并清除上次的错误提示。
      React.useEffect(() => { setPlaying(false); setCurTime(0); setPlayError(false); setAudioDur(0); }, [audioUrl]);
      // 封面地址变化时清除失败标记，重新尝试加载。
      const audioCover = audioBind.coverUrl ? String(viewData[audioBind.coverUrl] ?? '') : '';
      React.useEffect(() => { setCoverFail(false); }, [audioCover]);
      const audioVarSet = new Set([audioBind.url, audioBind.coverUrl, audioBind.title, audioBind.artist].filter(Boolean));
      const audioPreview = (() => {
        if (!audioPlayer) return null;
        const url = audioUrl;
        const title = audioBind.title ? String(viewData[audioBind.title] ?? '') : '';
        const artist = audioBind.artist ? String(viewData[audioBind.artist] ?? '') : '';
        const cover = audioCover;
        const fmt = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
        const dur = Number.isFinite(audioDur) && audioDur > 0 ? audioDur : 0;
        const fill = dur > 0 ? Math.min(100, (curTime / dur) * 100) : 0;
        // 进度条点击 / 拖动跳转播放位置（与正常播放器一致）。
        const seekTo = (event) => {
          const audio = audioRef.current;
          if (!audio || !(audio.duration > 0) || !Number.isFinite(audio.duration)) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width) return;
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          audio.currentTime = ratio * audio.duration;
          setCurTime(audio.currentTime);
        };
        // 槽位绑定：只允许绑定「左侧已有变量」；拖入（数据已保证存在）或输入（校验存在）后实时持久化。
        const bindField = (field, name) => {
          const trimmed = String(name ?? '').trim();
          if (!trimmed || !varsList.some((v) => v.name === trimmed)) return;
          setAudioBind((cur) => {
            const next = { ...cur, [field]: trimmed };
            onAudioBind?.(card.id, next);
            return next;
          });
          setBindUi((cur) => ({ ...cur, [field]: { text: '', open: false } }));
        };
        const audioBindArea = h('div', { className: 'ddc-audioBind' },
          h('p', { className: 'ddc-audioBindTitle' }, '变量绑定：拖入左侧变量到槽位，或输入变量名（仅左侧已有变量）'),
          h('div', { className: 'ddc-audioBindGrid' },
            AUDIO_BIND_SLOTS.map((slot) => {
              const boundName = audioBind[slot.key] ?? '';
              const ui = bindUi[slot.key] ?? {};
              const kw = String(ui.text ?? '').trim().toLowerCase();
              const candidates = kw ? varsList.filter((v) => v.name.toLowerCase().includes(kw)) : varsList;
              return h('div', {
                key: slot.key,
                className: `ddc-audioBindSlot${bindDrop === slot.key ? ' ddc-audioBindDrop' : ''}`,
                onDragOver: (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'link'; setBindDrop(slot.key); },
                onDragLeave: () => setBindDrop((cur) => (cur === slot.key ? null : cur)),
                onDrop: (event) => {
                  event.preventDefault();
                  setBindDrop(null);
                  const name = event.dataTransfer.getData('text/plain');
                  if (name) bindField(slot.key, name);
                },
              },
                h('span', { className: 'ddc-audioBindLabel' }, slot.label),
                boundName
                  ? h('span', { className: 'ddc-audioBindChip', title: '点击 × 解除绑定' },
                    `\${${boundName}}`,
                    h('button', {
                      type: 'button', className: 'ddc-audioBindClear', title: '解除绑定',
                      onClick: () => setAudioBind((cur) => {
                        const next = { ...cur, [slot.key]: '' };
                        onAudioBind?.(card.id, next);
                        return next;
                      }),
                    }, '×'))
                  : null,
                h('div', { className: 'ddc-audioBindField' },
                  h('input', {
                    className: 'ddc-audioBindInput',
                    value: ui.text ?? '',
                    placeholder: boundName ? '拖入或输入新变量名…' : '拖入变量或输入变量名…',
                    onFocus: () => setBindUi((cur) => ({ ...cur, [slot.key]: { text: cur[slot.key]?.text ?? '', open: true } })),
                    onChange: (event) => {
                      const text = event.target.value;
                      setBindUi((cur) => ({ ...cur, [slot.key]: { text, open: true } }));
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') { bindField(slot.key, ui.text ?? ''); event.preventDefault(); }
                      if (event.key === 'Escape') setBindUi((cur) => ({ ...cur, [slot.key]: { text: cur[slot.key]?.text ?? '', open: false } }));
                    },
                  }),
                  ui.open && candidates.length > 0
                    ? h('div', { className: 'ddc-audioBindMenu' },
                      candidates.slice(0, 8).map((v) => h('button', {
                        key: v.name, type: 'button', className: 'ddc-audioBindOption',
                        onClick: () => bindField(slot.key, v.name),
                      }, `\${${v.name}}`)))
                    : null))
                })));
        return h('div', { className: 'ddc-audioPreview' },
          h('audio', {
            ref: audioRef,            src: url || undefined,
            preload: 'auto',
            style: { display: 'none' },
            onTimeUpdate: (event) => {
              const t = Number(event.currentTarget.currentTime) || 0;
              if (Math.abs(t - curTime) > 0.5) setCurTime(t);
            },
            onPlay: () => { setPlaying(true); setPlayError(false); },
            onPause: () => setPlaying(false),
            onEnded: () => { setPlaying(false); setCurTime(0); },
            onError: () => { setPlaying(false); setPlayError(true); },
            onLoadedMetadata: (event) => {
              const d = Number(event.currentTarget.duration);
              if (d > 0 && Number.isFinite(d)) setAudioDur(d);
            },
            onDurationChange: (event) => {
              const d = Number(event.currentTarget.duration);
              if (d > 0 && Number.isFinite(d)) setAudioDur(d);
            },
          }),
          h('div', { className: 'ddc-audioMain' },
            cover && !coverFail
              ? h('img', { className: 'ddc-audioCover', src: cover, alt: '', onError: () => setCoverFail(true) })
              : h('div', { className: 'ddc-audioCover ddc-audioCoverEmpty' }, '♪'),
            h('div', { className: 'ddc-audioInfo' },
              h('p', { className: 'ddc-audioTitle' }, title || '音乐'),
              h('p', { className: 'ddc-audioArtist' }, artist || '未知歌手'),
              audioBind.url && !hitNames.has(audioBind.url)
                ? h('p', { className: 'ddc-audioMissing' }, `音频变量 \${${audioBind.url}} 已不存在（可能被改名/删除）：请在变量集检查，改名后绑定会自动跟随；删除后可重新导入模板。`)
                : null,
              h('div', { className: 'ddc-audioBar' },
                h('span', { className: 'ddc-audioTime' }, fmt(curTime)),
                h('div', { className: 'ddc-audioTrack', onClick: seekTo, title: '点击跳转播放进度' },
                  h('div', { className: 'ddc-audioTrackFill', style: { width: `${fill}%` } })),
                h('span', { className: 'ddc-audioTime' }, dur > 0 ? fmt(dur) : '--:--'))),
            h('button', {
              type: 'button',
              className: `ddc-audioPlay${playError ? ' ddc-audioPlayError' : ''}`,
              title: url ? (playError ? '浏览器无法直连该音频（钉钉客户端内可正常播放）' : (playing ? '暂停' : '播放')) : '未配置音频',
              onClick: () => {
                if (!url) return;
                const audio = audioRef.current;
                if (!audio) return;
                if (playing) {
                  audio.pause();
                  setPlaying(false);
                } else {
                  // 乐观置为播放中，加载失败时由 onError / Promise reject 复位。
                  setPlaying(true);
                  setPlayError(false);
                  const promise = audio.play();
                  if (promise && typeof promise.then === 'function') {
                    void promise.catch(() => { setPlaying(false); setPlayError(true); });
                  } else {
                    setPlaying(false);
                  }
                }
              },
            }, playing ? '⏸' : '▶')),
          audioBindArea);
      })();
      // 效果预览按拖拽排序后的变量顺序渲染对应字段块，与左侧一致。
      const previewBlock = (v) => {
        // 音频播放器绑定的变量由播放器卡片整体展示，不在文本区重复渲染。
        if (audioVarSet.has(v.name)) return null;
        if (v.name === 'state') return hitNames.has('state') && viewData.state ? h('span', { className: 'ddc-cardPreviewState' }, viewData.state) : null;
        if (v.name === 'title') return hitNames.has('title') && viewData.title ? h('p', { className: 'ddc-cardPreviewTitle' }, viewData.title) : null;
        if (v.name === 'subtitle') return hitNames.has('subtitle') && viewData.subtitle ? h('p', { className: 'ddc-cardPreviewSub' }, viewData.subtitle) : null;
        if (v.name === 'content') return hitNames.has('content') && viewData.content ? h('p', { className: 'ddc-cardPreviewBody' }, viewData.content) : null;
        if (v.name === 'fields') return hitNames.has('fields') && previewFields.length > 0
          ? h('ul', { className: 'ddc-cardPreviewFields' },
            previewFields.map((f, i) => h('li', { key: i }, `${f.label ?? ''}${f.value ? `：${f.value}` : ''}`)))
          : null;
        return null;
      };
      // 效果预览按左侧拖拽顺序渲染：变量字段块与选项按钮区位置与左侧一致（含选项块整体排序）。
      const previewOptsBlock = (data.options ?? []).filter((o) => String(o?.text ?? o ?? '').trim()).length > 0
        ? h('div', { className: 'ddc-cardPreviewOpts' },
          (data.options ?? []).filter((o) => String(o?.text ?? o ?? '').trim())
            .map((opt, i) => h('span', { key: i, className: 'ddc-cardPreviewOpt' }, String(opt?.text ?? opt ?? ''))))
        : null;
      const cardPreview = h('div', { className: 'ddc-cardPreview' },
        ...renderOrder.map((name) => {
          if (name === OPTION_BLOCK_MARK) return previewOptsBlock;
          const v = varsList.find((item) => item.name === name);
          return v ? previewBlock(v) : null;
        }).filter(Boolean),
        audioPreview);
      // 会话模糊搜索：昵称与完整 userId 都参与匹配，全选只作用于过滤后可见的会话。
      const chatKw = String(chatQuery ?? '').trim().toLowerCase();
      const visibleChats = chatKw
        ? picker.chats.filter((chat) => chatSearchText(chat).toLowerCase().includes(chatKw))
        : picker.chats;
      const chatArea = picker.loading
        ? h('div', { className: 'ddc-chatArea ddc-chatEmpty' }, '正在获取会话列表…')
        : picker.chats.length === 0
          ? h('div', { className: `ddc-chatArea ddc-chatEmpty${picker.error ? ' ddc-chatError' : ''}` },
            picker.error
              ? h('p', { className: 'ddc-chatErrorStrong' }, picker.error)
              : h('p', null, '还没有可用会话：先在钉钉里给机器人发一条消息，应答后这里会自动出现该会话。'))
          : h('div', { className: 'ddc-chatArea' },
            h('div', { className: 'ddc-sectionHead ddc-chatHead' },
              h('h2', null, '选择会话'),
              h('div', { className: 'ddc-chatTools' },
                h('input', {
                  className: 'ddc-search ddc-chatSearch',
                  placeholder: '搜索会话…',
                  value: chatQuery,
                  onChange: (event) => setChatQuery(event.target.value),
                }),
                h('span', { className: 'ddc-badgeWrap' },
                  h('button', {
                    type: 'button', className: 'ddc-button ddc-buttonSmall',
                    onClick: () => {
                      const allKeys = visibleChats.map((chat) => chatKey(chat));
                      const allSelected = allKeys.length > 0 && allKeys.every((key) => picker.selected.has(key));
                      setPicker({ ...picker, selected: allSelected ? new Set() : new Set(allKeys) });
                    },
                  }, visibleChats.length > 0 && visibleChats.every((chat) => picker.selected.has(chatKey(chat))) ? '取消全选' : '全选'),
                  picker.selected.size > 0
                    ? h('span', { className: 'ddc-chatBadge', title: `已选 ${picker.selected.size} 个会话` },
                      picker.selected.size > 99 ? '99+' : String(picker.selected.size))
                    : null),
                h('span', { className: 'ddc-chatAutoHint', title: '打开这个弹窗期间每 10 秒自动刷新一次会话列表；新会话、新昵称会自动出现，也可以随时手动刷新' }, '自动刷新'),
                h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', disabled: picker.loading, onClick: onReload }, '刷新会话'))),
            visibleChats.length === 0
              ? h('div', { className: 'ddc-chatArea ddc-chatEmpty' }, `没有匹配「${chatQuery.trim()}」的会话。`)
              : h('div', { className: 'ddc-pickerList' },
                visibleChats.map((chat) => {
                  const key = chatKey(chat);
                  const checked = picker.selected.has(key);
                  const fullTitle = chat.kind === 'user' && !chat.name && chat.userId
                    ? `完整 userId：${chat.userId}（该会话还没上报过昵称，收到它的一条消息后会自动换成昵称）`
                    : chatLabel(chat);
                  return h('label', { key, className: 'ddc-pickerRow', title: fullTitle },
                    h('input', {
                      type: 'checkbox', checked,
                      onChange: (event) => {
                        const next = new Set(picker.selected);
                        if (event.target.checked) next.add(key); else next.delete(key);
                        setPicker({ ...picker, selected: next });
                      },
                    }),
                    h('span', null, chatLabel(chat)));
                })));
      return h('div', { className: 'ddc-overlay', onClick: onCancel },
        h('div', { className: `ddc-modal${picker.type === 'test' ? ' ddc-modalWideL' : ''}`, onClick: (event) => event.stopPropagation() },
          h('div', { className: 'ddc-modalHead ddc-modalHeadRow' },
            h('h3', null, `选择会话发送「${card?.name ?? '卡片'}」`),
            h('span', { className: 'ddc-hint' }, '可多选会话，勾选后点「发送」批量发送。'),
            h('span', { className: 'ddc-headSpacer' }),
            // 模板变量配置：不占主区域，移到顶部消息图标上，hover 浮动展示全部内容
            // （纯 CSS 触发：鼠标从图标移进面板不消失，支持面板内滚动）。
            h('div', { className: 'ddc-msgIconWrap' },
              h('span', { className: 'ddc-msgIcon', title: '模板变量配置' },
                h('svg', { width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
                  h('path', {
                    d: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 6.2c.44 0 .8.36.8.8v2.6a.8.8 0 0 1-1.6 0V8c0-.44.36-.8.8-.8Zm0-2.9a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z',
                    fill: 'currentColor',
                  }))),
              h('div', { className: 'ddc-msgPopover' }, jsonBlock))),
          h('div', { className: 'ddc-pickerBody' },
            h('div', { className: 'ddc-split' },
              h('div', { className: 'ddc-leftPane' }, testParams),
              h('div', { className: 'ddc-rightPane' },
                h('div', { className: 'ddc-paneBlock' },
                  h('div', { className: 'ddc-sectionHead' }, h('h2', null, '效果预览')),
                  cardPreview),
                h('div', { className: 'ddc-paneBlock' }, chatArea)))),
          h('div', { className: 'ddc-modalFoot' },
            h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', disabled: picker.loading || picker.selected.size === 0, onClick: () => onSendSelected() }, `发送（${picker.selected.size}）`),
            h('button', { type: 'button', className: 'ddc-button', onClick: cancel }, '取消'))));
    }

    function ImportModal({ onCancel, onImport, busy }) {
      const [text, setText] = React.useState('');
      const [fileName, setFileName] = React.useState('');
      const readFile = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setFileName(file.name.replace(/\.json$/i, '').trim());
        const reader = new FileReader();
        reader.onload = () => setText(String(reader.result ?? ''));
        reader.readAsText(file);
      };
      return h('div', { className: 'ddc-overlay', onClick: onCancel },
        h('div', { className: 'ddc-modal ddc-modalWide', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'ddc-pickerBody' },
            h('h3', null, '导入钉钉模板 JSON'),
            h('p', { className: 'ddc-hint' }, '在钉钉卡片设计器导出模板 JSON，粘贴到这里或选择文件；导入后自动生成可编辑卡片并打开编辑器。'),
            h('div', { className: 'ddc-field' },
              h('label', null, '模板 JSON'),
              h('textarea', {
                className: 'ddc-importText',
                value: text,
                onChange: (event) => setText(event.target.value),
                placeholder: '{"schema":{"componentsTree":[...]},"variableList":[...]}',
              })),
            h('div', { className: 'ddc-actions' },
              h('label', { className: 'ddc-button', style: { cursor: 'pointer' } },
                fileName || '选择 JSON 文件',
                h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: readFile })),
              h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', disabled: busy || !text.trim(), onClick: () => onImport(text, fileName) }, '导入并生成卡片'),
              h('button', { type: 'button', className: 'ddc-button', onClick: onCancel }, '取消')))));
    }

    function CardsTab({ config, busy, onEdit, onDelete, onDuplicate, onBind, onTest, onImport }) {
      const [query, setQuery] = React.useState('');
      // 卡片类型多选筛选：勾选哪些类型就只展示哪些，不勾选 = 全部。
      const [typeFilter, setTypeFilter] = React.useState([]);
      const [typeOpen, setTypeOpen] = React.useState(false);
      if (!config) return h('div', { className: 'ddc-empty' }, '正在读取配置…');
      const cards = config.cards ?? [];
      const kw = query.trim().toLowerCase();
      const typeMatched = (card) => typeFilter.length === 0 || typeFilter.includes(card.type);
      const shown = (kw
        ? cards.filter((card) => (card.name ?? '').toLowerCase().includes(kw)
          || (card.description ?? '').toLowerCase().includes(kw)
          || (card.type ?? '').toLowerCase().includes(kw))
        : cards).filter(typeMatched);
      const toggleType = (value) => {
        setTypeFilter((cur) => (cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]));
      };
      return h('div', { className: 'ddc-form' },
        h('div', { className: 'ddc-tabSticky' },
          h('div', { className: 'ddc-actions', style: { justifyContent: 'space-between', flexWrap: 'nowrap' } },
            h('strong', { style: { fontSize: '14px', whiteSpace: 'nowrap' } }, `卡片库（${shown.length}/${cards.length}）`),
            h('div', { className: 'ddc-actions', style: { flexWrap: 'nowrap' } },
              h('div', { className: 'ddc-typeFilter', onMouseLeave: () => setTypeOpen(false) },
                h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-typeFilterBtn', onClick: () => setTypeOpen((open) => !open) },
                  h('span', null, typeFilter.length === 0 ? '全部类型' : `已选 ${typeFilter.length} 种`),
                  h('span', { className: 'ddc-caret' }, '▾')),
                typeOpen
                  ? h('div', { className: 'ddc-typeMenu' },
                    CARD_TYPES.map((type) => h('label', { key: type.value, className: 'ddc-typeOption' },
                      h('input', {
                        type: 'checkbox',
                        checked: typeFilter.includes(type.value),
                        onChange: () => toggleType(type.value),
                      }),
                      h('span', null, type.label),
                      h('span', { className: 'ddc-typeOptionHint' }, type.deliverable ? '可发送' : '仅导出'))))
                  : null),
              h('input', { className: 'ddc-search', placeholder: '搜索卡片名称 / 描述…', value: query, onChange: (event) => setQuery(event.target.value) }),
              h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', disabled: busy, onClick: onImport }, '导入模板 JSON')))),
        shown.length === 0
          ? h('div', { className: 'ddc-empty' },
            cards.length === 0 ? '还没有卡片。点击「导入模板 JSON」导入钉钉卡片模板即可自动生成卡片。' : `没有匹配${typeFilter.length > 0 ? '所选类型' : ''}「${query.trim()}」的卡片。`)
          : h('div', { className: 'ddc-cardList' },
            shown.map((card) => h(CardListItem, {
              key: card.id,
              card,
              busy,
              onEdit,
              onDelete,
              onDuplicate,
              onBind,
              onTest,
            }))));
    }

    function Overview({ status, busy, onRefresh, onCheckBot, onInstall, onOpenCards }) {
      const dshim = status?.dshim;
      const stream = status?.stream;
      const streamTone = !stream?.patched ? 'warning' : (stream.clients?.some((client) => client.connected) ? 'success' : 'warning');
      const cards = status?.config?.cards ?? [];
      const bound = cards.filter((card) => card.templateId).length;
      return h('div', { className: 'ddc-grid' },
        h('section', { className: 'ddc-card' },
          h('h2', null, dshim?.profile ? `dsh-im 集成（${dshim.profile} 环境）` : 'dsh-im 集成'),
          dshim?.installed
            ? h(StatusPill, { tone: 'success' }, `已安装 v${dshim.version ?? '?'}`)
            : h(StatusPill, { tone: 'warning' }, '未安装'),
          h('dl', { className: 'ddc-kv' },
            h('dt', null, '配置引用'),
            h('dd', null, dshim?.declared ? '已声明' : '未声明'),
            h('dt', null, '订阅状态'),
            h('dd', null, dshim?.selected ? '已启用' : '未启用')),
          dshim?.installed
            ? h('p', null, '卡片复用 dsh-im 已配置的钉钉机器人，不会新建连接。')
            : h(React.Fragment, null,
              h('p', null, `当前环境（${dshim?.profile ?? '未知'} profile）未安装 dsh-im，卡片无法投递；网页端与桌面端各自安装、互不借用。`),
              h('code', { className: 'ddc-code' }, dshim?.installCommand ?? 'dsh plugin add @xmanrui/dsh-im')),
          h('div', { className: 'ddc-actions' },
            h('button', { type: 'button', className: 'ddc-button', disabled: busy, onClick: onRefresh }, '刷新状态'),
            !dshim?.installed
              ? h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', disabled: busy, onClick: onInstall }, '安装 dsh-im')
              : null)),
        h('section', { className: 'ddc-card' },
          h('h2', null, '钉钉机器人'),
          h(StatusPill, { tone: status?.bot?.secretReady ? 'success' : 'warning' },
            status?.bot ? (status.bot.secretReady ? '凭据就绪' : '缺少密钥') : '未绑定'),
          h('dl', { className: 'ddc-kv' },
            h('dt', null, 'Client ID'),
            h('dd', null, status?.bot?.clientId ?? '—'),
            h('dt', null, '来源'),
            h('dd', null, status?.bot?.source === 'manual' ? '手动配置' : 'dsh-im'),
            h('dt', null, '会话路由'),
            h('dd', null, `${status?.routes ?? 0} 条`)),
          h('div', { className: 'ddc-actions' },
            h('button', { type: 'button', className: 'ddc-button', disabled: busy, onClick: onCheckBot }, '校验凭据'))),
        h('section', { className: 'ddc-card' },
          h('h2', null, '卡片回调通道'),
          h(StatusPill, { tone: streamTone },
            !stream?.patched
              ? (stream?.autoRetry ? '未挂接（自动重试中）' : '未挂接')
              : stream.clients?.some((client) => client.connected) ? '已连接' : '已挂接（等首条回调）'),
          h('p', null, '复用 dsh-im 的 Stream 连接接收按钮点击；同一个机器人只能有一条 Stream 连接。回调钩子直接挂在钉钉 SDK 的分发点上，dsh-im 的连接先建好也不影响。'),
          stream?.error ? h('p', null, stream.error.message) : null,
          stream?.clients?.length
            ? h('p', null, `已观察到 dsh-im 的卡片回调监听，当前在线 ${stream.clients.length} 条连接。`)
            : h('p', null, stream?.patched
              ? '钩子已就位，收到下一条钉钉回调即生效（发一张测试卡片点按钮即可验证），不需要重启 DSH。'
              : '还没有观察到 dsh-im 的 Stream 连接；装好 dsh-im 后会自动重试挂接，不需要重启 DSH。')),
        h('section', { className: 'ddc-card' },
          h('h2', null, '卡片库'),
          h('dl', { className: 'ddc-kv' },
            h('dt', null, '卡片总数'),
            h('dd', null, cards.length),
            h('dt', null, '已绑定模板'),
            h('dd', null, bound),
            h('dt', null, '待处理'),
            h('dd', null, status?.cards?.pending ?? 0),
            h('dt', null, '已发送/作答'),
            h('dd', null, `${status?.cards?.counters?.sent ?? 0} / ${status?.cards?.counters?.answered ?? 0}`)),
          h('div', { className: 'ddc-actions' },
            h('button', { type: 'button', className: 'ddc-button', disabled: busy, onClick: onOpenCards }, '管理卡片'))));
    }

    function InteractionTab({ config, cards, onChange, busy }) {
      if (!config) return h('div', { className: 'ddc-empty' }, '正在读取配置…');
      const interactions = config.interactions ?? {};
      const set = (patch) => onChange({ interactions: { ...interactions, ...patch } });
      return h('div', { className: 'ddc-form' },
        h('section', { className: 'ddc-section' },
          h('div', { className: 'ddc-sectionHead' }, h('h2', null, '接管范围')),
          h(Toggle, { checked: config.enabled, onChange: (enabled) => onChange({ enabled }), title: '启用钉卡片', hint: '关闭后所有交互回到 DSH 原有界面。' }),
          h(Toggle, { checked: interactions.questions, onChange: (questions) => set({ questions }), title: '提问卡片', hint: '把带选项的 ask_user_question 变成钉钉卡片。' }),
          h(Toggle, { checked: interactions.approvals, onChange: (approvals) => set({ approvals }), title: '审批卡片', hint: '把需要确认的工具调用变成允许 / 拒绝按钮。' }),
          h(Toggle, { checked: interactions.allowGroup, onChange: (allowGroup) => set({ allowGroup }), title: '群聊中启用', hint: '关闭后只处理单聊机器人的会话。' })),
        h('section', { className: 'ddc-section' },
          h('div', { className: 'ddc-sectionHead' }, h('h2', null, '自动使用的卡片')),
          h('div', { className: 'ddc-notice' },
            '系统与 Agent 会根据卡片的用途、参数与使用场景自动选择最合适的卡片，无需固定绑定某一张。同一类型可配置多张不同模板设计的卡片，发送时由 Agent 依据卡片库里的卡片说明决策。'),
          h('div', { className: 'ddc-notice' },
            '按钮垂直排列、选项回传值和自行输入都由卡片模板决定；在卡片库里改完设计后，请重新导出 JSON、在钉钉发布，并绑定新的模板 ID。'),
          h(Toggle, { checked: interactions.ceiling, onChange: (ceiling) => set({ ceiling }), title: '启用吊顶卡片', hint: '单聊会话把待处理卡片固定在顶部。' })),
        h('section', { className: 'ddc-section' },
          h('div', { className: 'ddc-sectionHead' }, h('h2', null, '等待与回退')),
          h(Field, { label: '卡片等待时长（秒）', hint: '超时后卡片标记结束，问题仍可在 Web 或聊天里回答。' },
            h('input', {
              type: 'number', min: 30, max: 86400, value: Math.round((interactions.timeoutMs ?? 600000) / 1000),
              onChange: (event) => set({ timeoutMs: Math.max(30, Number(event.target.value) || 600) * 1000 }),
            })),
          h('div', { className: 'ddc-notice' },
            '钉钉原生一次只允许一条 Stream 连接，因此插件复用 dsh-im 的连接；dsh-im 仍会发送一条带编号选项的文本消息作为兜底。卡片与文本先答者生效。')),
        h('div', { className: 'ddc-saveHint' }, '所有设置修改后自动保存，无需手动点击。'));
    }

    function LogsTab({ status, onRefresh, onClear, busy }) {
      const entries = status?.events ?? [];
      return h('div', { className: 'ddc-form' },
        h('div', { className: 'ddc-actions' },
          h('button', { type: 'button', className: 'ddc-button', disabled: busy, onClick: onRefresh }, '刷新'),
          h('button', { type: 'button', className: 'ddc-button ddc-buttonDanger', disabled: busy, onClick: onClear }, '清空')),
        entries.length === 0
          ? h('div', { className: 'ddc-empty' }, '还没有日志。')
          : h('div', { className: 'ddc-logs' },
            entries.map((entry) => h('div', { className: 'ddc-log', key: entry.id },
              h('time', null, timeText(entry.at)),
              h('em', { 'data-level': entry.level }, entry.level === 'error' ? '错误' : entry.level === 'warn' ? '警告' : '信息'),
              h('span', null, entry.message)))));
    }

    function AddVarModal({ vars, allNames, busy, editing, source, onSave, onCancel, allVars }) {
      const existing = editing ? vars.find((v) => v.name === editing) : null;
      const [name, setName] = React.useState(existing?.name ?? '');
      const [type, setType] = React.useState(existing?.type ?? 'string');
      const [desc, setDesc] = React.useState(existing?.desc ?? '');
      const [note, setNote] = React.useState(existing?.note ?? '');
      // 按钮类型变量的「绑定变量（回传内容）」：下拉搜索框，输入只过滤展示，点选才绑定。
      const [bindVar, setBindVar] = React.useState(existing?.bindVar ?? '');
      const [bindQuery, setBindQuery] = React.useState('');
      const [bindOpen, setBindOpen] = React.useState(false);
      const [src, setSrc] = React.useState(editing ? (source ?? 'template') : (source ?? 'template'));
      const [error, setError] = React.useState('');

      // 可绑定的文本类型变量（按钮回传内容写入文本变量，通常由按钮旁文本控件显示）。
      const BIND_TEXT_TYPES = new Set(['string', 'richText', 'user', 'number', 'boolean']);
      const bindCandidates = (allVars ?? [])
        .filter((v) => v.name !== name.trim() && BIND_TEXT_TYPES.has(v.type ?? 'string'))
        .filter((v) => (bindQuery ? v.name.toLowerCase().includes(bindQuery.trim().toLowerCase()) : true));

      const submit = () => {
        let nm = name.trim();
        if (nm.startsWith('${') && nm.endsWith('}')) nm = nm.slice(2, -1).trim();
        if (!nm) { setError('变量名不能为空。'); return; }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) {
          setError('变量名格式不正确：只能含字母、数字、下划线，且以字母或下划线开头（可输入 ${xxx} 或 xxx）。');
          return;
        }
        if (nm !== editing && allNames?.has(nm)) {
          setError(`变量名 \${${nm}} 已存在（模板变量或自定义变量中），不能重复添加。`);
          return;
        }
        if (type === 'button') {
          const bindName = bindVar.trim();
          if (bindName) {
            const ok = (allVars ?? []).some((v) => v.name === bindName && BIND_TEXT_TYPES.has(v.type ?? 'string'));
            if (!ok) { setError(`绑定变量 \${${bindName}} 不存在或不是文本类型（请从候选列表选择）。`); return; }
          }
        }
        if (!desc.trim()) { setError('请填写变量描述，说明这个变量是什么、怎么用。'); return; }
        const now = new Date().toISOString();
        const entry = {
          name: nm,
          type,
          desc: desc.trim(),
          note: note.trim(),
          // 按钮类型：绑定的回传内容文本变量（点击按钮回传的内容写入该变量）。
          bindVar: type === 'button' ? bindVar.trim() : '',
          mock: existing?.mock,
          createdAt: editing ? (existing?.createdAt ?? now) : now,
          updatedAt: now,
        };
        const next = editing
          ? vars.map((v) => (v.name === editing ? entry : v))
          : [...vars, entry];
        onSave(next, src);
        onCancel();
      };

      const typeMeta = DING_VAR_TYPE_META.find((t) => t.id === type) ?? DING_VAR_TYPE_META[0];
      const srcLabel = src === 'template' ? '模板变量' : '自定义变量';

      return h('div', { className: 'ddc-overlay', onClick: onCancel },
        h('div', { className: 'ddc-modal ddc-varsModal', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'ddc-modalHead' },
            h('h2', null,
              h('span', { className: 'ddc-headMark' }),
              editing ? `编辑变量` : '添加变量'),
            h('p', null, editing
              ? `修改 ${srcLabel} \${${editing}} 的类型与描述。`
              : '定义一个新的变量，供 Agent 与卡片模板引用（类型与钉钉卡片变量一致）。')),
          h('div', { className: 'ddc-modalBody' },
            h(Field, { label: '变量名', hint: '形如 ${title} 或 title；只能含字母、数字、下划线。' },
              h(TextInput, { value: name, onChange: setName, placeholder: '${grid_object_list}' })),
            h(Field, { label: '变量类型', hint: '与钉钉卡片搭建器的变量类型一一对应；悬停在下拉框上可查看类型说明。' },
              h('select', { value: type, title: typeMeta ? `${typeMeta.label}：${typeMeta.hint}` : undefined, onChange: (event) => setType(event.target.value) },
                DING_VAR_TYPE_META.map((t) => h('option', { key: t.id, value: t.id }, t.label)))),
            type === 'button'
              ? h(Field, { label: '绑定变量（回传内容）', hint: '按钮点击回传的内容写入该文本变量（通常由按钮旁文本控件显示）。点击输入框展开下拉，输入过滤搜索，点选后绑定；模板变量改名后在此重新绑定即可，无需重新导入。' },
                h('div', { className: 'ddc-bindBox' },
                  h('input', {
                    type: 'text',
                    value: bindOpen ? bindQuery : bindVar,
                    placeholder: bindVar ? `已绑定 \${${bindVar}}，点击重新选择` : '点击展开，选择回传内容写入的文本变量',
                    onFocus: () => { setBindOpen(true); setBindQuery(''); },
                    onBlur: () => { setTimeout(() => setBindOpen(false), 150); },
                    onChange: (event) => setBindQuery(event.target.value),
                  }),
                  bindOpen
                    ? h('div', { className: 'ddc-bindDropdown' },
                      bindCandidates.length === 0
                        ? h('p', { className: 'ddc-bindEmpty' }, bindQuery ? '没有匹配的文本类型变量' : '暂无可绑定的文本类型变量')
                        : bindCandidates.slice(0, 12).map((v) => h('button', {
                          key: v.name, type: 'button', className: 'ddc-bindCandidate',
                          onMouseDown: (event) => event.preventDefault(), // 阻止 blur 先关闭下拉
                          onClick: () => { setBindVar(v.name); setBindQuery(''); setBindOpen(false); },
                        }, `\${${v.name}}（${DING_VAR_TYPE_LABEL[v.type] ?? '普通文本'}）`)))
                    : null))
              : null,
            h(Field, { label: '变量描述', hint: '说明这个变量是什么、用途与使用场景。' },
              h('textarea', { value: desc, onChange: (event) => setDesc(event.target.value), placeholder: '例如：对象数组，循环渲染文章列表（每项含 image/title/link/id）' })),
            error ? h('p', { style: { color: '#d54941', fontSize: '13px', margin: '0' } }, error) : null),
          h('div', { className: 'ddc-modalFoot' },
            h('button', { type: 'button', className: 'ddc-button', onClick: onCancel }, '取消'),
            h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', disabled: busy, onClick: submit },
              editing ? '保存编辑' : '确认添加'))));
    }

    function defaultMockValue(type) {
      switch (type) {
        case 'string': case 'richText': case 'user': return '';
        case 'number': return 0;
        case 'boolean': return true;
        case 'stringArray': case 'userArray': return [''];
        case 'numberArray': return [0];
        case 'booleanArray': return [true];
        case 'object': return {};
        case 'objectArray': return [{}];
        case 'buttonGroup': return [{ text: '', value: '' }];
        case 'button': return { text: '', value: '' };
        case 'selectArray': return [{ label: '', value: '' }];
        case 'chart': case 'table': case 'form': case 'dynamicEvent': return {};
        default: return '';
      }
    }

    function MockListEditor({ type, value, onChange }) {
      const kind = type === 'numberArray' ? 'number' : type === 'booleanArray' ? 'boolean' : 'string';
      const addItem = () => onChange([...value, kind === 'number' ? 0 : kind === 'boolean' ? false : '']);
      const itemInput = (item, onItem) => (kind === 'boolean'
        ? h('select', { value: item ? 'true' : 'false', onChange: (event) => onItem(event.target.value === 'true') },
          h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false'))
        : kind === 'number'
          ? h('input', { type: 'number', value: item, onChange: (event) => onItem(Number(event.target.value) || 0), style: { minWidth: 0, flex: 1 } })
          : h(TextInput, { value: item, onChange: onItem, placeholder: kind === 'string' ? '字符串元素' : '用户 ID' }));
      return h('div', { className: 'ddc-mockRows' },
        value.map((item, i) => h('div', { key: i, className: 'ddc-mockRow' },
          itemInput(item, (next) => onChange(value.map((x, idx) => (idx === i ? next : x)))),
          h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-buttonDanger', onClick: () => onChange(value.filter((_, idx) => idx !== i)) }, '删除'))),
        h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', onClick: addItem }, '添加'));
    }

    function MockKvEditor({ value, onChange }) {
      const entries = Object.entries(value ?? {});
      const setRow = (i, key, val) => {
        const next = { ...value };
        delete next[entries[i][0]];
        if (key.trim()) next[key.trim()] = val;
        onChange(next);
      };
      return h('div', { className: 'ddc-mockRows' },
        entries.map(([key, val], i) => h('div', { key: i, className: 'ddc-mockRow' },
          h(TextInput, { value: key, onChange: (next) => setRow(i, next, val), placeholder: '字段名', style: { minWidth: 0, flex: 1 } }),
          h(TextInput, { value: typeof val === 'string' ? val : '', onChange: (next) => setRow(i, entries[i][0], next), placeholder: '值（字符串）', style: { minWidth: 0, flex: 1 } }),
          h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-buttonDanger', onClick: () => { const n = { ...value }; delete n[key]; onChange(n); } }, '删除'))),
        h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', onClick: () => onChange({ ...value, field: '' }) }, '添加字段'));
    }

    function MockObjectArrayEditor({ value, onChange }) {
      const addObject = () => onChange([...(value ?? []), {}]);
      return h('div', { className: 'ddc-mockRows' },
        (value ?? []).map((obj, i) => h('div', { key: i, className: 'ddc-mockObject' },
          h('div', { className: 'ddc-mockObjectHead' },
            h('span', null, `对象 ${i + 1}`),
            h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-buttonDanger', onClick: () => onChange(value.filter((_, idx) => idx !== i)) }, '删除对象')),
          h(MockKvEditor, { value: obj && typeof obj === 'object' ? obj : {}, onChange: (next) => onChange(value.map((x, idx) => (idx === i ? next : x))) }))),
        h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', onClick: addObject }, '添加对象'));
    }

    function MockPairsEditor({ fields, value, onChange, fixed }) {
      const addRow = () => onChange([...value, Object.fromEntries(fields.map((f) => [f.key, '']))]);
      // 行拖拽排序（含 FLIP 动画），供选项按钮、数组类 Mock 使用。
      const [dragIdx, setDragIdx] = React.useState(null);
      const [overIdx, setOverIdx] = React.useState(null);
      const rowsRef = React.useRef(null);
      const prevRowsRects = React.useRef(null);
      const rowsFlipTimer = React.useRef(null);
      React.useEffect(() => () => { if (rowsFlipTimer.current) clearTimeout(rowsFlipTimer.current); }, []);
      const reorderRow = (from, to) => {
        if (from === to || from < 0 || to < 0 || from >= value.length || to >= value.length) return;
        prevRowsRects.current = new Map();
        rowsRef.current?.querySelectorAll('[data-row-idx]').forEach((el) => {
          prevRowsRects.current.set(el.getAttribute('data-row-idx'), el.getBoundingClientRect().top);
        });
        const next = [...value];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        onChange(next);
      };
      React.useEffect(() => {
        if (!prevRowsRects.current || prevRowsRects.current.size === 0) return;
        const prev = prevRowsRects.current;
        prevRowsRects.current = null;
        rowsRef.current?.querySelectorAll('[data-row-idx]').forEach((el) => {
          const from = prev.get(el.getAttribute('data-row-idx'));
          if (from == null) return;
          const dy = from - el.getBoundingClientRect().top;
          if (Math.abs(dy) < 0.5) return;
          el.style.transition = 'none';
          el.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            el.style.transition = 'transform 220ms cubic-bezier(0.2, 0.6, 0.2, 1)';
            el.style.transform = 'translateY(0)';
          }));
        });
        if (rowsFlipTimer.current) clearTimeout(rowsFlipTimer.current);
        rowsFlipTimer.current = setTimeout(() => {
          rowsRef.current?.querySelectorAll('[data-row-idx]').forEach((el) => {
            el.style.transition = '';
            el.style.transform = '';
          });
        }, 260);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [value]);
      return h('div', { className: 'ddc-mockRows', ref: rowsRef },
        value.map((row, i) => h('div', {
          key: i,
          className: `ddc-mockRow${dragIdx === i ? ' ddc-varDragging' : ''}${overIdx === i && dragIdx !== null && overIdx !== dragIdx ? ' ddc-varDropTarget' : ''}`,
          'data-row-idx': i,
          onDragOver: (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (overIdx !== i) setOverIdx(i); },
          onDragLeave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOverIdx((cur) => (cur === i ? null : cur)); },
          onDrop: (event) => { event.preventDefault(); if (dragIdx !== null && dragIdx !== i) reorderRow(dragIdx, i); setDragIdx(null); setOverIdx(null); },
        },
          h('div', {
            className: 'ddc-varDragHandle ddc-mockDragHandle',
            'data-idx': i,
            draggable: true,
            title: '拖拽排序',
            onDragStart: (event) => { setDragIdx(i); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(i)); },
            onDragEnd: () => { setDragIdx(null); setOverIdx(null); },
          }, '⋮⋮'),
          fields.map((f) => h(TextInput, {
            key: f.key, value: row[f.key] ?? '', placeholder: f.label,
            onChange: (next) => onChange(value.map((x, idx) => (idx === i ? { ...x, [f.key]: next } : x))),
            style: { minWidth: 0, flex: 1 },
          })),
          fixed ? null : h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-buttonDanger', onClick: () => onChange(value.filter((_, idx) => idx !== i)) }, '删除'))),
        fixed ? null : h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', onClick: addRow }, '添加'));
    }

    function JsonEditor({ value, onChange, onError }) {
      const [text, setText] = React.useState(() => JSON.stringify(value ?? {}, null, 2));
      const commit = (raw) => {
        setText(raw);
        try {
          const parsed = JSON.parse(raw);
          onChange(parsed);
          onError?.('');
        } catch { onError?.('JSON 格式不正确，请检查后重试。'); }
      };
      return h('textarea', {
        value: text,
        onChange: (event) => commit(event.target.value),
        spellCheck: false,
        style: { minHeight: '120px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px' },
      });
    }

    /** 图片变量按钉钉官方文档以普通文本变量处理（传图片 URL / mediaId）。 */
    function MockModal({ v, busy, onSave, onCancel, optionVar }) {
      const type = v?.type ?? 'string';
      const [mock, setMock] = React.useState(() => (v?.mock !== undefined ? v.mock : defaultMockValue(type)));
      const [error, setError] = React.useState('');
      const typeMeta = DING_VAR_TYPE_META.find((t) => t.id === type) ?? DING_VAR_TYPE_META[0];
      const editor = (() => {
        switch (type) {
          case 'string':
            // 选项按钮变量（optionN）：Mock 为 {text, value} 对象，用「按钮文案 + 回传值」双输入编辑，
            // 与发送测试弹窗的选项按钮区块数据结构一致，双向同步；兼容旧的字符串 mock。
            if (optionVar) {
              const row = mock && typeof mock === 'object' && !Array.isArray(mock)
                ? { text: String(mock.text ?? ''), value: String(mock.value ?? '') }
                : { text: typeof mock === 'string' ? mock : '', value: '' };
              return h('div', { className: 'ddc-mockOptionPair' },
                h(Field, { label: '按钮文案', hint: '显示在按钮上的文字' },
                  h(TextInput, { value: row.text, placeholder: '如：方案 A', onChange: (text) => setMock({ text, value: row.value }) })),
                h(Field, { label: '回传值', hint: '点击按钮后回传给服务端的内容' },
                  h(TextInput, { value: row.value, placeholder: '如：方案 A 的详细内容', onChange: (value) => setMock({ text: row.text, value }) })));
            }
            // 选项按钮变量被发送测试回写为 {text,value} 对象：此处兼容显示 JSON，保存后为字符串。
            // 用可调整大小的多行文本框承载，长内容（音频地址等）可直接拖拽放大查看/编辑。
            return h('textarea', {
              className: 'ddc-mockTextarea',
              value: typeof mock === 'string' ? mock : (mock !== undefined && mock !== null ? JSON.stringify(mock) : ''),
              onChange: (event) => setMock(event.target.value),
              placeholder: '文本内容',
            });
          case 'button':
            // 「按钮」类型变量：单个按钮 = 按钮文案 + 回传内容（与发送测试选项按钮区块同构，双向同步）。
            {
              const row = mock && typeof mock === 'object' && !Array.isArray(mock)
                ? { text: String(mock.text ?? ''), value: String(mock.value ?? '') }
                : { text: typeof mock === 'string' ? mock : '', value: '' };
              return h('div', { className: 'ddc-mockOptionPair' },
                h(Field, { label: '按钮文案', hint: '显示在按钮上的文字' },
                  h(TextInput, { value: row.text, placeholder: '如：方案 A', onChange: (text) => setMock({ text, value: row.value }) })),
                h(Field, { label: '回传值', hint: '点击按钮后回传并显示在按钮旁的内容' },
                  h(TextInput, { value: row.value, placeholder: '如：方案 A 的详细内容', onChange: (value) => setMock({ text: row.text, value }) })));
            }
          case 'richText':
            return h('textarea', { className: 'ddc-mockTextarea', value: typeof mock === 'string' ? mock : '', onChange: (event) => setMock(event.target.value), placeholder: 'Markdown 内容' });
          case 'number':
            return h('input', { type: 'number', value: typeof mock === 'number' ? mock : 0, onChange: (event) => setMock(Number(event.target.value) || 0), style: { minWidth: 0 } });
          case 'boolean':
            return h('select', { value: mock ? 'true' : 'false', onChange: (event) => setMock(event.target.value === 'true') },
              h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false'));
          case 'user':
            return h(TextInput, { value: typeof mock === 'string' ? mock : '', onChange: (val) => setMock(val), placeholder: 'userId / unionId' });
          case 'stringArray': case 'numberArray': case 'booleanArray': case 'userArray':
            return h(MockListEditor, { type, value: Array.isArray(mock) ? mock : [], onChange: setMock });
          case 'object':
            return h(MockKvEditor, { value: mock && typeof mock === 'object' && !Array.isArray(mock) ? mock : {}, onChange: setMock });
          case 'objectArray':
            return h(MockObjectArrayEditor, { value: Array.isArray(mock) ? mock : [{}], onChange: setMock });
          case 'buttonGroup':
            return h(MockPairsEditor, { fields: [{ key: 'text', label: '按钮文案' }, { key: 'value', label: '回传值' }], value: Array.isArray(mock) ? mock : [{ text: '', value: '' }], onChange: setMock });
          case 'selectArray':
            return h(MockPairsEditor, { fields: [{ key: 'label', label: '选项文案' }, { key: 'value', label: '选项值' }], value: Array.isArray(mock) ? mock : [{ label: '', value: '' }], onChange: setMock });
          default:
            return h(JsonEditor, { value: mock, onChange: setMock, onError: setError });
        }
      })();
      return h('div', { className: 'ddc-overlay', onClick: onCancel },
        h('div', { className: 'ddc-modal ddc-varsModal', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'ddc-modalHead' },
            h('h2', null, h('span', { className: 'ddc-headMark' }), `Mock 数据`),
            h('p', null, `变量 \${${v?.name ?? ''}}（${typeMeta.label}）的 Mock 数据，发送测试时作为默认填充。`)),
          h('div', { className: 'ddc-modalBody' },
            editor,
            error ? h('p', { style: { color: '#d54941', fontSize: '13px', margin: '0' } }, error) : null),
          h('div', { className: 'ddc-modalFoot' },
            h('button', { type: 'button', className: 'ddc-button', onClick: onCancel }, '取消'),
            h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', disabled: busy || Boolean(error), onClick: () => onSave(mock) }, '保存 Mock'))));
    }

    function DeleteConfirmModal({ v, source, busy, onConfirm, onCancel, title, desc, name }) {
      const displayName = name ?? v?.name ?? '';
      const modalTitle = title ?? `删除${source === 'template' ? '模板' : '自定义'}变量`;
      const modalDesc = desc ?? [
        '确定要删除变量 ',
        h('code', { className: 'ddc-delName' }, `\${${displayName}}`),
        ' 吗？此操作不可撤销。',
        (v?.desc || v?.label) ? h('span', null, `（${v.desc || v.label}）`) : null,
      ];
      return h('div', { className: 'ddc-overlay', onClick: onCancel },
        h('div', { className: 'ddc-modal ddc-delModal', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'ddc-delBody' },
            h('div', { className: 'ddc-delIcon' },
              h('svg', { width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
                h('path', { d: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14ZM10 11v6M14 11v6' }))),
            h('p', { className: 'ddc-delTitle' }, modalTitle),
            h('p', { className: 'ddc-delDesc' }, modalDesc)),
          h('div', { className: 'ddc-modalFoot' },
            h('button', { type: 'button', className: 'ddc-button', onClick: onCancel }, '取消'),
            h('button', { type: 'button', className: 'ddc-button ddc-buttonDangerSolid', disabled: busy, onClick: onConfirm }, '确认删除'))));
    }

    const SIDEBAR_MODE_META = {
      auto: { label: '自动隐藏', desc: '未绑定可用卡片时显示入口；配置至少一张可用卡片后自动隐藏。' },
      show: { label: '始终显示', desc: '侧边栏入口始终显示。' },
      hide: { label: '始终隐藏', desc: '侧边栏入口始终隐藏；仍可从插件详情进入，不影响运行。' },
    };

    function SidebarModal({ mode, busy, onChange, onSave, onClose }) {
      const meta = SIDEBAR_MODE_META[mode] ?? SIDEBAR_MODE_META.auto;
      return h('div', { className: 'ddc-overlay', onClick: onClose },
        h('div', { className: 'ddc-modal ddc-varsModal', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'ddc-modalHead' },
            h('h2', null, h('span', { className: 'ddc-headMark' }), '通用设计'),
            h('p', null, '设置 dsh-ding-card 在 DSH 侧边栏的显示方式。')),
          h('div', { className: 'ddc-modalBody' },
            h(Field, { label: '侧边栏入口' },
              h('select', { value: mode, onChange: (event) => onChange(event.target.value) },
                Object.keys(SIDEBAR_MODE_META).map((key) => h('option', { key, value: key }, SIDEBAR_MODE_META[key].label)))),
            h('div', { className: 'ddc-notice' }, meta.desc),
            h('div', { className: 'ddc-notice' },
              '自动模式下，隐藏后仍可从插件详情或「设置」进入，不影响卡片与机器人后台运行。')),
          h('div', { className: 'ddc-modalFoot' },
            h('button', { type: 'button', className: 'ddc-button', onClick: onClose }, '取消'),
            h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', disabled: busy, onClick: onSave }, '保存'))));
    }

    function VariablesTab({ config, busy, onSave }) {
      const templateVars = config?.templateVariables ?? [];
      const vars = config?.customVariables ?? [];
      const [modal, setModal] = React.useState(null);   // {editing:name|null, source}
      const [delTarget, setDelTarget] = React.useState(null); // {name, source}
      const [mockTarget, setMockTarget] = React.useState(null); // {name, source}
      const [mockView, setMockView] = React.useState(null); // 查看完整 Mock 的变量（来源与名称）
      const [query, setQuery] = React.useState('');
      // 变量类型多选筛选：勾选类型只展示该类型变量，不勾选 = 全部。
      const [typeFilter, setTypeFilter] = React.useState([]);
      const [typeOpen, setTypeOpen] = React.useState(false);

      const listOf = (source) => (source === 'template' ? templateVars : vars);
      const patchList = (source, next) => (source === 'template'
        ? onSave({ templateVariables: next })
        : onSave({ customVariables: next }));

      const confirmDelete = () => {
        patchList(delTarget.source, listOf(delTarget.source).filter((v) => v.name !== delTarget.name));
        setDelTarget(null);
      };

      const saveMock = (mock) => {
        // 按钮类型变量（{text,value}）保存时同步配对回传变量（optionValueVars）的 Mock，
        // 保证「按钮回传值」与「文本控件显示变量」双向一致（一处修改，多处同步）。
        const isButtonMock = mock && typeof mock === 'object' && !Array.isArray(mock) && 'text' in mock && 'value' in mock;
        // 按钮 Mock 只同步「变量集里显式配置的绑定变量」（bindVar）：
        // 没有配置绑定则不做配对同步，避免「显示未绑定却自动联动」的困惑行为。
        let pairName = null;
        if (isButtonMock) {
          const selfDef = [...(config?.templateVariables ?? []), ...(config?.customVariables ?? [])]
            .find((v) => v.name === mockTarget.name);
          if (selfDef?.bindVar && selfDef.bindVar !== mockTarget.name) {
            pairName = selfDef.bindVar;
          }
        }
        const patches = {};
        if (mockTarget.source === 'custom') {
          patches.customVariables = vars.map((v) => (v.name === mockTarget.name ? { ...v, mock } : v));
        } else {
          patches.templateVariables = templateVars.map((v) => (v.name === mockTarget.name ? { ...v, mock } : v));
        }
        if (isButtonMock && pairName) {
          const pairValue = String(mock.value ?? '');
          if (vars.some((v) => v.name === pairName)) {
            patches.customVariables = (patches.customVariables ?? vars.map((v) => ({ ...v })))
              .map((v) => (v.name === pairName ? { ...v, mock: pairValue } : v));
          }
          if (templateVars.some((v) => v.name === pairName)) {
            patches.templateVariables = (patches.templateVariables ?? templateVars.map((v) => ({ ...v })))
              .map((v) => (v.name === pairName ? { ...v, mock: pairValue } : v));
          }
        }
        onSave(patches);
        setMockTarget(null);
      };

      const saveEntry = (next, source) => {
        const oldName = modal && typeof modal.editing === 'string' && modal.editing ? modal.editing : null;
        const listKey = source === 'template' ? 'templateVariables' : 'customVariables';
        const patches = { [listKey]: next };
        if (oldName && oldName !== next.name) {
          // 改名联动：把卡片侧绑定（音乐播放器四字段 / 按钮组 optionVars / 成组按钮文本 buttonVars）
          // 与变量侧 bindVar 中引用旧名的位置统一替换为新名，预览与回调仍指向同一变量。
          const replace = (v) => (typeof v === 'string' && v === oldName ? next.name : v);
          const cardPatches = [];
          for (const card of config?.cards ?? []) {
            const cv = card.variables ?? {};
            const nd = card.design && typeof card.design === 'object' ? card.design : {};
            let changed = false;
            const nv = { ...cv };
            if (nv.audioPlayer && typeof nv.audioPlayer === 'object') {
              const ap = { ...nv.audioPlayer };
              for (const key of ['url', 'coverUrl', 'title', 'artist']) {
                if (typeof ap[key] === 'string' && ap[key] === oldName) { ap[key] = next.name; changed = true; }
              }
              nv.audioPlayer = ap;
            }
            if (Array.isArray(nv.optionVars)) {
              const mapped = nv.optionVars.map(replace);
              if (mapped.some((v, i) => v !== nv.optionVars[i])) { nv.optionVars = mapped; changed = true; }
            }
            if (nv.buttonVars && typeof nv.buttonVars === 'object') {
              const bv = {};
              for (const [k, v] of Object.entries(nv.buttonVars)) {
                if (typeof v === 'string' && v === oldName) { bv[k] = next.name; changed = true; } else { bv[k] = v; }
              }
              nv.buttonVars = bv;
            }
            // design.audioPlayer 是「发送测试弹窗手动拖拽/输入绑定」的持久化位置，同样跟随改名。
            let ad = null;
            if (nd.audioPlayer && typeof nd.audioPlayer === 'object') {
              const cand = { ...nd.audioPlayer };
              let adChanged = false;
              for (const key of ['url', 'coverUrl', 'title', 'artist']) {
                if (typeof cand[key] === 'string' && cand[key] === oldName) { cand[key] = next.name; adChanged = true; }
              }
              if (adChanged) { ad = cand; changed = true; }
            }
            if (changed) cardPatches.push({ ...card, variables: nv, design: ad ? { ...nd, audioPlayer: ad } : nd });
          }
          if (cardPatches.length > 0) patches.cards = cardPatches;
          // 变量自身的绑定：按钮类型变量绑定的回传文本变量名同步改名。
          const otherKey = source === 'template' ? 'customVariables' : 'templateVariables';
          const otherList = config?.[otherKey] ?? [];
          const mappedOther = otherList.map((v) => (v?.bindVar === oldName ? { ...v, bindVar: next.name } : v));
          if (mappedOther.some((v, i) => v?.bindVar !== otherList[i]?.bindVar)) patches[otherKey] = mappedOther;
        }
        onSave(patches);
      };

      const findVar = (source, name) => listOf(source).find((v) => v.name === name) ?? null;
      const mockTargetVar = mockTarget ? findVar(mockTarget.source, mockTarget.name) : null;
      const mockViewVar = mockView ? findVar(mockView.source, mockView.name) : null;
      const delTargetVar = delTarget ? findVar(delTarget.source, delTarget.name) : null;
      // 识别被卡片「选项按钮」绑定的变量（optionN）：其 Mock 用「按钮文案 + 回传值」双输入编辑，
      // 与发送测试弹窗的选项按钮区块保持同一数据结构（{text, value} 对象）与双向同步。
      const isOptionVar = (name) => (config?.cards ?? []).some((c) => (c.variables?.optionVars ?? []).includes(name));

      const entries = [
        ...templateVars.map((v) => ({ ...v, source: 'template' })),
        ...vars.map((v) => ({ ...v, source: 'custom' })),
      ].filter((v) => v && typeof v === 'object' && typeof v.name === 'string');
      const kw = String(query ?? '').trim().toLowerCase();
      const typeMatched = (v) => typeFilter.length === 0 || typeFilter.includes(v.type);
      const shownEntries = (kw
        ? entries.filter((v) => String(v.name ?? '').toLowerCase().includes(kw)
          || String(v.desc ?? v.label ?? '').toLowerCase().includes(kw)
          || String(v.note ?? '').toLowerCase().includes(kw))
        : entries).filter(typeMatched);

      const grid = shownEntries.length === 0
        ? h('div', { className: 'ddc-empty' },
          entries.length === 0 ? '还没有变量，点击右上「添加变量」创建。' : `没有匹配「${query.trim()}」的变量。`)
        : h('ul', { className: 'ddc-varsGrid' },
          shownEntries.map((v) => h('li', { key: `${v.source}:${v.name}`, className: 'ddc-varCard' },
            h('div', { className: 'ddc-varCardHead' },
              h('code', { className: 'ddc-varName' }, `\${${v.name}}`),
              h('div', { className: 'ddc-varCardTags' },
                h('span', { className: 'ddc-varType' }, DING_VAR_TYPE_LABEL[v.type] ?? '普通文本'),
                h('span', { className: v.source === 'template' ? 'ddc-varSrc ddc-varSrcTemplate' : 'ddc-varSrc' },
                  v.source === 'template' ? '模板变量' : '自定义变量'))),
            h('p', { className: 'ddc-varDesc' }, String(v.desc ?? v.label ?? '—')),
            v.note ? h('p', { className: 'ddc-varNote' }, String(v.note)) : null,
            v.type === 'button' && v.bindVar ? h('p', { className: 'ddc-varBind' }, `绑定回传 → \${${v.bindVar}}`) : null,
            v.mock !== undefined ? h('button', {
              type: 'button', className: 'ddc-varMock', title: '点击查看完整内容',
              onClick: () => setMockView({ name: v.name, source: v.source }),
            }, `Mock：${mockSummary(v.mock)}`) : null,
            h('div', { className: 'ddc-varCardFoot' },
              h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', disabled: busy, onClick: () => setMockTarget({ name: v.name, source: v.source, isOption: isOptionVar(v.name) }) }, 'Mock'),
              h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall', disabled: busy, onClick: () => setModal({ editing: v.name, source: v.source }) }, '编辑'),
              h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-buttonDanger', disabled: busy, onClick: () => setDelTarget({ name: v.name, source: v.source }) }, '删除')))));

      return h('div', { className: 'ddc-form' },
        h('div', { className: 'ddc-tabSticky' },
          h('div', { className: 'ddc-actions' },
            h('div', { className: 'ddc-typeFilter', onMouseLeave: () => setTypeOpen(false) },
              h('button', { type: 'button', className: 'ddc-button ddc-buttonSmall ddc-typeFilterBtn', onClick: () => setTypeOpen((open) => !open) },
                h('span', null, typeFilter.length === 0 ? '全部类型' : `已选 ${typeFilter.length} 种`),
                h('span', { className: 'ddc-caret' }, '▾')),
              typeOpen
                ? h('div', { className: 'ddc-typeMenu ddc-typeMenuScroll' },
                  DING_VAR_TYPE_META.map((type) => h('label', { key: type.id, className: 'ddc-typeOption' },
                    h('input', {
                      type: 'checkbox',
                      checked: typeFilter.includes(type.id),
                      onChange: () => {
                        setTypeFilter((cur) => (cur.includes(type.id) ? cur.filter((x) => x !== type.id) : [...cur, type.id]));
                      },
                    }),
                    h('span', null, type.label))))
                : null),
            h('input', { className: 'ddc-search', placeholder: '搜索变量名 / 描述…', value: query, onChange: (event) => setQuery(event.target.value) }),
            h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', onClick: () => setModal({ source: 'template' }) }, '添加变量')),
          h('div', { className: 'ddc-sectionHead ddc-varsSectionHead' },
            h('h2', null, '变量集'),
            h('span', { className: 'ddc-varsCount' }, `变量总数 ${entries.length} 个`))),
        modal ? h(AddVarModal, {
          vars: listOf(modal.source ?? 'template'),
          allVars: [...templateVars, ...vars],
          allNames: new Set([...templateVars, ...vars].map((v) => v.name)),
          busy, editing: modal.editing ?? null,
          source: modal.source ?? 'template',
          onSave: saveEntry,
          onCancel: () => setModal(null),
        }) : null,
        mockTargetVar ? h(MockModal, { v: mockTargetVar, optionVar: mockTarget?.isOption ?? false, busy, onSave: saveMock, onCancel: () => setMockTarget(null) }) : null,
        mockView ? h(MockViewModal, { v: mockViewVar ?? mockView, onClose: () => setMockView(null) }) : null,
        delTargetVar ? h(DeleteConfirmModal, { v: delTargetVar, source: delTarget.source, busy, onConfirm: confirmDelete, onCancel: () => setDelTarget(null) }) : null,
        grid);
    }

    function MockViewModal({ v, onClose }) {
      const text = v?.mock === undefined || v?.mock === null ? '空' : mockSummary(v.mock);
      const typeMeta = DING_VAR_TYPE_META.find((t) => t.id === v?.type) ?? DING_VAR_TYPE_META[0];
      return h('div', { className: 'ddc-overlay', onClick: onClose },
        h('div', { className: 'ddc-modal ddc-mockViewModal', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'ddc-modalHead' },
            h('h2', null, h('span', { className: 'ddc-headMark' }), 'Mock 内容'),
            h('p', null, `变量 \${${v?.name ?? ''}}（${typeMeta.label}）的完整 Mock 数据，可拖拽右下角调整文本框大小。`)),
          h('div', { className: 'ddc-modalBody' },
            h('textarea', {
              className: 'ddc-mockViewText',
              readOnly: true,
              value: text,
              spellCheck: false,
              onFocus: (event) => event.currentTarget.select(),
            })),
          h('div', { className: 'ddc-modalFoot ddc-actions', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'ddc-button ddc-buttonPrimary', onClick: onClose }, '关闭'))));
    }

    function mockSummary(mock) {
      if (mock === undefined || mock === null) return '空';
      try {
        // 按钮类型 Mock（{text, value}）：以「按钮文案 → 回传内容」展示，更易读。
        if (mock && typeof mock === 'object' && !Array.isArray(mock)
          && 'text' in mock && 'value' in mock && Object.keys(mock).length === 2) {
          return `${String(mock.text ?? '')} → ${String(mock.value ?? '')}`;
        }
        // 完整展示不截断：超长内容（如音频/封面地址）由 CSS 换行显示，不再以省略号截断。
        return JSON.stringify(mock);
      } catch { return String(mock); }
    }

    function downloadJson(fileName, payload) {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }

    function mergeConfig(base, patch) {
      if (!base || typeof base !== 'object') return patch;
      const output = { ...base };
      for (const [key, value] of Object.entries(patch ?? {})) {
        output[key] = value && typeof value === 'object' && !Array.isArray(value)
          && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
          ? mergeConfig(base[key], value)
          : value;
      }
      return output;
    }

    function DingCardPage({ ctx }) {
      const [tab, setTab] = React.useState('overview');
      const [status, setStatus] = React.useState(null);
      const [config, setConfig] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [picker, setPicker] = React.useState(null);
      const [importBox, setImportBox] = React.useState(false);
      const [sidebarModal, setSidebarModal] = React.useState(false);
      const [sidebarMode, setSidebarMode] = React.useState('auto');
      const [delCard, setDelCard] = React.useState(null);
      const [versionInfo, setVersionInfo] = React.useState({
        current: `v${PLUGIN_VERSION}`, latest: null, updateAvailable: false,
        checking: false, error: '', command: null, env: null, hotReload: false, linkMode: false,
      });
      const lastTestRef = React.useRef({});
      const alive = React.useRef(true);
      React.useEffect(() => () => {
        alive.current = false;
        if (mockSyncTimer.current) clearTimeout(mockSyncTimer.current);
      }, []);

      // 读取侧边栏入口显隐配置，并同步侧边栏入口是否渲染。
      React.useEffect(() => {
        void (async () => {
          try {
            const value = await rpcCall(ctx, 'sidebar-entry.get');
            if (!alive.current) return;
            setSidebarMode(value?.mode ?? 'auto');
            setSidebarVisible(value?.visible !== false);
          } catch { /* 侧边栏配置读取失败时保持当前状态 */ }
        })();
      }, []);

      // 启动时自动检查一次插件版本（GitHub Release）。
      React.useEffect(() => {
        void checkVersion();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const patchConfig = React.useCallback((partial) => {
        setConfig((current) => mergeConfig(current ?? {}, partial));
      }, []);

      // 交互页自动保存：每次交互立即持久化，不显示「已保存」提示。
      const configRef = React.useRef(config);
      React.useEffect(() => { configRef.current = config; }, [config]);
      const autosaveInteractions = React.useCallback((partial) => {
        const next = mergeConfig(configRef.current ?? {}, partial);
        configRef.current = next;
        setConfig(next);
        void rpcCall(ctx, 'config.save', { config: next })
          .then((value) => {
            if (value?.config && alive.current) {
              configRef.current = value.config;
              setConfig(value.config);
            }
          })
          .catch(() => { /* 静默失败，下次交互重试 */ });
      }, []);

      const [updateState, setUpdateState] = React.useState({ applying: false, done: false });
      const [restartPrompt, setRestartPrompt] = React.useState(null);

      // 重启 DSH：桌面宿主支持 app.relaunch 自我重启；网页端等只能给出重启方式。
      const restartDsh = React.useCallback(async () => {
        if (!alive.current) return;
        setNotice('正在重启 DSH…');
        try {
          const value = await rpcCall(ctx, 'version.restart');
          if (!alive.current) return;
          if (value?.restarted) {
            setNotice('正在重启 DSH 客户端，页面会断开，请稍后重新打开。');
            return;
          }
          setNotice(value?.message ?? '当前宿主不允许插件自行重启，请手动重启。');
          // 自动重启不可用时，把横幅降级为纯提示，避免用户重复点“立即重启”。
          setRestartPrompt((prev) => (prev ? { ...prev, kind: 'manual', message: value?.message ?? prev.message } : prev));
        } catch (cause) {
          if (alive.current) setNotice(`重启失败：${cause?.message ?? cause}`);
        }
      }, [setNotice]);

      // 复制更新命令：把服务端识别出的命令写进剪贴板（链接安装或找不到 CLI 时也能手工执行）。
      const writeClipboard = React.useCallback(async (text) => {
        const value = String(text ?? '').trim();
        if (!value) return false;
        try {
          await window.navigator.clipboard.writeText(value);
          return true;
        } catch {
          return false;
        }
      }, []);

      // 一键更新：由插件内部按当前环境（profile）执行安装，不需要卸载。
      // auto=true 表示“首次自动更新”，失败不弹提示，仅记录在横幅状态里。
      const applyUpdate = React.useCallback(async ({ auto = false } = {}) => {
        if (!alive.current) return null;
        setUpdateState({ applying: true, done: false });
        try {
          const value = await rpcCall(ctx, 'version.update');
          if (!alive.current) return value;
          const ok = value?.ok !== false && Boolean(value?.updated || value?.hotReload || value?.queued);
          setUpdateState({ applying: false, done: ok });
          if (value?.hotReload) {
            setNotice(value?.message ?? '正在热更新插件，稍后自动恢复。');
          } else if (value?.ok !== false && value?.updated) {
            if (value?.requiresRestart) {
              // 覆盖安装已完成，但必须重启才换掉运行中的旧代码。
              setRestartPrompt({
                version: value.version ?? null,
                message: value.message ?? `已更新到 ${value.version ?? versionInfo.latest}，重启 DSH 后生效。`,
                command: value.restart?.command ?? null,
                kind: value.restart?.kind ?? 'web',
              });
              setNotice('');
            } else {
              setNotice(value?.message ?? `已更新到 ${value.version ?? versionInfo.latest}，无需重启即已生效`);
            }
          } else if (value?.manual || value?.ok === false) {
            // 更新没跑起来：与 dsh-mrrp 一致，把同一条命令写进剪贴板，提示用户手工执行
            const command = value?.command ?? versionInfo.command ?? '';
            if (!auto) {
              const copied = await writeClipboard(command);
              const reason = String(value?.output ?? value?.message ?? '').trim().split(/\r?\n/).slice(-3).join(' / ');
              if (alive.current) {
                setNotice(`${reason || '更新未完成'}${command ? (copied ? '；已复制更新命令，可在终端粘贴执行' : `；请手动执行：${command}`) : ''}`);
              }
            }
          } else if (value?.message) {
            setNotice(value.message);
          }
          return value;
        } catch (cause) {
          if (alive.current) setUpdateState({ applying: false, done: false });
          if (alive.current && !auto) setNotice(`更新失败：${cause?.message ?? cause}`);
          return null;
        }
      }, [setNotice, versionInfo.latest, versionInfo.command, writeClipboard]);

      // 复制命令按钮：复制横幅里展示的同一条命令
      const copyUpdateCommand = React.useCallback(async () => {
        const command = versionInfo.command ?? versionInfo.env?.command ?? '';
        const copied = await writeClipboard(command);
        if (!alive.current) return;
        setNotice(copied ? '已复制更新命令，可在终端粘贴执行' : `剪贴板不可用，请手动复制：${command}`);
      }, [setNotice, versionInfo.command, versionInfo.env, writeClipboard]);

      const checkVersion = React.useCallback(async () => {
        if (!alive.current) return;
        setVersionInfo((v) => ({ ...v, checking: true, error: '' }));
        try {
          const value = await rpcCall(ctx, 'version.check');
          if (!alive.current) return;
          setVersionInfo({
            current: `v${value?.current ?? PLUGIN_VERSION}`,
            latest: value?.latest ? `v${value.latest}` : null,
            updateAvailable: Boolean(value?.updateAvailable),
            command: value?.command ?? null,
            profile: value?.profile ?? null,
            /** 本机安装环境（服务端识别）：决定横幅文案与「立即更新」是否可用 */
            env: value?.env ?? null,
            hotReload: Boolean(value?.hotReload),
            linkMode: Boolean(value?.linkMode),
            checking: false,
            error: '',
          });
          // 首次识别到新版本时自动更新一次（同一版本只尝试一次，避免反复下载）。
          if (Boolean(value?.updateAvailable) && value?.latest) {
            try {
              const key = `dsh-ding-card:auto-update:${value.latest}`;
              if (window.localStorage?.getItem(key)) return;
              window.localStorage?.setItem(key, 'pending');
            } catch { /* 无 localStorage 时仍执行一次自动更新 */ }
            void applyUpdate({ auto: true });
          }
        } catch (cause) {
          if (alive.current) setVersionInfo((v) => ({ ...v, checking: false, error: cause?.message ?? '版本检查失败' }));
        }
      }, [applyUpdate]);

      const refresh = React.useCallback(async () => {
        try {
          const next = await rpcCall(ctx, 'status');
          if (!alive.current) return;
          setStatus(next);
          setConfig((current) => current ?? next.config);
          setError('');
        } catch (cause) {
          if (alive.current) setError(cause?.message ?? '无法读取钉卡片状态。');
        }
      }, []);

      React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => { void refresh(); }, 8_000);
        return () => clearInterval(timer);
      }, [refresh]);

      const run = async (label, action) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const value = await action();
          if (alive.current) setNotice(value ?? `${label}完成`);
          await refresh();
        } catch (cause) {
          if (alive.current) setError(cause?.message ?? `${label}失败`);
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      // 发送测试输入 → 变量库 Mock 双向同步：实时回写该变量定义处的 mock 值，防抖持久化。
      // immediate=true 时跳过防抖立即保存（用于关闭弹窗/迁移等关键时机）。
      const mockSyncTimer = React.useRef(null);
      const syncVarMockToLibrary = (name, value, immediate = false) => {
        const patch = { config: { ...config } };
        let changed = false;
        const bumpList = (key) => {
          const list = (patch.config[key] ?? []).map((v) => (v.name === name ? { ...v, mock: value } : v));
          if (!changed && list.some((v, i) => v.mock !== (patch.config[key] ?? [])[i]?.mock)) changed = true;
          patch.config[key] = list;
        };
        if ((config.templateVariables ?? []).some((v) => v.name === name)) bumpList('templateVariables');
        if ((config.customVariables ?? []).some((v) => v.name === name)) bumpList('customVariables');
        patch.config.cards = (patch.config.cards ?? []).map((c) => {
          const list = (c.customVariables ?? []).map((v) => (v.name === name ? { ...v, mock: value } : v));
          if (!changed && list.some((v, i) => v.mock !== (c.customVariables ?? [])[i]?.mock)) changed = true;
          return list.some((v, i) => v.mock !== (c.customVariables ?? [])[i]?.mock) ? { ...c, customVariables: list } : c;
        });
        if (!changed) return;
        const save = async () => {
          try {
            const result = await rpcCall(ctx, 'config.save', patch);
            if (result?.config && alive.current) setConfig(result.config);
          } catch { /* 静默：下一次输入会再次触发保存 */ }
        };
        if (mockSyncTimer.current) clearTimeout(mockSyncTimer.current);
        if (immediate) { void save(); } else { mockSyncTimer.current = setTimeout(() => { void save(); }, 400); }
      };

      // 发送测试弹窗内拖拽排序实时持久化：写入该卡片的 variables.varOrder。
      const persistVarOrder = (cardId, order) => {
        try {
          const patch = {
            config: {
              ...config,
              cards: (config.cards ?? []).map((c) => (c.id === cardId
                ? { ...c, variables: { ...(c.variables ?? {}), varOrder: order } }
                : c)),
            },
          };
          rpcCall(ctx, 'config.save', patch)
            .then((result) => { if (result?.config && alive.current) setConfig(result.config); })
            .catch(() => { /* 静默：下一次拖拽会再次触发保存 */ });
        } catch { /* 忽略 */ }
      };

      // 音乐播放器四槽位（音频地址/封面/标题/歌手）的手动绑定实时持久化：
      // 写入该卡片的 design.audioPlayer，与「导入模板自动解析」同一字段、同一生效通道。
      // 重新导入 JSON 会重建 design → 手动绑定随之清除并按模板重新识别（符合预期）。
      const persistAudioBind = (cardId, bind) => {
        try {
          const patch = {
            config: {
              ...config,
              cards: (config.cards ?? []).map((c) => (c.id === cardId
                ? { ...c, design: { ...(c.design ?? {}), audioPlayer: bind } }
                : c)),
            },
          };
          rpcCall(ctx, 'config.save', patch)
            .then((result) => { if (result?.config && alive.current) setConfig(result.config); })
            .catch(() => { /* 静默：下一次绑定操作会再次触发保存 */ });
        } catch { /* 忽略 */ }
      };

      // 关闭发送测试弹窗前，把当前弹窗内的变量输入与选项按钮内容一次性批量写回变量库，
      // 保证「点击外部退出 / 取消按钮」两种关闭方式都不会丢失最后一次编辑。
      const flushPickerMocks = () => {        if (!picker) return;
        const p = picker;
        const sets = [];
        for (const [name, value] of Object.entries(p.customVars ?? {})) sets.push([name, value]);
        const optVars = Array.isArray(p.card?.variables?.optionVars) ? p.card.variables.optionVars : [];
        // 关闭弹窗写回 mock 时：按钮自身始终写回；回传内容只写回「显式配置的绑定变量」，
        // 与「编辑页没配置绑定就不联动」保持一致（发送写值仍走识别回退，保证回调有值）。
        const allVars = [...(config?.templateVariables ?? []), ...(config?.customVariables ?? [])];
        (Array.isArray(p.data?.options) ? p.data.options : []).forEach((row, i) => {
          if (!optVars[i]) return;
          const text = String(row?.text ?? '');
          const value = String(row?.value ?? '');
          const def = allVars.find((v) => v.name === optVars[i]);
          const bound = def?.bindVar && def.bindVar !== optVars[i] ? def.bindVar : '';
          sets.push([optVars[i], { text, value }]);
          if (bound) sets.push([bound, value]);
        });
        if (sets.length === 0) return;
        const patch = { config: { ...config } };
        let changed = false;
        for (const [name, value] of sets) {
          const apply = (key, base) => {
            const list = (base ?? []).map((v) => (v.name === name ? { ...v, mock: value } : v));
            if (!changed && list.some((v, i) => v.mock !== (base ?? [])[i]?.mock)) changed = true;
            return list;
          };
          patch.config.templateVariables = apply('templateVariables', patch.config.templateVariables);
          patch.config.customVariables = apply('customVariables', patch.config.customVariables);
          patch.config.cards = (patch.config.cards ?? []).map((c) => {
            const list = apply('customVariables', c.customVariables);
            return list.some((v, i) => v.mock !== (c.customVariables ?? [])[i]?.mock) ? { ...c, customVariables: list } : c;
          });
        }
        if (!changed) return;
        if (mockSyncTimer.current) clearTimeout(mockSyncTimer.current);
        void (async () => {
          try {
            const result = await rpcCall(ctx, 'config.save', patch);
            if (result?.config && alive.current) setConfig(result.config);
          } catch { /* 静默 */ }
        })();
      };
      const closePicker = () => { flushPickerMocks(); setPicker(null); };

      const saveConfigWith = async (cards) => {
        const value = await rpcCall(ctx, 'config.save', { config: { ...config, cards } });
        if (value?.config && alive.current) setConfig(value.config);
        return value?.config;
      };

      const saveConfig = () => run('保存', async () => {
        const value = await rpcCall(ctx, 'config.save', { config });
        if (value?.config) setConfig(value.config);
        return '已保存';
      });

      // 变量集：每次添加/编辑/删除即时持久化到 config（模板变量 + 自定义变量）。
      const saveVariables = (patch) => run('保存变量集', async () => {
        const value = await rpcCall(ctx, 'config.save', { config: { ...config, ...patch } });
        if (value?.config && alive.current) setConfig(value.config);
        return '变量集已保存';
      });

      const saveSidebar = () => run('保存侧边栏入口', async () => {
        const value = await rpcCall(ctx, 'sidebar-entry.set', { mode: sidebarMode });
        if (value && alive.current) {
          setSidebarMode(value.mode);
          setSidebarVisible(value.visible !== false);
        }
        setSidebarModal(false);
        return '侧边栏入口已保存';
      });

      const openEdit = (card) => {
        setDraft(clone(card));
        setTab('editor');
      };
      const saveDraft = () => run('保存卡片', async () => {        const cards = [...(config.cards ?? [])];
        const index = cards.findIndex((card) => card.id === draft.id);
        if (index >= 0) cards[index] = draft;
        else cards.push(draft);
        await saveConfigWith(cards);
        setDraft(null);
        setTab('cards');
        return '卡片已保存';
      });
      const deleteCard = (card) => setDelCard(card);
      const confirmDeleteCard = () => {
        if (!delCard) return;
        void run('删除卡片', async () => {
          const cards = (config.cards ?? []).filter((item) => item.id !== delCard.id);
          await saveConfigWith(cards);
          setDelCard(null);
          return '卡片已删除';
        });
      };
      const duplicateCard = (card) => run('复制卡片', async () => {
        const copy = {
          ...clone(card),
          id: `card_${Math.random().toString(36).slice(2, 10)}`,
          name: `${card.name} 副本`,
          templateId: '',
        };
        await saveConfigWith([...(config.cards ?? []), copy]);
        return '卡片已复制';
      });
      const bindCard = (cardId, templateId) => run('保存模板 ID', async () => {
        const cards = (config.cards ?? []).map((card) => (card.id === cardId ? { ...card, templateId } : card));
        await saveConfigWith(cards);
        return templateId ? '模板 ID 已绑定' : '模板 ID 已清空';
      });
      const exportCard = (card) => run('导出卡片', async () => {
        const value = await rpcCall(ctx, 'cards.export', { id: card.id });
        downloadJson(value.fileName, value.template);
        return `已导出 ${value.fileName}`;
      });
      const updateDraftJson = (source, baseName) => run('更新模板 JSON', async () => {
        const value = await rpcCall(ctx, 'card.import', { json: source, name: baseName || undefined });
        const card = value?.card;
        if (!card) throw new Error('JSON 解析失败。');
        setDraft((prev) => ({ ...card, id: prev?.id ?? card.id }));
        return `已用新 JSON 更新模板绑定，点击「保存卡片」后生效。`;
      });
      const importFromJson = (source, baseName) => run('导入模板 JSON', async () => {
        const value = await rpcCall(ctx, 'card.import', { json: source, name: baseName || undefined });
        const card = value?.card;
        if (!card) throw new Error('导入没有返回卡片。');
        const cards = [...(config.cards ?? [])];
        // 同名卡片视为同一模板：更新旧卡（保留原 id），避免重复导入产生同名新卡。
        const existingIndex = cards.findIndex((item) => item.name === card.name);
        if (existingIndex >= 0) {
          cards[existingIndex] = { ...cards[existingIndex], ...card, id: cards[existingIndex].id };
        } else {
          cards.push(card);
        }
        await saveConfigWith(cards);
        // 选项按钮变量同步进变量集（config.customVariables）：
        // 文案变量为「按钮」类型（带 {text,value} Mock），回传内容变量为普通文本；
        // 与发送测试弹窗的选项按钮区块双向绑定，变量集页面可直接编辑。
        let dupCount = 0;
        try {
          const optVars = Array.isArray(card.variables?.optionVars) ? card.variables.optionVars : [];
          const optValueVars = Array.isArray(card.variables?.optionValueVars) ? card.variables.optionValueVars : [];
          if (optVars.length > 0 || optValueVars.length > 0) {
            const cv = Array.isArray(config.customVariables) ? config.customVariables : [];
            // 跨列表查重：模板变量（标准集）+ 自定义变量 + 各卡片变量全部纳入，
            // 避免导入后变量名重复（同名已存在即跳过，不重复添加）。
            const has = new Set([
              ...(Array.isArray(config.templateVariables) ? config.templateVariables : []),
              ...cv,
              ...(Array.isArray(config.cards) ? config.cards : []).flatMap((c) => (Array.isArray(c.customVariables) ? c.customVariables : [])),
            ].map((v) => v?.name).filter(Boolean));
            const cardMock = new Map((Array.isArray(card.customVariables) ? card.customVariables : []).map((v) => [v.name, v.value]));
            const add = [];
            for (const n of optVars) {
              if (!n) continue;
              if (has.has(n)) { dupCount += 1; continue; }
              const mock = cardMock.get(n);
              const def = card.customVariables?.find?.((v) => v.name === n);
              add.push({
                name: n,
                type: 'button',
                // 自动配对回传变量（用户后续可在变量集手动改绑）。
                bindVar: (def?.bindVar || optValueVars[optVars.indexOf(n)] || ''),
                desc: '选项按钮：点击按钮回传其回传内容变量',
                value: mock !== undefined ? mock : { text: '', value: '' },
              });
            }
            for (const n of optValueVars) {
              if (!n) continue;
              if (has.has(n)) { dupCount += 1; continue; }
              const mock = cardMock.get(n);
              add.push({ name: n, type: 'string', desc: '选项按钮回传内容（显示在按钮旁）', value: mock !== undefined ? mock : '' });
            }
            if (add.length > 0) {
              const value = await rpcCall(ctx, 'config.save', { config: { ...config, cards, customVariables: [...cv, ...add] } });
              if (value?.config && alive.current) setConfig(value.config);
            }
          }
        } catch { /* 变量集同步失败不影响导入主流程 */ }
        setImportBox(false);
        setDraft(card);
        setTab('editor');
        return `已导入「${card.name}」${existingIndex >= 0 ? '，同名卡片已更新绑定' : '，可在编辑器中继续修改'}${dupCount > 0 ? `；${dupCount} 个变量在变量集中已存在（同名），已跳过不重复添加` : ''}`;
      });
      // 发送/预览只处理「模板 JSON 声明 ∩ 变量库定义」的交集变量（与 PickerModal 左侧一致）。
      const hitVarNames = (card) => {
        try {
          const raw = typeof card?.sourceJson === 'string' ? JSON.parse(card.sourceJson) : card?.sourceJson;
          const editor = raw?.editorData && typeof raw.editorData === 'string' ? JSON.parse(raw.editorData) : raw;
          const list = Array.isArray(editor?.variableList) ? editor.variableList : (Array.isArray(raw?.variableList) ? raw.variableList : []);
          const declared = new Set(list.map((v) => (typeof v?.name === 'string' ? v.name : (v?.varKey ?? ''))).filter(Boolean));
          const defined = new Set([...(config?.templateVariables ?? []), ...(config?.customVariables ?? [])].map((v) => v.name));
          return new Set([...declared].filter((name) => defined.has(name)));
        } catch { return null; }
      };
      const reloadChats = (card, data, customVars, { silent = false } = {}) => {
        const globalVars = config?.customVariables ?? [];
        const templateVars = config?.templateVariables ?? [];
        const base = { type: 'test', card, data, customVars, globalVars, templateVars, selected: new Set() };
        // 静默刷新（自动轮询）：不动已有列表、勾选与编辑内容，只在数据回来后就地更新。
        if (!silent) setPicker({ ...base, chats: null, loading: true, error: '' });
        void (async () => {
          try {
            const value = await rpcCall(ctx, 'chat.list', {}, AbortSignal.timeout(15_000));
            const chats = (value?.chats ?? []).filter((chat) => card.type !== 'ceiling' || chat.kind === 'user');
            if (!alive.current) return;
            if (silent) {
              setPicker((prev) => (prev && prev.card?.id === card.id ? { ...prev, chats, loading: false, error: '' } : prev));
            } else {
              setPicker({ ...base, chats, loading: false, error: '' });
            }
          } catch (error) {
            if (!alive.current) return;
            const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
              ? '加载会话超时，请检查 DSH 连接后重试。'
              : (error?.message ?? String(error));
            if (silent) {
              // 静默失败：已有一份可用列表就保持原样（并保留上一次的错误态），列表为空时才提示。
              setPicker((prev) => (prev && prev.card?.id === card.id && (!prev.chats || prev.chats.length === 0)
                ? { ...prev, loading: false, error: message }
                : prev));
            } else {
              setPicker({ ...base, chats: [], loading: false, error: message });
            }
          }
        })();
      };
      const testCard = (card) => {
        const saved = lastTestRef.current[card.id];
        const designOptions = Array.isArray(card.design?.options) ? card.design.options : [];
        const optionVars = Array.isArray(card.variables?.optionVars) ? card.variables.optionVars : [];
        // 有效回传变量：优先取按钮变量在变量集的「绑定变量」配置，未配置回退导入识别结果。
        const allVars = [...(config?.templateVariables ?? []), ...(config?.customVariables ?? [])];
        const optionValueVars = optionVars.length > 0
          ? optionVars.map((name, i) => {
            const def = allVars.find((v) => v.name === name);
            return (def?.bindVar && def.bindVar !== name) ? def.bindVar : ((card.variables?.optionValueVars ?? [])[i] ?? '');
          })
          : (Array.isArray(card.variables?.optionValueVars) ? card.variables.optionValueVars : []);
        const fallbackOptions = designOptions.length > 0
          ? designOptions.map((opt) => (typeof opt === 'string' ? { text: opt, value: opt } : { text: String(opt?.label ?? opt?.text ?? opt?.value ?? ''), value: String(opt?.value ?? opt?.label ?? opt?.text ?? '') }))
          : [{ text: '选项 A', value: '选项 A' }, { text: '选项 B', value: '选项 B' }];
        // 选项行内容来自变量库 optionN 的 mock（双向绑定）：兼容对象 / 字符串 / 数组格式。
        const optMockFor = (name) => {
          const def = [
            ...(config?.templateVariables ?? []),
            ...(config?.customVariables ?? []),
            ...(card.customVariables ?? []),
          ].find((v) => v.name === name);
          return def?.mock;
        };
        const parseOptMock = (mock) => {
          if (mock && typeof mock === 'object' && !Array.isArray(mock)) return { text: String(mock.text ?? mock.label ?? mock.value ?? ''), value: String(mock.value ?? mock.text ?? mock.label ?? '') };
          return null;
        };
        const options = optionVars.length > 0
          ? optionVars.map((name, i) => {
            const m = optMockFor(name);
            const parsed = parseOptMock(m);
            let row;
            if (parsed) {
              row = parsed;
            } else if (typeof m === 'string' && m.trim()) {
              // 兼容旧数据：字符串 mock 升级为 {text,value} 对象并立即写回变量库，
              // 使选项按钮两列（按钮文案 / 回传值）与变量集 mock 格式统一、双向一致。
              row = { text: m, value: m };
              syncVarMockToLibrary(name, row, true);
            } else if (Array.isArray(m)) {
              const item = m[i];
              row = (item && typeof item === 'object')
                ? { text: String(item.text ?? item.label ?? ''), value: String(item.value ?? item.text ?? '') }
                : (typeof item === 'string' && item.trim() ? { text: item, value: item } : null);
            } else {
              row = null;
            }
            if (!row) row = fallbackOptions[i] ?? { text: '', value: '' };
            // 成组模板（btnsA ↔ btnsAvalue）：回传内容以回传变量 mock 为权威值。
            const valueVar = optionValueVars[i];
            if (valueVar) {
              const vm = optMockFor(valueVar);
              if (vm !== undefined && vm !== null) {
                row = { text: row.text, value: typeof vm === 'object' && !Array.isArray(vm) ? String(vm.value ?? vm.text ?? '') : String(vm) };
              }
            }
            return row;
          })
          : [];
        // options 始终取变量库 mock 解析值（双向绑定）；标题等数据字段保留上次设置。
        const data = {
          ...(saved?.data ?? {
            title: `测试：${card.name}`,
            subtitle: '',
            content: '这是一张来自 dsh-ding-card 的测试卡片。',
            fields: '',
            image: '',
            state: '测试卡片',
          }),
          options,
        };
        // Mock 为权威默认值：每次打开都以变量库当前 mock 为初始值，
        // 发送测试中输入的内容会实时回写变量库 mock，保证双向一致。
        const customVars = Object.fromEntries([
          ...(card.customVariables ?? []).map((v) => [v.name, v.mock ?? v.value ?? '']),
          ...(config?.templateVariables ?? []).map((v) => [v.name, v.mock]),
          ...(config?.customVariables ?? []).map((v) => [v.name, v.mock]),
        ].filter(([, value]) => value !== undefined));
        reloadChats(card, data, customVars);
      };
      const sendTestToSelected = () => run('发送测试卡片', async () => {
        const ids = [...(picker?.selected ?? [])];
        const byKey = new Map((picker?.chats ?? []).map((chat) => [chatKey(chat), chat]));
        let sent = 0;
        const sentTo = [];
        const warnings = [];
        const data = { ...(picker?.data ?? {}) };
        // 只发送交集变量对应的字段，与左侧控件、效果预览保持一致。
        const hit = hitVarNames(picker?.card);
        if (hit) {
          for (const key of ['title', 'subtitle', 'content', 'fields', 'image', 'state']) {
            if (!hit.has(key)) delete data[key];
          }
        }
        if (Array.isArray(data.options)) {
          data.options = data.options.filter((opt) => String(opt?.text ?? opt ?? '').trim());
        }
        // 有效回传变量（bindVar 优先）随发送数据传给 export，覆盖导入识别结果：
        // 用户在变量集改绑后，点击按钮回传的内容写入新绑定的文本变量。
        {
          const oVars = Array.isArray(picker?.card?.variables?.optionVars) ? picker.card.variables.optionVars : [];
          if (oVars.length > 0) {
            const allVars = [...(config?.templateVariables ?? []), ...(config?.customVariables ?? [])];
            data.optionValueVars = oVars.map((name, i) => {
              const def = allVars.find((v) => v.name === name);
              return (def?.bindVar && def.bindVar !== name) ? def.bindVar : ((picker?.card?.variables?.optionValueVars ?? [])[i] ?? '');
            });
          }
        }
        if (typeof data.fields === 'string' && data.fields.trim()) {
          try {
            const parsed = JSON.parse(data.fields);
            if (Array.isArray(parsed)) data.fields = parsed;
          } catch { /* 保留文本格式（标签：值 多行） */ }
        }
        if (picker?.customVars && Object.keys(picker.customVars).length > 0) {
          data.variables = Object.fromEntries(
            Object.entries(picker.customVars).filter(([key, value]) => {
              if (value === '' || value === null || value === undefined) return false;
              if (hit && !hit.has(key)) return false;
              return true;
            }),
          );
        }
        for (const key of ids) {
          const chat = byKey.get(key);
          if (!chat) continue;
          const result = await rpcCall(ctx, 'card.test', {
            cardId: picker.card.id,
            target: chat.kind === 'user' ? { kind: 'user', userId: chat.userId } : { kind: 'group', openConversationId: chat.openConversationId },
            data,
          });
          if (result?.warning) warnings.push(`${chatLabel(chat)}：${result.warning}`);
          sent += 1;
          sentTo.push(chatLabel(chat));
        }
        setPicker(null);
        const base = `测试卡片已发送到 ${sent} 个会话${sentTo.length ? `（${sentTo.join('、')}）` : ''}`;
        return warnings.length ? `${base}；${warnings.join('；')}` : base;
      });

      // 发送成功关闭弹窗前同样 flush 一次，避免防抖窗口内的最后一次编辑丢失。
      const sendAndClose = () => sendTestToSelected().then(() => flushPickerMocks());

      // 更新横幅文案：按本机识别出的安装环境说明将用哪条命令、装到哪个 profile。
      const updateEnv = versionInfo.env ?? null;
      const updateTailText = versionInfo.linkMode
        ? '当前是本地开发链接（junction / --link），插件不会替换开发目录；请更新工作树后重启 DSH。'
        : updateEnv?.blocker
          ? ` ${updateEnv.blocker}。`
          : updateEnv?.cli
            ? ` 本机将用 ${updateEnv.cli === 'dsh' ? 'dsh plugin' : updateEnv.cli} ${updateEnv.mode === 'update' ? '原地刷新' : `安装 ${versionInfo.latest}`} 到 ${updateEnv.profile ?? versionInfo.profile ?? '当前'} profile。`
            : ' 未检测到 dsh / pnpm / npm，请复制命令到终端手工执行。';

      return h('div', { className: 'ddc-page' },
        h('div', { className: 'ddc-pageTop' },
          h('div', { className: 'ddc-shell' },
            h('header', { className: 'ddc-header' },
              h('div', { className: 'ddc-brand' },
                h('h1', null, '钉卡片', (versionInfo.profile ?? status?.dshim?.profile) ? h('span', {
                  className: 'ddc-envBadge',
                  'data-env': versionInfo.profile ?? status?.dshim?.profile,
                  title: `当前环境：${versionInfo.profile ?? status?.dshim?.profile} profile（安装、更新与数据均按该环境隔离）`,
                }, versionInfo.profile ?? status?.dshim?.profile) : null, h('span', {
                  className: 'ddc-version' + (versionInfo.updateAvailable ? ' ddc-versionNew' : ''),
                  title: versionInfo.checking ? '正在检查更新…'
                    : versionInfo.updateAvailable ? `发现新版本 ${versionInfo.latest}，点击一键更新`
                    : versionInfo.error ? '版本检查失败，点击重试'
                    : '已是最新版本，点击检查更新',
                  onClick: () => {
                    if (updateState.applying) return;
                    if (versionInfo.updateAvailable) void applyUpdate();
                    else void checkVersion();
                  },
                }, versionInfo.updateAvailable ? `${versionInfo.current} ↑ ${versionInfo.latest}` : versionInfo.checking ? `${versionInfo.current}…` : versionInfo.current)),
                h('p', null, '设计钉钉卡片、绑定模板，并让 Agent 在对话中选择使用')),
              h('div', { className: 'ddc-actions' },
                status?.dshim?.installed
                  ? h(StatusPill, { tone: 'success' }, 'dsh-im 已就绪')
                  : h(StatusPill, { tone: 'warning' }, '等待 dsh-im'),
                h('button', { type: 'button', className: 'ddc-button', disabled: busy, onClick: () => { void refresh(); } }, '刷新'),
                h('button', {
                  type: 'button', className: 'ddc-button ddc-iconButton', title: '通用设计',
                  disabled: busy, onClick: () => setSidebarModal(true), 'aria-label': '通用设计',
                },
                h('svg', { width: '14', height: '14', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
                  h('circle', { cx: 8, cy: 8, r: 2.4 }),
                  h('path', { d: 'M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4' }))))),
            error ? h('div', { className: 'ddc-notice', 'data-tone': 'error' }, error) : null,
            notice ? h('div', { className: 'ddc-notice' }, notice) : null,
            versionInfo.updateAvailable ? h('div', { className: 'ddc-updateBanner' },
              h('span', null,
                '发现新版本 ', h('strong', null, versionInfo.latest),
                `（当前 ${versionInfo.current}）。`,
                updateState.applying ? ' 正在安装…' : updateTailText),
              h('div', { className: 'ddc-updateBannerActions' },
                h('button', {
                  type: 'button', className: 'ddc-button ddc-buttonSmall ddc-buttonPrimary',
                  disabled: updateState.applying || Boolean(updateEnv?.blocker) || versionInfo.linkMode,
                  title: updateEnv?.blocker ?? '用本机识别出的安装命令更新到最新版本',
                  onClick: () => { void applyUpdate(); },
                }, updateState.applying ? '更新中…' : '立即更新'),
                h('button', {
                  type: 'button', className: 'ddc-button ddc-buttonSmall',
                  disabled: !(versionInfo.command || updateEnv?.command),
                  title: '复制这条更新命令，可在终端粘贴执行',
                  onClick: () => { void copyUpdateCommand(); },
                }, '复制命令'))) : null,
            restartPrompt ? h('div', { className: 'ddc-updateBanner' },
              restartPrompt.message,
              restartPrompt.command ? h('code', null, restartPrompt.command) : null,
              restartPrompt.kind === 'desktop'
                ? h('button', { type: 'button', className: 'ddc-button', onClick: () => { void restartDsh(); } }, '立即重启 DSH')
                : null,
              h('button', { type: 'button', className: 'ddc-button', onClick: () => setRestartPrompt(null) }, restartPrompt.kind === 'desktop' ? '稍后' : '知道了')) : null,
            tab !== 'editor'
              ? h('nav', { className: 'ddc-tabs', role: 'tablist' },
                [['overview', '概览'], ['cards', '卡片'], ['interactions', '交互'], ['logs', '日志'], ['variables', '变量集']].map(([id, label]) => h('button', {
                  key: id, type: 'button', role: 'tab', className: 'ddc-tab', 'aria-selected': tab === id,
                  onClick: () => setTab(id),
                }, label)))
              : null)),
        h('div', { className: 'ddc-pageBody' },
          h('div', { className: 'ddc-shell' },
            tab === 'overview'
              ? h(Overview, {
                status, busy,
                onRefresh: () => { void refresh(); },
                onCheckBot: () => run('校验凭据', async () => {
                  const value = await rpcCall(ctx, 'bot.check');
                  return `凭据校验通过：${value?.clientId ?? ''}`;
                }),
                onInstall: () => run('安装 dsh-im', async () => {
                  const value = await rpcCall(ctx, 'dshim.install');
                  if (value?.manual) return value.message ?? '请用命令安装 dsh-im';
                  return 'dsh-im 已安装；请重启 DSH 后继续';
                }),
                onOpenCards: () => setTab('cards'),
              })
              : tab === 'cards'
                ? h(CardsTab, {
                  config, busy,
                  onEdit: openEdit,
                  onDelete: deleteCard,
                  onDuplicate: (card) => { void duplicateCard(card); },
                  onBind: (cardId, templateId) => { void bindCard(cardId, templateId); },
                  onTest: (card) => { void testCard(card); },
                  onImport: () => setImportBox(true),
                })
                : tab === 'editor'
                  ? h(CardEditor, {
                    draft: draft ?? newCard(),
                    busy,
                    onChange: setDraft,
                    onCancel: () => { setDraft(null); setTab('cards'); },
                    onSave: () => { void saveDraft(); },
                    onUpdateJson: (source, baseName) => { void updateDraftJson(source, baseName); },
                  })
                  : tab === 'interactions'
                    ? h(InteractionTab, {
                      config, cards: config?.cards, busy,
                      onChange: autosaveInteractions,
                    })
                    : tab === 'logs'
                      ? h(LogsTab, {
                        status, busy,
                        onRefresh: () => { void refresh(); },
                        onClear: () => run('清空日志', async () => {
                          await rpcCall(ctx, 'logs.clear');
                          return '日志已清空';
                        }),
                      })
                      : h(VariablesTab, {
                        config, busy,
                        onSave: saveVariables,
                      }),
            picker ? h(PickerModal, {
              picker,
              onSendSelected: sendAndClose,
              onCancel: closePicker,
              setPicker,
              onReload: () => reloadChats(picker.card, picker.data, picker.customVars),
              onAutoReload: () => reloadChats(picker.card, picker.data, picker.customVars, { silent: true }),
              onDataChange: (data, customVars) => { lastTestRef.current[picker.card.id] = { data, customVars }; },
              onVarMockSync: syncVarMockToLibrary,
              onVarOrderChange: persistVarOrder,
              onAudioBind: persistAudioBind,
            }) : null,
            importBox ? h(ImportModal, { busy, onCancel: () => setImportBox(false), onImport: (source, fileName) => { void importFromJson(source, fileName); } }) : null,
            sidebarModal ? h(SidebarModal, {
              mode: sidebarMode, busy,
              onChange: setSidebarMode,
              onSave: () => { void saveSidebar(); },
              onClose: () => setSidebarModal(false),
            }) : null,
            delCard ? h(DeleteConfirmModal, {
              title: '删除卡片',
              name: delCard.name,
              source: 'card',
              busy,
              desc: ['确定要删除卡片 ', h('strong', { className: 'ddc-delName' }, delCard.name), ' 吗？此操作不可撤销，关联的模板绑定与测试记录将一并移除。'],
              onConfirm: confirmDeleteCard,
              onCancel: () => setDelCard(null),
            }) : null)));
    }

    function DingCardPluginPage({ ctx }) {
      return h('div', { className: 'ddc-pluginPage' }, h(DingCardPage, { ctx }));
    }

    function OpenDingCardAction({ subject, packageName, onOpen, t }) {
      if (subject?.kind !== 'bundle' && subject?.kind !== 'row') return null;
      if (subject.pkg?.name !== packageName) return null;
      if (subject.kind === 'row' && subject.row?.moduleName !== packageName) return null;
      return h('button', { type: 'button', className: 'ddc-pluginOpen', onClick: onOpen }, t('打开钉卡片'));
    }

    function SidebarIcon({ size }) {
      if (!sidebarVisible) return null;
      return h('svg', {
        className: 'ddc-sidebarIcon', 'aria-hidden': true, focusable: false,
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
      h('path', { d: 'M4 6h8M4 9h5' }),
      h('circle', { cx: 11.5, cy: 9, r: 1.2, fill: 'currentColor', stroke: 'none' }));
    }

    exports.name = 'dsh-ding-card';
    exports.inject = ['slots', 'connection', 'locale'];

    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-ding-card: locale');
      const t = ctx.locale.bind(NAMESPACE);
      const disposers = [installStyles()];

      let panelRegistered = false;
      let stopSidebar = null;
      let stopActions = null;
      let pageCtxRef = null;
      // 根据 sidebarVisible 动态注册/注销侧边栏入口：隐藏时整个「钉卡片」条目消失，而非仅隐藏图标。
      syncSidebarFn = () => {
        const pc = pageCtxRef;
        if (!pc) return;
        if (sidebarVisible) {
          if (!stopSidebar) {
            stopSidebar = pc.slots.inject('sidebar.panellist', () => (
              pc.slots.register({
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 11,
                label: () => t('钉卡片'),
                locale: NAMESPACE,
              }, SidebarIcon)
            ));
          }
        } else if (stopSidebar) {
          stopSidebar();
          stopSidebar = null;
        }
      };
      if (typeof ctx.inject === 'function') {
        ctx.inject(['layout'], (pageCtx) => {
          pageCtxRef = pageCtx;
          const panels = pageCtx.slots.inject('main', () => {
            const unregisterPage = pageCtx.slots.register({
              name: 'main',
              key: PANEL_ID,
              locale: NAMESPACE,
              inject: () => ({ ctx }),
            }, DingCardPluginPage);
            panelRegistered = true;
            syncSidebarFn();
            stopActions = pageCtx.slots.inject('plugins.detail.actions', () => (
              pageCtx.slots.register({
                name: 'plugins.detail.actions',
                id: 'dsh-ding-card-open',
                order: 21,
                locale: NAMESPACE,
                inject: () => ({
                  packageName: 'dsh-ding-card',
                  onOpen: () => pageCtx.layout.selectPanel(PANEL_ID),
                }),
              }, OpenDingCardAction)
            ));
            return () => {
              panelRegistered = false;
              stopActions?.();
              stopSidebar?.();
              stopSidebar = null;
              unregisterPage();
            };
          });
          disposers.push(() => panels());
        });
      }

      // 挂进 DSH 全局设置页：左侧出现「钉卡片」入口，右侧渲染完整的钉卡片管理页。
      if (typeof ctx.slots?.inject === 'function' && typeof ctx.slots.register === 'function') {
        const stopSettings = ctx.slots.inject('settings.section', () => {
          const unregister = ctx.slots.register({
            name: 'settings.section',
            id: PANEL_ID,
            order: 22,
            label: () => t('钉卡片'),
            locale: NAMESPACE,
            inject: () => ({ ctx }),
          }, DingCardPluginPage);
          return () => unregister();
        });
        disposers.push(() => stopSettings?.());
      }

      if (typeof ctx.provide === 'function') {
        ctx.provide('dshDingCardClient', Object.freeze({
          version: 1,
          render: () => h(DingCardPage, { ctx }),
          selectPanel: () => ctx.get?.('layout')?.selectPanel?.(PANEL_ID),
          panelRegistered: () => panelRegistered,
        }));
      }

      ctx.effect(() => () => {
        for (const dispose of disposers.reverse()) {
          try { dispose(); } catch { /* ignore */ }
        }
      }, 'dsh-ding-card: client styles and panel');
    };

    exports.__internals = {
      DingCardPage,
      Overview,
      CardsTab,
      CardEditor,
      CardPreview,
      InteractionTab,
      LogsTab,
      VariablesTab,
      CardListItem,
    };

    return module.exports;
  },
});
