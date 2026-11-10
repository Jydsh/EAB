'use strict';
/* dsh-mrrp client bundle：MRRP 控制台（模型分类 / 角色部门 / 用户）。
   __ModuleLoader__ 格式，与 dsh-ding-card 的 client 打包方式一致。
   全部元素用 h()（React.createElement）手写，无 JSX。样式注入 <style>，跟随 DSH 浅色主题变量。 */
window.__ModuleLoader__.load({
  id: 'dsh-mrrp',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback, useRef } = React;

    const PLUGIN_VERSION = '2026.11.07';
    const NAMESPACE = 'dsh-mrrp';
    const PANEL_ID = 'dsh-mrrp';
    const CHANNEL = 'mrrp';

    // 本插件的 RPC 通道：控制台所有读写都通过它，绝不触碰 DSH 主链路。
    async function rpcCall(ctx, method, payload = {}, signal) {
      const result = await ctx.connection.rpc.call('/api', CHANNEL, { method, payload }, signal);
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

    const zh = { MRRP: 'MRRP', '模型路由控制台': '模型路由控制台', '打开 MRRP': '打开 MRRP' };
    const en = { MRRP: 'MRRP', '模型路由控制台': 'Model Routing Console', '打开 MRRP': 'Open MRRP' };

    /* ============================== 图标（文本字符优先 + 已验证的纯背景 CSS 形状） ============================== */
    // 重要：DSH 宿主不渲染插件内联 SVG（钉卡片同款写法同样空白，现场截图证实宿主侧边栏钉卡片也无图标）。
    // 现场逐项验证结论：
    //   · 纯 background / box-shadow 画的 CSS 形状（+、三层、三横、人）→ 渲染正常；
    //   · 用 transform 旋转或 border 三角/描边画的形状（编辑铅笔、垃圾桶、关闭 ×、齿轮、箭头）→ 全部空白；
    //   · 特殊 Unicode 字形（⚙ ✎ ↻ ●）在宿主字体栈下同样渲染为空框（现场截图证实）。
    // 因此：能画成纯背景/阴影形状的保留 CSS；其余一律改用通用文本字符（× « » √ → ▼ ▶ ⌂ 均为
    // Windows 中文字体栈内字符），行内操作按钮直接用中文文字（编辑/删除/设置）。
    const ico = (cls, ch) => (p) => {
      const s = (p && p.size) || 16;
      return h('span', {
        className: 'mrrp-ico ' + cls,
        'aria-hidden': 'true',
        style: { width: s + 'px', height: s + 'px', fontSize: s + 'px', lineHeight: '1' },
      }, ch == null ? null : ch);
    };
    const IconX = ico('ico-x', '×');
    const IconPlus = ico('ico-plus');
    const IconSettings = ico('ico-settings');
    const IconCollapse = ico('ico-collapse', '«');
    const IconExpand = ico('ico-expand', '»');
    const IconChevronDown = ico('ico-down', '▼');
    const IconChevronRight = ico('ico-right', '▶');
    const IconCheck = ico('ico-check', '√');
    const IconSearch = ico('ico-search');
    const IconTrash = ico('ico-trash');
    const IconEdit = ico('ico-edit');
    const IconRefresh = ico('ico-refresh');
    const IconLink = ico('ico-link');
    const IconDot = ico('ico-dot');
    const IconNavCategories = ico('ico-navLayers');
    const IconNavRoles = ico('ico-navPerson');
    const IconNavUsers = ico('ico-navPerson');
    const IconNavRoute = ico('ico-navRoute');
    const IconNavDecision = ico('ico-navDecision');
    const IconNavModels = ico('ico-navList');
    const IconNavDept = ico('ico-navHome', '⌂');
    const IconNavLog = ico('ico-navList');
    // 权限图标：宿主字体栈下特殊字形会渲染成空框，这里用中文单字（已验证可渲染）
    const IconNavShield = ico('ico-navShield', '锁');

    /* ============================== 通用 UI 原语 ============================== */
    function Spinner({ size = 16 }) {
      return h('span', { className: 'mrrp-spinner', style: { width: size + 'px', height: size + 'px' } });
    }
    function Btn({ variant, size, disabled, onClick, title, className, children: propChildren }, extraChildren) {
      // 兼容两种调用形态：h(Btn, {..}, child) 走 props.children；直接 Btn({..}, child) 走第二实参。
      const children = propChildren !== undefined ? propChildren : extraChildren;
      const cls = ['mrrp-btn', variant && `mrrp-btn-${variant}`, size && `mrrp-btn-${size}`, className].filter(Boolean).join(' ');
      return h('button', { className: cls, disabled, onClick, title, type: 'button' }, children);
    }
    function IconBtn({ children: propChildren, onClick, title, disabled, danger }, extraChildren) {
      const children = propChildren !== undefined ? propChildren : extraChildren;
      const cls = ['mrrp-btn', 'mrrp-btn-icon', danger ? 'mrrp-btn-danger' : ''].filter(Boolean).join(' ');
      return h('button', { className: cls, onClick, title, disabled, type: 'button' }, children);
    }
    function Field({ label, hint, children }) {
      return h('label', { className: 'mrrp-field' },
        h('span', { className: 'mrrp-field-label' }, label, hint ? h(Tip, { text: hint }) : null),
        children);
    }
    /* hover 角标：? 图标 + 悬停气泡说明 */
    function Tip({ text, wide }) {
      return h('span', { className: 'mrrp-tip-wrap' + (wide ? ' is-wide' : '') },
        h('span', { className: 'mrrp-tip-ico' }, '?'),
        h('span', { className: 'mrrp-tip-bubble' }, text));
    }
    /* 确认弹窗：遮罩 + 卡片，危险操作确认/取消 */
    function ConfirmDialog({ open, title, desc, confirmText, onConfirm, onCancel }) {
      if (!open) return null;
      return h('div', { className: 'mrrp-modal-mask', onClick: onCancel },
        h('div', { className: 'mrrp-modal', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'mrrp-modal-title' }, title),
          desc ? h('div', { className: 'mrrp-modal-desc' }, desc) : null,
          h('div', { className: 'mrrp-modal-actions' },
            h(Btn, { size: 'small', onClick: onCancel }, '取消'),
            h(Btn, { variant: 'danger', size: 'small', onClick: onConfirm }, confirmText || '确认删除'))));
    }
    function Select({ value, onChange, options, placeholder, disabled, className }) {
      // 选中项文本可能很长（分类名），下拉框里会被截断，用 title 让悬浮可读全文
      const hit = options.find((opt) => (typeof opt === 'string' ? opt : opt.value) === value);
      const currentLabel = hit ? (typeof hit === 'string' ? hit : hit.label) : (placeholder || '');
      return h('select', {
        className: ['mrrp-select', className].filter(Boolean).join(' '),
        value, disabled,
        title: currentLabel || '',
        onChange: (e) => onChange && onChange(e.target.value),
      },
      placeholder ? h('option', { value: '' }, placeholder) : null,
      options.map((opt) => {
        if (typeof opt === 'string') return h('option', { key: opt, value: opt }, opt);
        return h('option', { key: opt.value, value: opt.value }, opt.label);
      }));
    }
    /* 模型画像编辑器：类型多选下拉 + 「其他」场景输入框。
     * 场景输入框与下拉菜单同高同款、行内并排；仅当下拉菜单展开且勾选「其他」时显示，
     * 下拉菜单收起时场景框一并收起。 */
    function ModelProfileEditor({ value, scene, onSceneChange, onChange, options, disabled, panelTitle }) {
      const [open, setOpen] = useState(false);
      const [panelBox, setPanelBox] = useState(null);
      const wrapRef = useRef(null);
      const inputRef = useRef(null);
      // 组件内自管选中：避免 React 渲染滞后时基于过期 value/闭包计算导致快速连点丢项；
      // 外部 value 变化（保存/重挂载/刷新）时再同步回来。
      const [localSel, setLocalSel] = useState((value || []).filter(Boolean));
      // 最近一次由本组件提交的列表：若当前 localSel 与之一致，说明变化来自本地交互，
      // 外部 value（可能滞后于 setRoute 生效）不得把它重置回旧值——否则出现「勾选后又变回不设置」。
      const lastEmittedRef = useRef((value || []).filter(Boolean));
      const sameList = (a, b) => a.length === b.length && a.every((v) => b.includes(v)) && b.every((v) => a.includes(v));
      useEffect(() => {
        const next = (value || []).filter(Boolean);
        setLocalSel((prev) => {
          // 本地刚提交过且内容未变：不追滞后 value，避免已勾选项被旧快照覆盖
          if (lastEmittedRef.current && sameList(prev, lastEmittedRef.current)) return prev;
          return sameList(prev, next) ? prev : next;
        });
      }, [value]);
      useEffect(() => {
        if (!open) return;
        const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
        // 面板用 fixed 定位，页面/容器一滚动就关掉，避免与锚点脱位
        const onScroll = (e) => {
          if (wrapRef.current && e.target instanceof Node && wrapRef.current.contains(e.target)) return;
          setOpen(false);
        };
        const onResize = () => setOpen(false);
        document.addEventListener('mousedown', onDown);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        return () => {
          document.removeEventListener('mousedown', onDown);
          window.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', onResize);
        };
      }, [open]);
      /* 展开面板：表格容器需要横向滚动（overflow-x: auto），absolute 浮层会被裁掉，
       * 所以面板改用 fixed 定位（不受祖先 overflow 影响），并按下/上方剩余空间自动选方向。 */
      const openPanel = () => {
        if (disabled) return;
        if (open) { setOpen(false); return; }
        const el = inputRef.current;
        if (el && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect();
          const gap = 6;
          const below = window.innerHeight - r.bottom - gap - 10;
          const above = r.top - gap - 10;
          const up = below < 180 && above > below;
          const room = Math.min(260, up ? above : below);
          setPanelBox({
            left: Math.round(r.left),
            width: Math.round(r.width),
            maxHeight: Math.max(120, Math.round(room)),
            ...(up ? { bottom: Math.round(window.innerHeight - r.top + gap) } : { top: Math.round(r.bottom + gap) }),
          });
        } else {
          setPanelBox(null);
        }
        setOpen(true);
      };
      const selected = localSel;
      const emit = (next) => {
        lastEmittedRef.current = next;
        if (onChange) onChange(next);
      };
      const toggle = (v) => {
        setLocalSel((prev) => {
          const next = prev.includes(v) ? prev.filter((t) => t !== v) : [...prev, v];
          emit(next);
          return next;
        });
      };
      const clearAll = () => {
        setLocalSel(() => { emit([]); return []; });
      };
      return h('div', { className: 'mrrp-profileEditor', ref: wrapRef },
        h('div', { className: ['mrrp-combobox mrrp-multiselect', open ? 'is-open' : ''].filter(Boolean).join(' ') },
          h('div', { className: 'mrrp-combobox-input', ref: inputRef, onClick: openPanel },
            selected.length
              ? h('span', { className: 'mrrp-multiTags', title: selected.join('、') },
                  selected.slice(0, 3).map((t) => h('span', { key: t, className: 'mrrp-multiTag', title: t }, t)),
                  selected.length > 3 ? h('span', { className: 'mrrp-multiMore', title: selected.slice(3).join('、') }, `+${selected.length - 3}`) : null)
              : h('span', { className: 'mrrp-combobox-placeholder' }, '不设置'),
            h('span', { className: 'mrrp-combobox-arrow' }, '▼')),
          open ? h('div', {
            className: 'mrrp-combobox-panel is-fixed',
            style: panelBox
              ? {
                  left: `${panelBox.left}px`,
                  width: `${panelBox.width}px`,
                  maxHeight: `${panelBox.maxHeight}px`,
                  top: panelBox.top === undefined ? undefined : `${panelBox.top}px`,
                  bottom: panelBox.bottom === undefined ? undefined : `${panelBox.bottom}px`,
                }
              : null,
          },
            h('div', { className: 'mrrp-multiPanelHead' },
              h('span', {}, panelTitle || '擅长类型（可多选）'),
              selected.length ? h('button', { type: 'button', className: 'mrrp-multiClear', onClick: clearAll }, '清空') : null),
            options.length
              ? options.map((o) => h('label', {
                  key: o.value,
                  className: ['mrrp-multiOption', selected.includes(o.value) ? 'is-checked' : ''].filter(Boolean).join(' '),
                },
                  h('input', { type: 'checkbox', checked: selected.includes(o.value), onChange: () => toggle(o.value) }),
                  h('span', { className: 'mrrp-multiOptionLabel' }, o.label)))
              : h('div', { className: 'mrrp-combobox-empty' }, '暂无可用决策模型提供方，请先到「决策模型配置」页新增')) : null),
        open && selected.includes('其他') ? h('input', {
          className: 'mrrp-profileScene',
          placeholder: '擅长场景',
          value: scene || '',
          onChange: (e) => onSceneChange && onSceneChange(e.target.value),
        }) : null);
    }
    function Toggle({ checked, onChange, label, desc, disabled }) {
      return h('label', { className: 'mrrp-toggle' },
        h('input', { type: 'checkbox', checked: !!checked, disabled, onChange: (e) => onChange && onChange(e.target.checked) }),
        h('span', { className: 'mrrp-toggle-track' }, h('span', { className: 'mrrp-toggle-thumb' })),
        (label || desc) ? h('span', { className: 'mrrp-toggle-text' },
          label ? h('span', {}, label) : null,
          desc ? h('small', {}, desc) : null) : null);
    }
    function Pill({ tone, children, title }) {
      return h('span', { className: `mrrp-pill${tone ? ` mrrp-pill-${tone}` : ''}`, title }, children);
    }
    function Empty({ icon, title, desc, children }) {
      return h('div', { className: 'mrrp-empty' },
        icon ? h('div', { className: 'mrrp-empty-icon' }, icon) : null,
        title ? h('div', { className: 'mrrp-empty-title' }, title) : null,
        desc ? h('div', { className: 'mrrp-empty-desc' }, desc) : null,
        children ? h('div', { className: 'mrrp-empty-action' }, children) : null);
    }
    function Card({ title, extra, children, className }) {
      return h('section', { className: ['mrrp-card', className].filter(Boolean).join(' ') },
        (title || extra) ? h('div', { className: 'mrrp-card-head' },
          title ? h('h3', {}, title) : h('span', {}),
          extra ? h('div', { className: 'mrrp-card-extra' }, extra) : null) : null,
        h('div', { className: 'mrrp-card-body' }, children));
    }
    function Modal({ title, onClose, children, footer, width = 460 }) {
      return h('div', { className: 'mrrp-modal-overlay', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose && onClose(); } },
        h('div', { className: 'mrrp-modal', style: { width } },
          h('div', { className: 'mrrp-modal-head' },
            h('h3', {}, title),
            IconBtn({ onClick: onClose, title: '关闭' }, h(IconX, { size: 16 }))),
          h('div', { className: 'mrrp-modal-body' }, children),
          footer ? h('div', { className: 'mrrp-modal-foot' }, footer) : null));
    }

    /* ============================== 数据工具 ============================== */
    function modelKey(m) { return m.key || `${m.provider}:${m.id}`; }
    function categoryOfModel(categories, key) {
      return (categories || []).find((c) => (c.modelIds || []).includes(key)) || null;
    }
    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    /* 默认类型/场景列表：与 host 默认一致，类型场景列表接口加载前先用它 */
    const DEFAULT_TYPE_SCENES = ['推理', '对话', '代码', '视觉', '长文本', '多模态', '工具调用', '快速', '其他'];

    /* ============================== Toast 系统 ============================== */
    function ToastStack({ toasts, onDismiss }) {
      return h('div', { className: 'mrrp-toasts' },
        (toasts || []).map((t) => h('div', { key: t.id, className: `mrrp-toast mrrp-toast-${t.tone || 'info'}` },
          h('span', { className: 'mrrp-toast-msg' }, t.message),
          IconBtn({ onClick: () => onDismiss(t.id), title: '关闭' }, h(IconX, { size: 14 })))));
    }

    /* ============================== 模型分类页 ============================== */
    /* ============================== 路由模型配置页 ============================== */
    const DECISION_ENDPOINTS = [
      { value: 'systemone', label: '判定协议 /v1/systemone' },
      { value: 'decisions', label: '0G 云端判定 /v1/decisions' },
    ];
    /* 服务类型：合并「接口格式+调用端点」，映射到内部 format+endpoint（config 零迁移）。 */
    const SERVICE_TYPES = [
      { value: 'laya', label: '本地判定服务（/v1/systemone）' },
      { value: 'cloud_decision', label: '云端判定服务（/v1/systemone）' },
      { value: 'chat', label: 'OpenAI 兼容对话判定（/chat/completions）' },
    ];
    function serviceTypeOf(p) {
      if (p.format === 'laya') return 'laya';
      if (p.endpoint === 'chat') return 'chat';
      return 'cloud_decision';
    }
    function serviceTypeLabel(p) {
      const item = SERVICE_TYPES.find((x) => x.value === serviceTypeOf(p));
      return item ? item.label.split('（')[0] : p.format;
    }
    function endpointLabel(p) {
      const item = DECISION_ENDPOINTS.find((x) => x.value === p.endpoint);
      return item ? item.label.split('（')[0] : (p.endpoint || '');
    }
    function friendlyTestErr(message) {
      return /timeout|aborted/i.test(message || '') ? '连接超时：服务推理可能较忙或未响应，请稍后重试。' : message;
    }
    function catName(list, id) {
      if (!id) return '';
      const item = (list || []).find((c) => c.id === id);
      return item ? item.name : '';
    }

    function DecisionProviderModal({ ctx, initial, onClose, onSaved }) {
      const [p, setP] = useState(initial);
      const [busy, setBusy] = useState(false);
      const [line, setLine] = useState(null);
      const [newName, setNewName] = useState('');
      const set = (key, value) => setP({ ...p, [key]: value });
      const current = () => ({ ...p, name: (p.name || '').trim(), baseUrl: (p.baseUrl || '').trim() });
      const save = async () => {
        if (!p.name.trim()) { setLine({ tone: 'error', text: '请填写提供方名称。' }); return; }
        if (!p.baseUrl.trim()) { setLine({ tone: 'error', text: '请填写 API 地址。' }); return; }
        setBusy(true);
        try {
          await rpcCall(ctx, 'decision.save', { provider: current() });
          onSaved();
        } catch (error) { setLine({ tone: 'error', text: error.message }); setBusy(false); }
      };
      const test = async () => {
        if (!p.baseUrl.trim()) { setLine({ tone: 'error', text: '请先填写 API 地址。' }); return; }
        setBusy(true); setLine(null);
        try {
          const r = await rpcCall(ctx, 'decision.test', { provider: current() });
          setLine({ tone: r.ok ? 'ok' : 'error', text: r.ok ? `连接成功（${r.latencyMs} ms）` : friendlyTestErr(r.message) });
        } catch (error) { setLine({ tone: 'error', text: friendlyTestErr(error.message) }); }
        finally { setBusy(false); }
      };
      const fetchNames = async () => {
        if (!p.baseUrl.trim()) { setLine({ tone: 'error', text: '请先填写 API 地址。' }); return; }
        setBusy(true); setLine(null);
        try {
          const r = await rpcCall(ctx, 'decision.fetch', { provider: current() });
          const names = (r.models || []).map((m) => m.id);
          setP({ ...p, modelNames: Array.from(new Set([...(p.modelNames || []), ...names])) });
          setLine({ tone: 'ok', text: r.manual ? '已填入判定服务内置模型名。' : `拉取到 ${names.length} 个模型。` });
        } catch (error) { setLine({ tone: 'error', text: error.message }); }
        finally { setBusy(false); }
      };
      const addName = () => {
        const t = newName.trim();
        if (!t) return;
        setP({ ...p, modelNames: Array.from(new Set([...(p.modelNames || []), t])) });
        setNewName('');
      };
      const removeName = (name) => setP({ ...p, modelNames: (p.modelNames || []).filter((x) => x !== name) });
      return h(Modal, {
        title: initial && initial.id ? '编辑决策模型提供方' : '新增决策模型提供方', onClose, width: 520,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose, disabled: busy }, '取消'),
          h(Btn, { onClick: test, disabled: busy }, busy ? h(Spinner, {}) : '测试连接'),
          h(Btn, { variant: 'primary', onClick: save, disabled: busy }, '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '提供方名称' }, h('input', { className: 'mrrp-input', value: p.name, autoFocus: true, onChange: (e) => set('name', e.target.value) })),
        h(Field, { label: '服务类型', hint: '本地判定服务=走判定协议 /v1/systemone 的本地服务（如 laya-server 或其它兼容框架）；云端判定服务=阿里云 MaaS / 0G 这类 /v1/systemone 判定端点；对话判定=普通大模型当判定器（llama.cpp / vLLM / 硅基流动等 OpenAI 兼容接口）' },
          h(Select, { value: serviceTypeOf(p), options: SERVICE_TYPES, onChange: (v) => setP((prev) => {
            const next = { ...prev };
            if (v === 'laya') { next.format = 'laya'; next.endpoint = next.endpoint === 'decisions' ? 'decisions' : 'systemone'; }
            else if (v === 'chat') { if (next.format === 'laya') next.format = 'openai'; next.endpoint = 'chat'; }
            else { if (next.format === 'laya') next.format = 'openai'; next.endpoint = next.endpoint === 'decisions' ? 'decisions' : 'systemone'; }
            return next;
          }) })),
        (serviceTypeOf(p) !== 'chat')
          ? h(Field, { label: '判定端点', hint: serviceTypeOf(p) === 'laya'
              ? '本地判定服务走 {地址}/v1/systemone；0G 云端走 {地址}/v1/decisions 并自动带 model: laya'
              : '云端判定端点：{地址}/v1/systemone（如阿里云 MaaS compatible-mode）或 0G {地址}/v1/decisions' },
            h(Select, { value: p.endpoint === 'decisions' ? 'decisions' : 'systemone', options: DECISION_ENDPOINTS, onChange: (v) => set('endpoint', v) }))
          : null,
        h(Field, { label: 'API 地址', hint: serviceTypeOf(p) === 'laya'
          ? (p.endpoint === 'decisions' ? '0G 云端基地址，如 https://router-api.0g.ai' : '本地判定服务基地址，决策调用走 {地址}/v1/systemone，如 http://127.0.0.1:8000')
          : serviceTypeOf(p) === 'chat'
            ? 'OpenAI 兼容基地址，对话走 {地址}/chat/completions，如 https://api.siliconflow.cn/v1'
            : '云端判定服务基地址，判定走 {地址}/v1/systemone，如 https://...aliyuncs.com/compatible-mode' },
          h('input', { className: 'mrrp-input', value: p.baseUrl, placeholder: serviceTypeOf(p) === 'laya' && p.endpoint === 'decisions' ? 'https://router-api.0g.ai' : serviceTypeOf(p) === 'laya' ? 'http://127.0.0.1:8000' : serviceTypeOf(p) === 'chat' ? 'https://api.siliconflow.cn/v1' : 'https://...aliyuncs.com/compatible-mode', onChange: (e) => set('baseUrl', e.target.value) })),
        h(Field, { label: 'API 密钥', hint: '选填；服务端未设置密钥（如 LAYA_API_KEY 未启用）时留空' },
          h('input', { type: 'password', className: 'mrrp-input', value: p.apiKey, placeholder: 'Bearer 密钥，可留空', onChange: (e) => set('apiKey', e.target.value) })),
        h(Field, { label: '模型列表', hint: p.format === 'laya' ? '无模型列表接口，手动输入检查点名称（english / multilingual / typed-decisions）' : '点击「获取模型」从服务端拉取，可再手动增删' },
          h('div', { className: 'mrrp-modelChips' },
            (p.modelNames || []).map((n) => h('span', { key: n, className: 'mrrp-chip' }, n, h('button', { type: 'button', onClick: () => removeName(n) }, '×')))),
          h('div', { className: 'mrrp-modelAdd' },
            h('input', { className: 'mrrp-bindSearch', value: newName, placeholder: '输入模型名，回车添加', onChange: (e) => setNewName(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addName(); } } }),
            h(Btn, { size: 'small', onClick: addName }, '添加'),
            h(Btn, { size: 'small', onClick: fetchNames, disabled: busy }, p.format === 'laya' ? '填入内置模型名' : '获取模型'))),
        h(Field, { label: '启用', hint: '关闭后 laya_decide 工具不再使用该提供方' },
          h(Toggle, { checked: !!p.enabled, onChange: (v) => set('enabled', v) })),
        line ? h('div', { className: `mrrp-testLine mrrp-test-${line.tone}` }, line.text) : null));
    }

    function RouteConfigPage({ ctx, notify }) {
      const [route, setRoute] = useState(null);
      const [providers, setProviders] = useState([]);
      const [models, setModels] = useState([]);
      const [busy, setBusy] = useState(false);

      async function reload() {
        setBusy(true);
        try {
          const routeR = await rpcCall(ctx, 'route.get', {});
          setRoute(routeR.route);
        } catch (error) { notify(error.message, 'error'); }
        // 模型 / 提供方加载失败时降级为空，不影响路由配置本身
        try {
          const [decR, modelR] = await Promise.all([
            rpcCall(ctx, 'decision.list', {}),
            rpcCall(ctx, 'models.list', {}),
          ]);
          setProviders(decR.providers || []);
          setModels(modelR.models || []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function saveRoute() {
        if (!route) return;
        try {
          // 用最新 imRoute（imRef 每渲染同步）合并，避免勾选后 React 未重渲染时旧闭包快照覆盖刚勾选的决策提供方
          const im = imRef.current && typeof imRef.current === 'object' ? imRef.current : route.imRoute;
          const payload = { ...route, imRoute: im };
          await rpcCall(ctx, 'route.save', { route: payload });
          notify('路由配置已保存', 'success');
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      }

      // 函数式更新：避免 React 渲染滞后时基于过期 route 闭包覆盖其它字段（如刚勾选的决策提供方列表）。
      const patchIm = (patch) => setRoute((prev) => (prev ? { ...prev, imRoute: { ...prev.imRoute, ...patch } } : prev));
      // 每次渲染同步最新 imRoute 引用，供「保存路由配置」按钮基于最新配置合并提交，避免整段覆盖丢字段。
      const imRef = useRef(null);
      imRef.current = route ? route.imRoute : null;

      const providerOptions = providers.map((p) => ({
        value: p.id,
        label: `${p.name}（${serviceTypeLabel(p)}${p.endpoint ? ' · ' + p.endpoint : ''}${p.enabled ? '' : ' · 已停用'}）`,
      }));
      const allModelOptions = models.map((m) => ({ value: m.key, label: `${m.key}（${m.name}）` }));

      // 决策模型并发调度：把选中提供方的所有模型展开成可见的槽，便于逐项调上限 / 权重
      const imRoute = route ? route.imRoute : {};
      const poolCfg = imRoute.decisionPool || {};
      const chosenIds = (imRoute.decisionProviderIds && imRoute.decisionProviderIds.length)
        ? imRoute.decisionProviderIds
        : (imRoute.decisionProviderId ? [imRoute.decisionProviderId] : []);
      const poolSlots = [];
      for (const id of chosenIds) {
        const p = providers.find((item) => item.id === id);
        if (!p) continue;
        const names = p.format === 'laya'
          ? ['']
          : ((p.modelNames || []).filter((n) => typeof n === 'string' && n.trim()).length
            ? p.modelNames.filter((n) => typeof n === 'string' && n.trim())
            : ['']);
        for (const model of names) poolSlots.push({ key: `${id}::${model}`, providerName: p.name || id, model });
      }
      const patchPool = (patch) => patchIm({ decisionPool: { ...poolCfg, ...patch } });
      const [poolStats, setPoolStats] = useState({});
      async function refreshPool() {
        try {
          const r = await rpcCall(ctx, 'decision.pool.stats', {});
          const map = {};
          for (const slot of r.slots || []) map[slot.key] = slot;
          setPoolStats(map);
          notify('已刷新各模型负载', 'success');
        } catch (error) { notify(error.message, 'error'); }
      }
      const slotStatus = (key) => {
        const st = poolStats[key];
        if (!st) return '—';
        return `${st.inflight} 在途 · 成功 ${st.success} · 失败 ${st.failed}${st.cooldownMs > 0 ? ' · 冷却中' : ''}`;
      };

      return h('div', { className: 'mrrp-section mrrp-singleCard' },
        h(Card, {
          title: '决策模型路由',
          extra: h('span', { className: 'mrrp-card-sub' }, route?.imRoute?.enabled ? '决策模型运行中' : '未启动'),
        },
        route ? [
          h('div', { className: 'mrrp-imRouteDesc' },
            '启动后：本插件向 DSH 对话暴露一个虚拟模型「MRRP 智能路由」。对话选中该模型后，插件按会话发送者匹配用户表 → 取用户（单独角色 + 所属部门角色）绑定的模型分类并去重 → 候选多个时用内置判定问题请 Laya 决策模型选一个 → 由该真实模型生成回复。'),
          h('div', { className: 'mrrp-formToggles' },
            h(Toggle, { label: '启动决策模型', desc: '打开后 dsh-im / DSH 对话的模型列表会出现「MRRP 智能路由」，选中即按用户权限路由真实模型回复', checked: route.imRoute.enabled, onChange: (v) => patchIm({ enabled: v }) })),
          h('div', { className: 'mrrp-formGrid' },
            h(Field, { label: '决策模型（可多选）', hint: '支持 laya 与 OpenAI 兼容判定型服务（openai/generic，请求带判定模型名）；这里选中的提供方及其全部模型会合成一个池，按空闲程度自动分摊（同一 API 下填多个模型也各自参与），某个模型在忙会自动换空闲的，全部失败才用兜底模型' },
              h(ModelProfileEditor, {
                value: route.imRoute.decisionProviderIds && route.imRoute.decisionProviderIds.length
                  ? route.imRoute.decisionProviderIds
                  : (route.imRoute.decisionProviderId ? [route.imRoute.decisionProviderId] : []),
                onChange: (list) => patchIm({ decisionProviderIds: list, decisionProviderId: list[0] || '' }),
                options: providerOptions,
                panelTitle: '决策模型提供方（可多选，按顺序）',
              })),
            h(Field, { label: '兜底模型', hint: '用户未注册 / 未绑定分类 / 决策失败时使用的模型（provider:id）' },
              h(Select, {
                className: 'mrrp-bindSelect',
                value: route.imRoute.fallbackModel,
                onChange: (v) => patchIm({ fallbackModel: v }),
                options: allModelOptions,
                placeholder: '未设置（使用默认模型）',
              })),
            h(Field, { label: '未注册用户', hint: '消息发送者不在用户表时的处理' },
              h(Select, { value: route.imRoute.unknownUser, onChange: (v) => patchIm({ unknownUser: v }), options: [
                { value: 'ignore', label: '不路由（对话明确提示未注册）' },
                { value: 'fallback', label: '使用兜底模型' },
              ] })),
            h(Field, { label: '渠道', hint: '允许路由的 dsh-im 渠道，逗号分隔（默认 dingtalk；空 = 全部）' },
              h('input', { className: 'mrrp-input', value: (route.imRoute.channels || []).join(','), onChange: (e) => patchIm({ channels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }) })),
          ),
          h('div', { className: 'mrrp-poolBox' },
            h('div', { className: 'mrrp-poolHead' },
              h('div', null,
                h('div', { className: 'mrrp-poolTitle' }, '决策模型并发调度'),
                h('div', { className: 'mrrp-poolDesc' }, '把上面选中的提供方及其全部模型合成一个池：谁空闲给谁。某个模型在决策时，新请求自动换空闲的模型，不用排队等它；全部模型都在忙才排队，排队超时才落兜底模型。对话量很大时才可能出现排队。')),
              h(Btn, { size: 'small', onClick: refreshPool, disabled: busy }, '刷新各模型负载')),
            h('div', { className: 'mrrp-formToggles' },
              h(Toggle, { label: '启用并发分摊', desc: '关闭后回到「按提供方轮询 + 顺序故障转移」的旧行为', checked: poolCfg.enabled !== false, onChange: (v) => patchPool({ enabled: v }) }),
              h(Toggle, { label: '会话粘性', desc: '同一发送者优先复用上次成功的模型，避免同一会话的判定口径来回跳', checked: poolCfg.sticky !== false, onChange: (v) => patchPool({ sticky: v }) })),
            h('div', { className: 'mrrp-formGrid' },
              h(Field, { label: '每模型并发上限', hint: '默认 1：同一模型同一时间只跑一条决策，第二个请求会自动落到空闲模型；本地模型推理快，1 就够分摊' },
                h('input', { className: 'mrrp-input', type: 'number', min: 1, max: 32, value: poolCfg.defaultLimit ?? 1, onChange: (e) => patchPool({ defaultLimit: Number(e.target.value) }) })),
              h(Field, { label: '排队等待上限（秒）', hint: '所有模型都满额时最多等这么久，超时用兜底模型；0 = 不排队直接兜底' },
                h('input', { className: 'mrrp-input', type: 'number', min: 0, max: 60, value: Math.round((poolCfg.queueTimeoutMs ?? 8000) / 1000), onChange: (e) => patchPool({ queueTimeoutMs: Math.round(Number(e.target.value) * 1000) }) })),
              h(Field, { label: '主用提供方', hint: '只作优先级：空闲时优先给它，它忙了自动分流给其它模型' },
                h(Select, { value: poolCfg.primaryProviderId || '', onChange: (v) => patchPool({ primaryProviderId: v, primaryModel: '' }), options: providerOptions, placeholder: '不设置（纯按最少在途）' })),
              h(Field, { label: '主用模型', hint: '主用提供方下的模型名；本地判定服务（请求不带 model）留空' },
                h('input', { className: 'mrrp-input', value: poolCfg.primaryModel || '', placeholder: '留空 = 该提供方的默认模型', onChange: (e) => patchPool({ primaryModel: e.target.value }) })),
            ),
            poolSlots.length ? h('div', { className: 'mrrp-poolSlots' },
              h('div', { className: 'mrrp-poolSlotsHint' }, `池内共 ${poolSlots.length} 个模型槽：逐项可调并发上限与权重（权重越大越能多吃请求）`),
              h('div', { className: 'mrrp-poolRow mrrp-poolRowHead' },
                h('span', null, '提供方'),
                h('span', null, '模型'),
                h('span', null, '上限'),
                h('span', null, '权重'),
                h('span', null, '实时负载')),
              poolSlots.map((slot) => h('div', { key: slot.key, className: 'mrrp-poolRow' },
                h('span', { className: 'mrrp-poolName', title: slot.providerName }, slot.providerName),
                h('span', { className: 'mrrp-poolModel', title: slot.model }, slot.model || '默认'),
                h('input', { className: 'mrrp-input', type: 'number', min: 1, max: 32, value: poolCfg.limits?.[slot.key] ?? (poolCfg.defaultLimit ?? 1), onChange: (e) => patchPool({ limits: { ...(poolCfg.limits || {}), [slot.key]: Number(e.target.value) } }) }),
                h('input', { className: 'mrrp-input', type: 'number', min: 1, max: 5, value: poolCfg.weights?.[slot.key] ?? 1, onChange: (e) => patchPool({ weights: { ...(poolCfg.weights || {}), [slot.key]: Number(e.target.value) } }) }),
                h('span', { className: 'mrrp-poolStat' }, slotStatus(slot.key)))))
              : h('div', { className: 'mrrp-poolEmpty' }, '先在「决策模型（可多选）」里选择至少一个提供方，这里会列出池内每个模型槽。'),
          ),
          h('div', { className: 'mrrp-card-foot' },
            h(Btn, { variant: 'primary', onClick: saveRoute, disabled: busy }, h(IconCheck, { size: 14 }), '保存路由配置')),
        ] : h(Spinner, { size: 20 })));
    }

    /* ============================== 决策模型配置页 ============================== */
    function DecisionConfigPage({ ctx, notify }) {
      const [providers, setProviders] = useState([]);
      const [catList, setCatList] = useState([]);
      const [editing, setEditing] = useState(null);
      const [working, setWorking] = useState('');

      async function reload() {
        try {
          const [decR, catR] = await Promise.all([
            rpcCall(ctx, 'decision.list', {}),
            rpcCall(ctx, 'categories.list', {}),
          ]);
          setProviders(decR.providers || []);
          setCatList(catR.categories || []);
        } catch (error) { notify(error.message, 'error'); }
      }
      useEffect(() => { reload(); }, []);

      async function doTest(provider) {
        setWorking(provider.id + ':test');
        try {
          const r = await rpcCall(ctx, 'decision.test', { provider });
          notify(r.ok ? `「${provider.name}」连接成功（${r.latencyMs} ms）` : `「${provider.name}」连接失败：${friendlyTestErr(r.message)}`, r.ok ? 'success' : 'error');
        } catch (error) { notify(friendlyTestErr(error.message), 'error'); }
        finally { setWorking(''); }
      }
      async function doFetch(provider) {
        setWorking(provider.id + ':fetch');
        try {
          const r = await rpcCall(ctx, 'decision.fetch', { provider });
          const names = (r.models || []).map((m) => m.id);
          await rpcCall(ctx, 'decision.save', { provider: { ...provider, modelNames: Array.from(new Set([...(provider.modelNames || []), ...names])) } });
          notify(r.manual ? `已填入内置模型名（${names.length} 个）` : `已拉取并保存 ${names.length} 个模型`, 'success');
          await reload();
        } catch (error) { notify(error.message, 'error'); }
        finally { setWorking(''); }
      }
      async function doDelete(provider) {
        try {
          await rpcCall(ctx, 'decision.delete', { id: provider.id });
          notify(`已删除「${provider.name}」`, 'success');
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      }

      return h('div', { className: 'mrrp-section mrrp-singleCard' },
        h(Card, {
          title: '决策模型配置',
          extra: h('div', { className: 'mrrp-card-head' },
            h('span', { className: 'mrrp-card-sub' }, `${providers.length} 个提供方`),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setEditing({ id: '', name: '', format: 'laya', endpoint: 'systemone', baseUrl: '', apiKey: '', modelNames: [], categoryId: '', enabled: true }) }, '新增提供方')),
        },
        providers.length === 0
          ? h('div', { className: 'mrrp-bindEmpty' }, '尚未配置决策模型提供方。点击「新增提供方」接入本地/云端判定服务或 OpenAI 兼容接口（llama.cpp / vLLM / 硅基流动等）。')
          : h('div', { className: 'mrrp-providerList' },
            providers.map((p) => h('div', { key: p.id, className: 'mrrp-providerCard' },
              h('div', { className: 'mrrp-providerHead' },
                h('span', { className: 'mrrp-providerName' }, p.name),
                h('span', { className: `mrrp-formatBadge mrrp-format-${serviceTypeOf(p)}` }, serviceTypeLabel(p)),
                h('span', { className: 'mrrp-providerState' }, p.enabled ? '已启用' : '已停用'),
                h('div', { className: 'mrrp-providerActions' },
                  h(Btn, { size: 'small', disabled: working === p.id + ':test', onClick: () => doTest(p) }, working === p.id + ':test' ? h(Spinner, {}) : '测试'),
                  h(Btn, { size: 'small', disabled: working === p.id + ':fetch', onClick: () => doFetch(p) }, p.format === 'laya' ? '填内置名' : '获取模型'),
                  h(Btn, { size: 'small', onClick: () => setEditing(clone(p)) }, '编辑'),
                  h(Btn, { size: 'small', onClick: () => doDelete(p) }, '删除'))),
              h('div', { className: 'mrrp-providerMeta' },
                h('span', { title: p.baseUrl }, p.baseUrl || '未填写地址'),
                h('span', {}, p.apiKey ? '密钥已设置' : '无密钥'),
                endpointLabel(p) ? h('span', {}, endpointLabel(p)) : null,
                catName(catList, p.categoryId) ? h('span', {}, catName(catList, p.categoryId)) : null),
              (p.modelNames && p.modelNames.length)
                ? h('div', { className: 'mrrp-modelChips' }, p.modelNames.map((n) => h('span', { key: n, className: 'mrrp-chip' }, n)))
                : h('span', { className: 'mrrp-hint' }, '未配置模型名'))))),
        editing ? h(DecisionProviderModal, {
          ctx, initial: editing,
          onClose: () => setEditing(null),
          onSaved: async () => { setEditing(null); notify('决策模型提供方已保存', 'success'); await reload(); },
        }) : null);
    }

    /* ============================== 模型分类配置页 ============================== */
    function CategoryConfigPage({ ctx, notify }) {
      const [categories, setCategories] = useState([]);
      const [selectedCat, setSelectedCat] = useState(null);
      const [busy, setBusy] = useState(false);
      const [creating, setCreating] = useState(false);
      const [editingCat, setEditingCat] = useState(null);
      const [deletingCat, setDeletingCat] = useState(null);

      async function reload() {
        setBusy(true);
        try {
          const catR = await rpcCall(ctx, 'categories.list', {});
          setCategories(catR.categories || []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);
      useEffect(() => { if (!selectedCat && categories.length) setSelectedCat(categories[0].id); }, [categories]);

      async function createCategory(name, desc, modelIds) {
        if (!name.trim()) { notify('请输入分类名称', 'error'); return false; }
        try {
          const res = await rpcCall(ctx, 'categories.create', { name: name.trim(), desc: desc.trim(), isDefault: false });
          const created = res && res.category;
          const ids = modelIds || [];
          if (created && created.id && ids.length) {
            await rpcCall(ctx, 'categories.bind', { id: created.id, modelIds: ids });
          }
          notify(`已创建分类「${name.trim()}」`, 'success');
          await reload();
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }
      async function updateCategory(cat, modelIds) {
        if (!cat.name.trim()) { notify('请输入分类名称', 'error'); return false; }
        try {
          await rpcCall(ctx, 'categories.update', { id: cat.id, name: cat.name.trim(), desc: cat.desc.trim() });
          const prev = cat.modelIds || [];
          const next = modelIds || [];
          const toAdd = next.filter((k) => !prev.includes(k));
          const toRemove = prev.filter((k) => !next.includes(k));
          if (toAdd.length) await rpcCall(ctx, 'categories.bind', { id: cat.id, modelIds: toAdd });
          if (toRemove.length) await rpcCall(ctx, 'categories.unbind', { id: cat.id, modelIds: toRemove });
          notify('分类已更新', 'success');
          await reload();
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }
      async function deleteCategory(id) {
        if (categories.length <= 1) { notify('至少保留一个模型分类，无法删除最后一个分类。', 'error'); setDeletingCat(null); return; }
        try {
          await rpcCall(ctx, 'categories.delete', { id });
          notify('分类已删除', 'success');
          setDeletingCat(null);
          setSelectedCat(null);
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      }

      const selCat = categories.find((c) => c.id === selectedCat) || null;

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '模型分类配置',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${categories.length} 个分类`),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setCreating(true) }, h(IconPlus, { size: 14 }), '新建分类')),
        },
        categories.length === 0
          ? h(Empty, { title: '还没有模型分类', desc: '创建一个分类，再把模型绑定进去。', icon: h(IconNavCategories, { size: 22 }) },
              h(Btn, { variant: 'primary', onClick: () => setCreating(true) }, '新建分类'))
          : h('div', { className: 'mrrp-catList' },
            categories.map((cat) => {
              const active = cat.id === selCat?.id;
              return h('div', {
                key: cat.id, className: `mrrp-catItem${active ? ' is-active' : ''}`,
                onClick: () => setSelectedCat(cat.id),
              },
              h('div', { className: 'mrrp-catItem-main' },
                h('div', { className: 'mrrp-catItem-title' },
                  h('span', { className: 'mrrp-catItem-name' }, cat.name),
                  cat.isDefault ? h(Pill, { tone: 'info' }, '默认') : null,
                  h(Pill, {}, `${(cat.modelIds || []).length} 个模型`)),
                cat.desc ? h('div', { className: 'mrrp-catItem-desc' }, cat.desc) : null),
              h('div', { className: 'mrrp-catItem-actions' },
                Btn({ size: 'small', onClick: (e) => { e.stopPropagation(); setEditingCat(clone(cat)); }, title: '编辑' }, '编辑'),
                Btn({ size: 'small', variant: 'danger', onClick: (e) => { e.stopPropagation(); setDeletingCat(cat); }, title: '删除' }, '删除')));
            }))),
        creating ? h(CreateCategoryModal, {
          ctx,
          onClose: () => setCreating(false),
          onCreate: async (name, desc, modelIds) => { const ok = await createCategory(name, desc, modelIds); if (ok) setCreating(false); },
        }) : null,
        editingCat ? h(EditCategoryModal, {
          ctx,
          cat: editingCat,
          onClose: () => setEditingCat(null),
          onSave: async (cat, modelIds) => { const ok = await updateCategory(cat, modelIds); if (ok) setEditingCat(null); },
        }) : null,
        deletingCat ? h(Modal, {
          title: '删除分类', onClose: () => setDeletingCat(null), width: 380,
          footer: h('div', { className: 'mrrp-modal-actions' },
            h(Btn, { onClick: () => setDeletingCat(null) }, '取消'),
            h(Btn, { variant: 'danger', onClick: () => deleteCategory(deletingCat.id) }, '删除')),
        },
        h('p', { className: 'mrrp-modal-text' },
          `确定删除分类「${deletingCat.name}」？其绑定模型将被释放为未分类，依赖它的角色将改为走全局路由。`)) : null);
    }

    /* ============================== 模型列表页 ============================== */
    function ModelListPage({ ctx, notify }) {
      const [models, setModels] = useState([]);
      const [categories, setCategories] = useState([]);
      const [profiles, setProfiles] = useState({});
      const [drafts, setDrafts] = useState({});
      const [busy, setBusy] = useState(false);
      const [search, setSearch] = useState('');
      const [typeScenes, setTypeScenes] = useState(null);
      const sceneTimer = useRef(null);

      async function reload() {
        setBusy(true);
        let modelR = null, catR = null, profR = null, tsR = null, failCount = 0;
        try { modelR = await rpcCall(ctx, 'models.list', {}); } catch (e) { failCount++; }
        try { catR = await rpcCall(ctx, 'categories.list', {}); } catch (e) { failCount++; }
        try { profR = await rpcCall(ctx, 'modelProfile.list', {}); } catch (e) { failCount++; }
        try { tsR = await rpcCall(ctx, 'typeScene.list', {}); } catch (e) { failCount++; }
        if (modelR) setModels(modelR.models || []);
        if (catR) setCategories(catR.categories || []);
        if (profR) setProfiles(profR.profiles || {});
        if (tsR) setTypeScenes(tsR.list || []);
        if (failCount >= 3) notify('模型列表数据加载失败，请点击「重新扫描」重试', 'error');
        else if (modelR && !(modelR.models || []).length) {
          // 宿主模型发现可能是异步就绪：空结果延迟再查一次，避免「进页面空白，要点重新扫描才出来」
          setTimeout(() => { void refreshModelsSilent(); }, 900);
        }
        setBusy(false);
      }
      useEffect(() => { reload(); }, []);

      const filteredModels = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return models;
        return models.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q));
      }, [models, search]);

      async function refreshModelsSilent() {
        try { const modelR = await rpcCall(ctx, 'models.list', {}); setModels(modelR.models || []); } catch { /* 静默 */ }
      }

      async function refreshModels() {
        setBusy(true);
        try {
          const modelR = await rpcCall(ctx, 'models.list', {});
          setModels(modelR.models || []);
          notify('模型列表已刷新', 'success');
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }

      async function bindModel(key, catId) {
        try {
          if (catId === '') {
            const current = categoryOfModel(categories, key);
            if (current) await rpcCall(ctx, 'categories.unbind', { id: current.id, modelIds: [key] });
            else { notify('该模型未绑定分类', 'info'); return; }
          } else {
            await rpcCall(ctx, 'categories.bind', { id: catId, modelIds: [key] });
          }
          notify('模型绑定已更新', 'success');
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      }

      const PROFILE_TYPES = typeScenes && typeScenes.length ? typeScenes : DEFAULT_TYPE_SCENES;
      /* 实时保存：勾选类型立即保存；「其他」场景输入防抖 400ms 自动保存（成功不弹提示，失败才提示） */
      async function saveProfile(key, type, scene) {
        const types = Array.isArray(type) ? type.filter(Boolean) : (type ? [type] : []);
        // 类型即场景：仅勾选「其他」时使用手动填写的擅长场景，其余类型不单独存场景
        const finalScene = types.includes('其他') ? (scene || '').trim() : '';
        try {
          const r = await rpcCall(ctx, 'modelProfile.set', { key, type: types, scene: finalScene });
          setProfiles(r.profiles || {});
        } catch (error) { notify(error.message, 'error'); }
      }

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '模型列表',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${models.length} 个已发现模型`),
            h('div', { className: 'mrrp-search' }, h('input', { className: 'mrrp-search-input', placeholder: '搜索模型', value: search, onChange: (e) => setSearch(e.target.value) })),
            h(Btn, { size: 'small', onClick: refreshModels, disabled: busy }, '刷新')),
        },
        models.length === 0
          ? h(Empty, { title: '没有发现模型', desc: 'DSH 中尚未绑定任何模型，或当前运行时不提供模型发现接口。', icon: h(IconNavModels, { size: 22 }) },
              h(Btn, { size: 'small', onClick: refreshModels, disabled: busy }, '重新扫描'))
          : h('div', { className: 'mrrp-tableWrap mrrp-tableWrap-model' },
            h('table', { className: 'mrrp-table mrrp-table-model' },
              h('thead', null, h('tr', null,
                h('th', { className: 'cell-key' }, '模型'),
                h('th', { className: 'cell-tight' }, '提供方'),
                h('th', { className: 'cell-pill' }, '当前分类'),
                h('th', { className: 'cell-grow' }, '类型 / 擅长场景'),
                h('th', { className: 'is-right cell-act' }, '绑定分类'))),
              h('tbody', null,
                filteredModels.map((m) => {
                  const key = modelKey(m);
                  const cat = categoryOfModel(categories, key);
                  const draft = drafts[key];
                  const profile = profiles[key] || { type: [], scene: '' };
                  const normTypes = (v) => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
                  const curType = normTypes(draft ? draft.type : profile.type);
                  const curScene = draft ? draft.scene : profile.scene;
                  const setDraft = (patch) => setDrafts((prev) => ({ ...prev, [key]: { ...(draft || profile), ...patch } }));
                  return h('tr', { key },
                    h('td', { className: 'cell-key' }, h('div', { className: 'mrrp-modelCell' },
                      h('span', { className: 'mrrp-modelName' }, m.name),
                      h('span', { className: 'mrrp-modelId' }, m.id))),
                    h('td', { className: 'cell-tight' }, h(Pill, {}, m.provider)),
                    h('td', { className: 'cell-pill' }, cat
                      ? h('span', { className: 'mrrp-pill mrrp-pill-brand mrrp-pill-clip', title: cat.name },
                          h('span', { className: 'mrrp-pillText' }, cat.name))
                      : h('span', { className: 'mrrp-muted' }, '未分类')),
                    h('td', { className: 'cell-grow' }, h('div', { className: 'mrrp-profileCell' },
                      h(ModelProfileEditor, {
                        value: curType,
                        scene: curScene,
                        onSceneChange: (v) => {
                          setDraft({ scene: v });
                          if (sceneTimer.current) clearTimeout(sceneTimer.current);
                          sceneTimer.current = setTimeout(() => { void saveProfile(key, curType, v); }, 400);
                        },
                        onChange: (v) => { void saveProfile(key, v, curScene); },
                        options: PROFILE_TYPES.map((t) => ({ value: t, label: t })),
                      }))),
                    h('td', { className: 'is-right cell-act' },
                      h('div', { className: 'mrrp-bindCell' },
                        h(Select, {
                          className: 'mrrp-bindSelect',
                          value: cat ? cat.id : '',
                          onChange: (v) => bindModel(key, v),
                          options: [{ value: '', label: '未分类' }, ...categories.map((c) => ({ value: c.id, label: c.name }))],
                        }),
                        h('span', { className: 'mrrp-linkHint', title: '绑定到分类' }))))
                }))))));
    }

    /* ============================== 类型/场景列表页 ============================== */
    function TypeScenePage({ ctx, notify }) {
      const [list, setList] = useState([]);
      const [busy, setBusy] = useState(false);
      const [input, setInput] = useState('');

      async function reload() {
        setBusy(true);
        try {
          const r = await rpcCall(ctx, 'typeScene.list', {});
          setList(r.list || []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function save(next) {
        try {
          const r = await rpcCall(ctx, 'typeScene.save', { list: next });
          setList(r.list || []);
        } catch (error) { notify(error.message, 'error'); }
      }
      const add = () => {
        const v = input.trim();
        if (!v) { notify('请输入类型/场景名称', 'error'); return; }
        if (list.includes(v)) { notify('已存在同名类型/场景', 'error'); return; }
        void save([...list, v]);
        setInput('');
      };
      const remove = (v) => { void save(list.filter((t) => t !== v)); };

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '类型/场景',
          hint: '「模型列表」页「类型/擅长场景」下拉框的选项来源此列表；可在此添加 / 删除，改动即保存并同步到模型列表。',
        },
          h('div', { className: 'mrrp-tsRow' },
            h('input', {
              className: 'mrrp-profileScene',
              style: { width: 220 },
              placeholder: '输入新类型/场景名称，回车或点击添加',
              value: input,
              onChange: (e) => setInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') add(); },
            }),
            h(Btn, { size: 'small', onClick: add, disabled: busy }, '添加')),
          list.length === 0
            ? h(Empty, { title: '暂无类型/场景', desc: '添加后会立即成为模型列表下拉框的选项。' })
            : h('div', { className: 'mrrp-tsList' },
                list.map((t) => h('div', { key: t, className: 'mrrp-tsItem' },
                  h(Pill, { tone: 'brand' }, t),
                  h('button', {
                    type: 'button',
                    className: 'mrrp-tsRemove',
                    title: '删除「' + t + '」',
                    onClick: () => remove(t),
                  }, '✕'))))));
    }

    /* 绑定模型选择器：搜索 + 分页，避免一次渲染全部模型 */
    function ModelBindPicker({ ctx, value, onChange }) {
      const PAGE_SIZE = 12;
      const [models, setModels] = useState([]);
      const [q, setQ] = useState('');
      const [page, setPage] = useState(0);
      useEffect(() => { (async () => {
        try {
          const r = await rpcCall(ctx, 'models.list', {});
          setModels(r.models || []);
        } catch (e) { setModels([]); }
      })(); }, []);
      const filtered = useMemo(() => {
        const s = q.trim().toLowerCase();
        if (!s) return models;
        return models.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(s));
      }, [models, q]);
      const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      const cur = Math.min(page, totalPages - 1);
      const pageModels = filtered.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);
      const toggle = (key) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
      const togglePageAll = () => {
        const keys = pageModels.map(modelKey);
        const allOn = keys.length > 0 && keys.every((k) => value.includes(k));
        onChange(allOn ? value.filter((k) => !keys.includes(k)) : Array.from(new Set([...value, ...keys])));
      };
      return h('div', { className: 'mrrp-bindPanel' },
        h('div', { className: 'mrrp-bindHead' },
          h('input', { className: 'mrrp-bindSearch', placeholder: '搜索模型名称 / ID / 提供方', value: q, onChange: (e) => { setQ(e.target.value); setPage(0); } }),
          h('span', { className: 'mrrp-bindCount' }, `已选 ${value.length} 个`)),
        models.length === 0
          ? h('div', { className: 'mrrp-bindEmpty' }, '暂未发现模型，可到「模型列表」页刷新')
          : pageModels.length === 0
            ? h('div', { className: 'mrrp-bindEmpty' }, '没有匹配的模型')
            : h('div', { className: 'mrrp-bindBody' },
              h('div', { className: 'mrrp-bindGrid' },
                pageModels.map((m) => {
                  const key = modelKey(m);
                  const checked = value.includes(key);
                  return h('label', { key, className: `mrrp-bindItem${checked ? ' is-checked' : ''}` },
                    h('input', { type: 'checkbox', checked, onChange: () => toggle(key) }),
                    h('span', { className: 'mrrp-bindMeta' }, h('span', {}, m.name), h('small', {}, m.provider)));
                }))),
        h('div', { className: 'mrrp-bindFoot' },
          h('span', { className: 'mrrp-bindMuted' }, `共 ${filtered.length} 个模型`),
          h('div', { className: 'mrrp-bindPages' },
            h('button', { type: 'button', className: 'mrrp-bindNav', disabled: cur === 0, onClick: () => setPage(cur - 1) }, '«'),
            h('span', { className: 'mrrp-bindPageNo' }, `${cur + 1} / ${totalPages}`),
            h('button', { type: 'button', className: 'mrrp-bindNav', disabled: cur >= totalPages - 1, onClick: () => setPage(cur + 1) }, '»'),
            h('button', { type: 'button', className: 'mrrp-bindNav mrrp-bindAll', disabled: pageModels.length === 0, onClick: togglePageAll }, '全选本页'))));
    }

    /* 通用「搜索 + 分页 + 全选本页」绑定面板：部门 / 角色 / 分类 / 模型均可复用。
       items: [{ key, label, sub? }]；selected: string[]；onChange(newSelected)。 */
    function PickPanel({ items, selected, onChange, searchOf, placeholder, emptyText }) {
      const PAGE_SIZE = 12;
      const [q, setQ] = useState('');
      const [page, setPage] = useState(0);
      const filtered = useMemo(() => {
        const s = q.trim().toLowerCase();
        if (!s) return items;
        return items.filter((it) => searchOf(it).toLowerCase().includes(s));
      }, [items, q]);
      const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      const cur = Math.min(page, totalPages - 1);
      const pageItems = filtered.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);
      const toggle = (key) => onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
      const togglePageAll = () => {
        const keys = pageItems.map((it) => it.key);
        const allOn = keys.length > 0 && keys.every((k) => selected.includes(k));
        onChange(allOn ? selected.filter((k) => !keys.includes(k)) : Array.from(new Set([...selected, ...keys])));
      };
      return h('div', { className: 'mrrp-bindPanel' },
        h('div', { className: 'mrrp-bindHead' },
          h('input', { className: 'mrrp-bindSearch', placeholder, value: q, onChange: (e) => { setQ(e.target.value); setPage(0); } }),
          h('span', { className: 'mrrp-bindCount' }, `已选 ${selected.length} 个`)),
        items.length === 0
          ? h('div', { className: 'mrrp-bindEmpty' }, emptyText)
          : pageItems.length === 0
            ? h('div', { className: 'mrrp-bindEmpty' }, '没有匹配项')
            : h('div', { className: 'mrrp-bindBody' },
              h('div', { className: 'mrrp-bindGrid' },
                pageItems.map((it) => {
                  const checked = selected.includes(it.key);
                  return h('label', { key: it.key, className: `mrrp-bindItem${checked ? ' is-checked' : ''}` },
                    h('input', { type: 'checkbox', checked, onChange: () => toggle(it.key) }),
                    h('span', { className: 'mrrp-bindMeta' }, h('span', {}, it.label), it.sub ? h('small', {}, it.sub) : null));
                }))),
        h('div', { className: 'mrrp-bindFoot' },
          h('span', { className: 'mrrp-bindMuted' }, `共 ${filtered.length} 项`),
          h('div', { className: 'mrrp-bindPages' },
            h('button', { type: 'button', className: 'mrrp-bindNav', disabled: cur === 0, onClick: () => setPage(cur - 1) }, '«'),
            h('span', { className: 'mrrp-bindPageNo' }, `${cur + 1} / ${totalPages}`),
            h('button', { type: 'button', className: 'mrrp-bindNav', disabled: cur >= totalPages - 1, onClick: () => setPage(cur + 1) }, '»'),
            h('button', { type: 'button', className: 'mrrp-bindNav mrrp-bindAll', disabled: pageItems.length === 0, onClick: togglePageAll }, '全选本页'))));
    }

    function CreateCategoryModal({ ctx, onClose, onCreate }) {
      const [name, setName] = useState('');
      const [desc, setDesc] = useState('');
      const [sel, setSel] = useState([]);
      const [saving, setSaving] = useState(false);
      return h(Modal, {
        title: '新建分类', onClose, width: 480,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: async () => { setSaving(true); await onCreate(name, desc, sel); setSaving(false); } }, saving ? h(Spinner, {}) : '创建')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '分类名称' }, h('input', { className: 'mrrp-input', value: name, autoFocus: true, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '用途说明', hint: '说明这个分类适合什么任务' }, h('textarea', { className: 'mrrp-input mrrp-textarea', value: desc, onChange: (e) => setDesc(e.target.value) })),
        h(Field, { label: '绑定模型', hint: '支持搜索与分页，可稍后在「模型列表」页调整' },
          h(ModelBindPicker, { ctx, value: sel, onChange: setSel }))));
    }

    function EditCategoryModal({ ctx, cat, onClose, onSave }) {
      const [name, setName] = useState(cat.name);
      const [desc, setDesc] = useState(cat.desc || '');
      const [sel, setSel] = useState(cat.modelIds || []);
      const [saving, setSaving] = useState(false);
      return h(Modal, {
        title: '编辑分类', onClose, width: 480,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: async () => { setSaving(true); await onSave({ id: cat.id, name, desc, modelIds: cat.modelIds || [] }, sel); setSaving(false); } }, saving ? h(Spinner, {}) : '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '分类名称' }, h('input', { className: 'mrrp-input', value: name, autoFocus: true, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '用途说明' }, h('textarea', { className: 'mrrp-input mrrp-textarea', value: desc, onChange: (e) => setDesc(e.target.value) })),
        h(Field, { label: '绑定模型', hint: '支持搜索与分页，可稍后在「模型列表」页调整' },
          h(ModelBindPicker, { ctx, value: sel, onChange: setSel }))));
    }

    /* ============================== 角色 / 部门页 ============================== */
    /* ============================== 角色页 ============================== */
    function RolePage({ ctx, notify }) {
      const [roles, setRoles] = useState([]);
      const [depts, setDepts] = useState([]);
      const [categories, setCategories] = useState([]);
      const [permissions, setPermissions] = useState([]);
      const [busy, setBusy] = useState(false);
      const [creatingRole, setCreatingRole] = useState(false);
      const [editingRole, setEditingRole] = useState(null);
      const [defRoleId, setDefRoleId] = useState('');

      async function reload() {
        setBusy(true);
        try {
          const [roleR, deptR, catR, defR, permR] = await Promise.all([
            rpcCall(ctx, 'roles.list', {}),
            rpcCall(ctx, 'depts.list', {}),
            rpcCall(ctx, 'categories.list', {}),
            rpcCall(ctx, 'userDefaults.get', {}),
            rpcCall(ctx, 'permissions.list', {}),
          ]);
          setRoles(roleR.roles || []);
          setDepts(deptR.depts || []);
          setCategories(catR.categories || []);
          setDefRoleId(defR.roleId || '');
          setPermissions(permR.permissions || []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function setDefaultRole(role) {
        // 校验：已存在其他默认角色时自动切换（保证全局只有一个默认角色）
        try {
          const r = await rpcCall(ctx, 'userDefaults.set', { roleId: role.id });
          setDefRoleId(r.roleId || '');
          if (r.previousRoleId && r.previousRoleId !== role.id) {
            const prev = roles.find((x) => x.id === r.previousRoleId);
            notify(`默认角色已从「${prev ? prev.name : r.previousRoleId}」切换为「${role.name}」`, 'success');
          } else {
            notify(`已将「${role.name}」设为自动添加默认角色`, 'success');
          }
        } catch (error) { notify(error.message, 'error'); }
      }

      async function saveRoles(next) {
        try {
          const r = await rpcCall(ctx, 'roles.save', { roles: next });
          setRoles(r.roles || next);
          if (r.depts) setDepts(r.depts);
          notify('角色已保存', 'success');
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }

      const roleCategory = (id) => categories.find((c) => c.id === id) || null;

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '角色',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${roles.length} 个角色`),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setCreatingRole(true) }, h(IconPlus, { size: 14 }), '新建角色')),
        },
        roles.length === 0
          ? h(Empty, { title: '还没有角色', desc: '角色决定请求走哪个模型分类，并绑定生效的部门。', icon: h(IconNavRoles, { size: 22 }) },
              h(Btn, { variant: 'primary', onClick: () => setCreatingRole(true) }, '新建角色'))
          : h('div', { className: 'mrrp-roleList' },
            roles.map((role) => {
              const bindings = role.categoryBindings || [];
              return h('div', { key: role.id, className: 'mrrp-roleItem' },
                h('div', { className: 'mrrp-roleItem-main' },
                  h('div', { className: 'mrrp-roleItem-name' }, role.name),
                  h('div', { className: 'mrrp-roleItem-meta' },
                    ...bindings.map((b) => {
                      const cat = roleCategory(b.categoryId);
                      return cat ? h(Pill, { key: b.categoryId, tone: 'brand' }, `${cat.name} · ${(b.modelIds || []).length} 模型`) : null;
                    }),
                    bindings.length === 0 ? h(Pill, { tone: 'muted' }, '未绑定分类') : null,
                    role.deptIds && role.deptIds.length
                      ? h(Pill, {}, `绑定 ${role.deptIds.length} 个部门`)
                      : h(Pill, {}, '全局生效')),
                  (role.permissionIds || []).length
                    ? h('div', { className: 'mrrp-roleItem-meta' },
                      h('span', { className: 'mrrp-card-sub' }, '权限：'),
                      (role.permissionIds || []).map((id) => {
                        const perm = permissions.find((p) => p.id === id);
                        return h(Pill, { key: id, tone: 'brand' }, perm ? perm.name : id);
                      }))
                    : null,
                  role.desc ? h('div', { className: 'mrrp-roleItem-desc' }, role.desc) : null),
                h('div', { className: 'mrrp-roleItem-actions' },
                  defRoleId === role.id
                    ? h('span', { className: 'mrrp-defaultTag', title: 'dsh-im 自动添加的新用户默认绑定此角色' }, '默认角色')
                    : Btn({ size: 'small', onClick: () => setDefaultRole(role), title: '设为自动添加新用户的默认角色' }, '设为默认'),
                  Btn({ size: 'small', onClick: () => setEditingRole(clone(role)), title: '编辑' }, '编辑'),
                  Btn({ size: 'small', variant: 'danger', onClick: async () => {
                    if (defRoleId === role.id) { notify('请先取消该角色的默认标记（先设置其他角色为默认）', 'error'); return; }
                    const next = roles.filter((r) => r.id !== role.id); if (await saveRoles(next)) notify('角色已删除', 'success');
                  }, title: '删除' }, '删除')));
            }))),
        (creatingRole || editingRole) ? h(RoleModal, {
          ctx,
          role: editingRole ? clone(editingRole) : { id: '', name: '', deptIds: [], categoryBindings: [], permissionIds: [], desc: '' },
          categories, depts, permissions,
          onClose: () => { setCreatingRole(false); setEditingRole(null); },
          onSave: async (role) => {
            const next = editingRole
              ? roles.map((r) => r.id === editingRole.id ? { ...role, id: editingRole.id } : r)
              : [...roles, { ...role, id: `role_${Math.random().toString(36).slice(2, 10)}` }];
            const ok = await saveRoles(next);
            if (ok) { setCreatingRole(false); setEditingRole(null); }
          },
        }) : null);
    }

    /* ============================== 权限管理页 ============================== */
    // 能力开关 → 文案：与 host 的 PermissionCaps 一一对应
    const CAP_META = [
      { key: 'chat', label: '对话应答', desc: '允许在 IM 里与助手对话（关掉 = 这个人完全不能用）' },
      { key: 'fsWrite', label: '写文件', desc: '创建 / 修改 / 删除文件' },
      { key: 'exec', label: '执行命令', desc: '运行 bash / pwsh 等命令（能执行命令就等同拿到主机权限）' },
      { key: 'pluginManage', label: '插件管理', desc: '安装 / 卸载 / 启停插件' },
      { key: 'power', label: '电源操作', desc: '关机 / 重启 / 睡眠' },
      { key: 'computerUse', label: '接管桌面', desc: '操作鼠标键盘与桌面应用' },
    ];
    const SANDBOX_OPTIONS = [
      { value: '', label: '跟随宿主默认' },
      { value: 'read-only', label: '只读（不能写盘）' },
      { value: 'workspace-write', label: '仅工作区可写' },
      { value: 'danger-full-access', label: '完全访问（危险）' },
    ];
    const APPROVAL_OPTIONS = [
      { value: '', label: '跟随宿主默认' },
      { value: 'ask', label: '每次询问（推荐）' },
      { value: 'never', label: '从不询问（危险）' },
    ];
    const BUILTIN_PERMISSION_IDS = ['perm_readonly', 'perm_standard', 'perm_admin'];
    const CAP_LABEL = { chat: '对话', fsWrite: '写文件', exec: '命令', pluginManage: '插件', power: '电源', computerUse: '桌面' };
    const sandboxLabel = (value) => (SANDBOX_OPTIONS.find((o) => o.value === (value || '')) || SANDBOX_OPTIONS[0]).label;
    const approvalLabel = (value) => (APPROVAL_OPTIONS.find((o) => o.value === (value || '')) || APPROVAL_OPTIONS[0]).label;

    function PermissionPage({ ctx, notify }) {
      const [permissions, setPermissions] = useState([]);
      const [defaultId, setDefaultId] = useState('');
      const [creating, setCreating] = useState(false);
      const [editing, setEditing] = useState(null);

      async function reload() {
        try {
          const r = await rpcCall(ctx, 'permissions.list', {});
          setPermissions(r.permissions || []);
          setDefaultId(r.defaultPermissionId || '');
        } catch (error) { notify(error.message, 'error'); }
      }
      useEffect(() => { reload(); }, []);

      async function save(next, nextDefault = defaultId) {
        try {
          const r = await rpcCall(ctx, 'permissions.save', { permissions: next, defaultPermissionId: nextDefault });
          setPermissions(r.permissions || next);
          setDefaultId(r.defaultPermissionId || '');
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }

      const capsOf = (rule) => CAP_META.filter((c) => rule.caps && rule.caps[c.key]).map((c) => CAP_LABEL[c.key]);
      const danger = (rule) => Boolean(rule.caps && (rule.caps.power || rule.caps.pluginManage)) || rule.sandbox === 'danger-full-access';

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '权限',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${permissions.length} 条权限`),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setCreating(true) }, h(IconPlus, { size: 14 }), '新建权限')),
        },
        h('div', { className: 'mrrp-permNote' },
          h('strong', {}, 'IM 用户一律按这里的权限收敛：'),
          '钉钉等渠道进来的消息会先查用户绑定的权限，未绑定且没配「默认权限」的请求直接拒绝；',
          '有绑定则只下发对应能力（工具声明在转发前就被裁掉，宿主收不到就是执行不了）。',
          '权限只能在本机控制台修改，IM 里的对话无法给自己提权。'),
        h('div', { className: 'mrrp-permDefaultRow' },
          h('span', { className: 'mrrp-permDefaultLabel' }, '未绑定用户的默认权限'),
          h('div', { className: 'mrrp-permDefaultPick' },
            h(Select, {
              value: defaultId,
              onChange: async (value) => { if (await save(permissions, value)) notify(value ? `未绑定用户将按「${(permissions.find((p) => p.id === value) || {}).name || value}」放行` : '未绑定用户将被拒绝（推荐）', 'success'); },
              options: [{ value: '', label: '拒绝（推荐）' }, ...permissions.map((p) => ({ value: p.id, label: p.name }))],
            })),
          h('span', { className: 'mrrp-hint' }, defaultId ? '注意：默认权限会对所有陌生人生效，除非确实需要，建议保持「拒绝」。' : '未在用户/角色/部门里绑定权限的人，一律不能用助手。')),
        permissions.length === 0
          ? h(Empty, { title: '还没有权限规则', desc: '权限决定一个 IM 用户能驱动多少主机能力：能对话、能写文件、能执行命令、能管插件、能关机、能接管桌面。', icon: h(IconNavRoles, { size: 22 }) },
              h(Btn, { variant: 'primary', onClick: () => setCreating(true) }, '新建权限'))
          : h('div', { className: 'mrrp-roleList' },
            permissions.map((rule) => h('div', { key: rule.id, className: 'mrrp-roleItem' },
              h('div', { className: 'mrrp-roleItem-main' },
                h('div', { className: 'mrrp-roleItem-name' },
                  rule.name,
                  BUILTIN_PERMISSION_IDS.includes(rule.id) ? h('span', { className: 'mrrp-defaultTag' }, '内置') : null,
                  defaultId === rule.id ? h(Pill, { tone: 'brand' }, '默认') : null),
                h('div', { className: 'mrrp-roleItem-meta' },
                  ...capsOf(rule).map((label) => h(Pill, { key: label, tone: label === '命令' || label === '电源' || label === '插件' || label === '桌面' ? 'danger' : '' }, label)),
                  capsOf(rule).length === 0 ? h(Pill, { tone: 'muted' }, '无任何能力') : null,
                  h(Pill, {}, `沙箱：${sandboxLabel(rule.sandbox)}`),
                  h(Pill, {}, `审批：${approvalLabel(rule.approval)}`),
                  (rule.toolAllow || []).length ? h(Pill, { tone: 'brand' }, `白名单 ${rule.toolAllow.length} 个工具`) : null),
                rule.desc ? h('div', { className: 'mrrp-roleItem-desc' }, rule.desc) : null,
                danger(rule) ? h('div', { className: 'mrrp-roleItem-desc mrrp-permWarn' }, '⚠ 这条权限可执行命令 / 管插件 / 关机或完全访问文件系统，只应绑定给可信的人。') : null),
              h('div', { className: 'mrrp-roleItem-actions' },
                Btn({ size: 'small', onClick: () => setEditing(clone(rule)) }, '编辑'),
                BUILTIN_PERMISSION_IDS.includes(rule.id)
                  ? h('span', { className: 'mrrp-hint' }, '内置不可删除')
                  : Btn({ size: 'small', variant: 'danger', onClick: async () => {
                    const next = permissions.filter((p) => p.id !== rule.id);
                    if (await save(next, defaultId === rule.id ? '' : defaultId)) notify('权限已删除', 'success');
                  } }, '删除')))))),
        (creating || editing) ? h(PermissionModal, {
          rule: editing ? clone(editing) : { id: '', name: '', desc: '', caps: { chat: true, fsWrite: false, exec: false, pluginManage: false, power: false, computerUse: false }, toolAllow: [], sandbox: '', approval: 'ask' },
          onClose: () => { setCreating(false); setEditing(null); },
          onSave: async (rule) => {
            const next = editing
              ? permissions.map((p) => (p.id === editing.id ? { ...rule, id: editing.id } : p))
              : [...permissions, { ...rule, id: `perm_${Math.random().toString(36).slice(2, 10)}` }];
            if (await save(next, defaultId)) { setCreating(false); setEditing(null); }
          },
        }) : null);
    }

    function PermissionModal({ rule, onClose, onSave }) {
      const [name, setName] = useState(rule.name || '');
      const [desc, setDesc] = useState(rule.desc || '');
      const [caps, setCaps] = useState({ ...rule.caps });
      const [sandbox, setSandbox] = useState(rule.sandbox || '');
      const [approval, setApproval] = useState(rule.approval || '');
      const [allowText, setAllowText] = useState((rule.toolAllow || []).join('\n'));
      const [saving, setSaving] = useState(false);
      const isEdit = Boolean(rule.id);

      function save() {
        if (!name.trim()) { notify('请填写权限名称', 'error'); return; }
        if (!caps.chat) { notify('没有「对话应答」的权限无法用于 IM 用户（会在准入阶段被拒）', 'error'); return; }
        setSaving(true);
        const toolAllow = allowText.split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean).slice(0, 300);
        onSave({ id: rule.id || '', name: name.trim(), desc: desc.trim(), caps, sandbox, approval, toolAllow });
      }

      return h(Modal, {
        title: isEdit ? '编辑权限' : '新建权限', onClose, width: 620,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: save }, saving ? h(Spinner, {}) : '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '名称' }, h('input', { className: 'mrrp-input', value: name, autoFocus: !isEdit, placeholder: '如 普通群成员 / 运维同事', onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '能力开关', hint: '逐项控制这个人能驱动哪些主机能力；关闭的能力组对应的工具不会下发给模型' },
          h('div', { className: 'mrrp-capGrid' }, CAP_META.map((cap) => h('div', { key: cap.key, className: 'mrrp-capItem' },
            h(Toggle, { checked: !!caps[cap.key], onChange: (value) => setCaps((prev) => ({ ...prev, [cap.key]: value })), label: cap.label }),
            h('span', { className: 'mrrp-capDesc' }, cap.desc))))),
        h(Field, { label: '会话沙箱', hint: '写进 DSH 会话的内核级限制：只读模式连写文件都会被宿主拦掉' },
          h(Select, { value: sandbox, onChange: setSandbox, options: SANDBOX_OPTIONS })),
        h(Field, { label: '审批策略', hint: 'ask = 危险操作前由本机人工放行；never = 不再拦截（危险）' },
          h(Select, { value: approval, onChange: setApproval, options: APPROVAL_OPTIONS })),
        h(Field, { label: '工具白名单（可选）', hint: '每行一个工具名；填了就只放行这些工具，留空则按上面的能力开关判定' },
          h('textarea', { className: 'mrrp-input mrrp-textarea', rows: 4, value: allowText, placeholder: '留空 = 按能力开关判定\n例如：Read\nSearch', onChange: (e) => setAllowText(e.target.value) })),
        h(Field, { label: '说明' }, h('textarea', { className: 'mrrp-input mrrp-textarea', value: desc, onChange: (e) => setDesc(e.target.value) }))));
    }

    /* ============================== 部门页 ============================== */
    function DeptPage({ ctx, notify }) {
      const [depts, setDepts] = useState([]);
      const [roles, setRoles] = useState([]);
      const [users, setUsers] = useState([]);
      const [permissions, setPermissions] = useState([]);
      const [busy, setBusy] = useState(false);
      const [creatingDept, setCreatingDept] = useState(false);
      const [editingDept, setEditingDept] = useState(null);
      const [expanded, setExpanded] = useState(() => new Set());

      async function reload() {
        setBusy(true);
        try {
          const [deptR, permR] = await Promise.all([
            rpcCall(ctx, 'depts.list', {}),
            rpcCall(ctx, 'permissions.list', {}),
          ]);
          setDepts(deptR.depts || []);
          setRoles(deptR.roles || []);
          setUsers(deptR.users || []);
          setPermissions(permR.permissions || []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function saveDepts(next) {
        try {
          const r = await rpcCall(ctx, 'depts.save', { depts: next });
          setDepts(r.depts || next);
          if (r.roles) setRoles(r.roles);
          if (r.users) setUsers(r.users);
          notify('部门已保存', 'success');
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }

      // 构建 parentId -> children 树；悬空的 parentId 视为顶级（host 已修复，这里兜底）
      const childrenOf = useMemo(() => {
        const map = new Map();
        for (const d of depts) {
          const pid = d.parentId && depts.some((x) => x.id === d.parentId) ? d.parentId : '';
          if (!map.has(pid)) map.set(pid, []);
          map.get(pid).push(d);
        }
        return map;
      }, [depts]);
      const roots = childrenOf.get('') || [];
      const usersOf = (deptId) => users.filter((u) => (u.deptIds || []).includes(deptId));
      const roleName = (id) => { const r = roles.find((x) => x.id === id); return r ? r.name : id; };
      const toggle = (id) => setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });

      function renderNode(dept, depth) {
        const kids = childrenOf.get(dept.id) || [];
        const members = usersOf(dept.id);
        const open = expanded.has(dept.id);
        const hasMore = kids.length > 0 || members.length > 0;
        return h('div', { key: dept.id, className: 'mrrp-deptNode' },
          h('div', { className: 'mrrp-deptRow', style: { paddingLeft: depth * 18 }, onClick: () => { if (hasMore) toggle(dept.id); }, title: hasMore ? '点击展开 / 收起（子部门与部门内用户）' : '' },
            h('span', { className: 'mrrp-deptCaret' + (hasMore ? '' : ' is-empty') }, hasMore ? (open ? '▼' : '▶') : '·'),
            h('span', { className: 'mrrp-deptName' }, dept.name),
            h('div', { className: 'mrrp-deptStats' },
              kids.length ? h(Pill, {}, `子部门 ${kids.length}`) : null,
              members.length ? h(Pill, { tone: 'brand' }, `用户 ${members.length}`) : null,
              dept.roleIds && dept.roleIds.length ? h(Pill, {}, `角色 ${dept.roleIds.length}`) : h(Pill, { tone: 'muted' }, '未绑角色'),
              (dept.permissionIds || []).length
                ? h(Pill, { tone: 'brand' }, `权限 ${(dept.permissionIds || []).map((id) => { const p = permissions.find((x) => x.id === id); return p ? p.name : id; }).join('、')}`)
                : null),
            h('div', { className: 'mrrp-deptRow-actions', onClick: (e) => e.stopPropagation() },
              Btn({ size: 'small', onClick: () => setEditingDept(clone(dept)), title: '编辑' }, '编辑'),
              Btn({ size: 'small', variant: 'danger', onClick: async () => { const next = depts.filter((d) => d.id !== dept.id); if (await saveDepts(next)) notify('部门已删除', 'success'); }, title: '删除' }, '删除'))),
          open ? h('div', { className: 'mrrp-deptChildren' },
            members.length ? h('div', { className: 'mrrp-deptUsers', style: { paddingLeft: depth * 18 + 24 } },
              members.map((u) => h('div', { key: u.id, className: 'mrrp-deptUserRow' },
                h('span', { className: 'mrrp-deptUserName' }, u.name),
                u.roleId ? h('span', { className: 'mrrp-deptUserRole' }, roleName(u.roleId)) : h('span', { className: 'mrrp-deptUserRole is-fallback' }, '部门角色'),
                h('span', { className: 'mrrp-deptUserId' }, u.id))))
            : null,
            kids.map((k) => renderNode(k, depth + 1)))
          : null);
      }

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '部门',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${depts.length} 个部门 · 点击部门展开子部门与部门内用户`),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setCreatingDept(true) }, h(IconPlus, { size: 14 }), '新建部门')),
        },
        depts.length === 0
          ? h(Empty, { title: '还没有部门', desc: '部门用于限定角色 / 用户的生效范围，可绑定多个角色；新建 / 编辑时可选上级部门，收纳为子部门。', icon: h(IconNavDept, { size: 22 }) },
              h(Btn, { variant: 'primary', onClick: () => setCreatingDept(true) }, '新建部门'))
          : h('div', { className: 'mrrp-deptTree' },
            roots.map((d) => renderNode(d, 0))),
        (creatingDept || editingDept) ? h(DeptModal, {
          dept: editingDept ? clone(editingDept) : { id: '', name: '', parentId: '', roleIds: [], permissionIds: [] },
          depts, roles, permissions,
          onClose: () => { setCreatingDept(false); setEditingDept(null); },
          onSave: async (dept) => {
            const next = editingDept
              ? depts.map((d) => d.id === editingDept.id ? { ...dept, id: editingDept.id } : d)
              : [...depts, { ...dept, id: `dept_${Math.random().toString(36).slice(2, 10)}` }];
            const ok = await saveDepts(next);
            if (ok) { setCreatingDept(false); setEditingDept(null); }
          },
        }) : null));
    }

    function RoleModal({ ctx, role, categories, depts, permissions, onClose, onSave }) {
      const [name, setName] = useState(role.name);
      const [deptIds, setDeptIds] = useState(role.deptIds || []);
      const [bindings, setBindings] = useState((role.categoryBindings || []).map((b) => ({ categoryId: b.categoryId, modelIds: [...(b.modelIds || [])] })));
      const [permissionIds, setPermissionIds] = useState(role.permissionIds || []);
      const [desc, setDesc] = useState(role.desc || '');
      const [saving, setSaving] = useState(false);
      const [models, setModels] = useState([]);
      useEffect(() => { (async () => {
        try { const r = await rpcCall(ctx, 'models.list', {}); setModels(r.models || []); } catch (e) { setModels([]); }
      })(); }, []);
      // 某分类下可勾选的模型 = 该分类在「模型分类配置」页已绑定的模型（不显示全部模型）
      const catModelItems = (catId) => {
        const cat = categories.find((c) => c.id === catId);
        const boundKeys = new Set(cat ? (cat.modelIds || []) : []);
        return models.filter((m) => boundKeys.has(modelKey(m))).map((m) => ({ key: modelKey(m), label: m.name, sub: m.provider }));
      };
      const setCatSel = (newSel) => {
        setBindings(categories.filter((c) => newSel.includes(c.id)).map((c) => {
          const old = bindings.find((b) => b.categoryId === c.id);
          return old ? { categoryId: c.id, modelIds: old.modelIds } : { categoryId: c.id, modelIds: [] };
        }));
      };
      const setCatModels = (cid, modelIds) => {
        setBindings(bindings.map((b) => b.categoryId === cid ? { ...b, modelIds } : b));
      };
      const catItems = categories.map((c) => {
        const b = bindings.find((x) => x.categoryId === c.id);
        return { key: c.id, label: c.name, sub: `${(c.modelIds || []).length} 个模型` + (b ? ` · 已配 ${b.modelIds.length} 个可用` : '') };
      });
      return h(Modal, {
        title: role.id ? '编辑角色' : '新建角色', onClose, width: 560,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: async () => { setSaving(true); await onSave({ id: role.id, name: name.trim(), deptIds, categoryBindings: bindings, permissionIds, desc: desc.trim() }); setSaving(false); } }, saving ? h(Spinner, {}) : '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '角色名称' }, h('input', { className: 'mrrp-input', value: name, autoFocus: true, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '绑定部门', hint: '角色在哪些部门生效；与「部门」页绑定角色双向同步，不选表示全局生效' },
          depts.length === 0
            ? h('span', { className: 'mrrp-hint' }, '暂未创建部门，可在「部门」栏添加')
            : h(PickPanel, { items: depts.map((d) => ({ key: d.id, label: d.name })), selected: deptIds, onChange: setDeptIds, searchOf: (it) => it.label, placeholder: '搜索部门名称', emptyText: '暂未创建部门' })),
        h(Field, { label: '绑定模型分类', hint: '支持多选分类；每个分类可单独配置可用的模型（来源于模型列表，可搜索分页）' },
          h(PickPanel, { items: catItems, selected: bindings.map((b) => b.categoryId), onChange: setCatSel, searchOf: (it) => `${it.label} ${it.sub}`, placeholder: '搜索分类名称', emptyText: '暂未创建分类，可到「模型分类配置」页添加' })),
        h(Field, { label: '权限（可多选）', hint: '该角色成员能驱动哪些主机能力；与用户/部门权限按最严合并' },
          permissions.length === 0
            ? h('span', { className: 'mrrp-hint' }, '暂未创建权限，可在「权限」栏添加')
            : h(PickPanel, { items: permissions.map((p) => ({ key: p.id, label: p.name })), selected: permissionIds, onChange: setPermissionIds, searchOf: (it) => it.label, placeholder: '搜索权限名称', emptyText: '暂未创建权限' })),
        bindings.length > 0
          ? h('div', { className: 'mrrp-roleCatList' },
              bindings.map((b) => {
                const cat = categories.find((c) => c.id === b.categoryId);
                return h('div', { key: b.categoryId, className: 'mrrp-roleCatItem' },
                  h('div', { className: 'mrrp-roleCatHead' },
                    h('span', { className: 'mrrp-roleCatName' }, cat ? cat.name : b.categoryId),
                    h('span', { className: 'mrrp-roleCatCount' }, `已配 ${b.modelIds.length} 个模型`)),
                  h(PickPanel, { items: catModelItems(b.categoryId), selected: b.modelIds, onChange: (v) => setCatModels(b.categoryId, v), searchOf: (it) => `${it.label} ${it.sub}`, placeholder: '搜索可用模型', emptyText: catModelItems(b.categoryId).length === 0 ? '该分类暂未绑定模型，可到「模型分类配置」页绑定' : '没有匹配的模型' }));
              }))
          : null,
        h(Field, { label: '说明' }, h('textarea', { className: 'mrrp-input mrrp-textarea', value: desc, onChange: (e) => setDesc(e.target.value) }))));
    }

    function DeptModal({ dept, depts, roles, permissions, onClose, onSave }) {
      const [name, setName] = useState(dept.name);
      const [parentId, setParentId] = useState(dept.parentId);
      const [roleIds, setRoleIds] = useState(dept.roleIds || []);
      const [permissionIds, setPermissionIds] = useState(dept.permissionIds || []);
      const [saving, setSaving] = useState(false);
      // 编辑时禁止选择自己或自己的子孙为上级（避免形成循环）
      const forbidden = useMemo(() => {
        const set = new Set([dept.id]);
        if (dept.id) {
          const stack = [dept.id];
          while (stack.length) {
            const pid = stack.pop();
            for (const d of depts) {
              if (d.parentId === pid && !set.has(d.id)) { set.add(d.id); stack.push(d.id); }
            }
          }
        }
        return set;
      }, [dept.id, depts]);
      const parentOptions = depts.filter((d) => !forbidden.has(d.id)).map((d) => ({ value: d.id, label: d.name }));
      return h(Modal, {
        title: dept.id ? '编辑部门' : '新建部门', onClose, width: 480,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: async () => { setSaving(true); await onSave({ id: dept.id, name: name.trim(), parentId, roleIds, permissionIds }); setSaving(false); } }, saving ? h(Spinner, {}) : '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '部门名称' }, h('input', { className: 'mrrp-input', value: name, autoFocus: true, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '上级部门', hint: '选上级部门后收纳为其子部门；不选表示顶级部门' },
          h(Select, { value: parentId, onChange: setParentId, placeholder: '顶级部门',
            options: [{ value: '', label: '（顶级部门）' }, ...parentOptions] })),
        h(Field, { label: '绑定角色', hint: '该部门内哪些角色生效；与「角色」页绑定部门双向同步' },
          roles.length === 0
            ? h('span', { className: 'mrrp-hint' }, '暂未创建角色，可在「角色」栏添加')
            : h(PickPanel, { items: roles.map((r) => ({ key: r.id, label: r.name })), selected: roleIds, onChange: setRoleIds, searchOf: (it) => it.label, placeholder: '搜索角色名称', emptyText: '暂未创建角色' })),
        h(Field, { label: '权限（可多选）', hint: '部门成员继承该权限；与用户/角色权限按最严合并' },
          permissions.length === 0
            ? h('span', { className: 'mrrp-hint' }, '暂未创建权限，可在「权限」栏添加')
            : h(PickPanel, { items: permissions.map((p) => ({ key: p.id, label: p.name })), selected: permissionIds, onChange: setPermissionIds, searchOf: (it) => it.label, placeholder: '搜索权限名称', emptyText: '暂未创建权限' }))));
    }

    /* ============================== 用户页 ============================== */
    /** 计算某个人在配置下的最终权限（自身 → 角色 → 部门 → 部门角色 → 默认），并保留每一项的来源。
     *  用户弹窗里的「权限」只勾「自身」，而列表展示的是叠加后的最终结果——
     *  两处都走这一个函数，才能解释「弹窗里一个都没勾，列表却有权限」并不是 bug。 */
    function resolveUserPermissionView(bind, roles, depts, permissions, defaultPermId) {
      const permNameOf = (id) => { const p = (permissions || []).find((x) => x.id === id); return p ? p.name : id; };
      const buckets = [];
      const ownIds = (bind && bind.permissionIds) || [];
      if (ownIds.length) buckets.push({ ids: ownIds, tag: '自身', label: '用户自身' });
      const role = bind && bind.roleId ? (roles || []).find((r) => r.id === bind.roleId) : null;
      if (role && (role.permissionIds || []).length) {
        buckets.push({ ids: role.permissionIds, tag: '角色', label: `角色「${role.name}」` });
      }
      for (const deptId of (bind && bind.deptIds) || []) {
        const dept = (depts || []).find((d) => d.id === deptId);
        if (!dept) continue;
        if ((dept.permissionIds || []).length) {
          buckets.push({ ids: dept.permissionIds, tag: '部门', label: `部门「${dept.name}」` });
        }
        for (const roleId of dept.roleIds || []) {
          const deptRole = (roles || []).find((r) => r.id === roleId);
          if (deptRole && (deptRole.permissionIds || []).length) {
            buckets.push({ ids: deptRole.permissionIds, tag: '部门角色', label: `部门角色「${deptRole.name}」` });
          }
        }
      }
      const names = [];
      const fromOf = new Map();
      for (const bucket of buckets) {
        for (const id of bucket.ids) {
          const name = permNameOf(id);
          if (!names.includes(name)) names.push(name);
          const from = fromOf.get(name) || [];
          if (!from.includes(bucket.label)) from.push(bucket.label);
          fromOf.set(name, from);
        }
      }
      if (names.length) {
        const tags = [...new Set(buckets.map((b) => b.tag))];
        return {
          bound: true,
          viaDefault: false,
          names,
          tags,
          sourceText: [...new Set(buckets.map((b) => b.label))].join('、'),
          detail: [...fromOf.entries()].map(([n, from]) => `${n} ← ${from.join('、')}`),
        };
      }
      if (defaultPermId) {
        const name = permNameOf(defaultPermId);
        return { bound: true, viaDefault: true, names: [name], tags: ['默认'], sourceText: '未绑定用户的默认权限', detail: [`${name} ← 未绑定用户默认权限`] };
      }
      return {
        bound: false,
        viaDefault: false,
        names: [],
        tags: [],
        sourceText: '',
        detail: ['没有绑定任何权限，且默认策略是拒绝 —— 这个人的请求会被直接拒掉'],
      };
    }

    function UserPage({ ctx, notify }) {
      const [users, setUsers] = useState([]);
      const [roles, setRoles] = useState([]);
      const [depts, setDepts] = useState([]);
      const [permissions, setPermissions] = useState([]);
      const [defaultPermId, setDefaultPermId] = useState('');
      const [busy, setBusy] = useState(false);
      const [search, setSearch] = useState('');
      const [creating, setCreating] = useState(false);
      const [editingUser, setEditingUser] = useState(null);

      async function reload() {
        setBusy(true);
        try {
          const [userR, permR] = await Promise.all([
            rpcCall(ctx, 'users.list', {}),
            rpcCall(ctx, 'permissions.list', {}),
          ]);
          setUsers(userR.users || []);
          setRoles(userR.roles || []);
          setDepts(userR.depts || []);
          setPermissions(permR.permissions || []);
          setDefaultPermId(permR.defaultPermissionId || '');
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function saveUsers(next) {
        try {
          await rpcCall(ctx, 'users.save', { users: next });
          setUsers(next);
          notify('用户已保存', 'success');
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }
      async function syncIm() {
        try {
          const r = await rpcCall(ctx, 'users.syncIm', {});
          setUsers(r.users || []);
          setRoles(r.roles || []);
          setDepts(r.depts || []);
          notify(r.created > 0 ? `已从 dsh-im 同步 ${r.created} 个新用户` : '没有新的 dsh-im 用户', 'success');
        } catch (error) { notify(error.message, 'error'); }
      }
      const roleName = (id) => { const r = roles.find((x) => x.id === id); return r ? r.name : '—'; };
      const deptName = (id) => { const d = depts.find((x) => x.id === id); return d ? d.name : '—'; };
      const permName = (id) => { const p = permissions.find((x) => x.id === id); return p ? p.name : id; };
      const computeUserPermissions = (bind, defaultId) => resolveUserPermissionView(bind, roles, depts, permissions, defaultId);
      /** 权限列文案：名字 + 来源标记（来源只有「自身」时不加标记，避免噪声）。 */
      function userPermTextOf(u) {
        const eff = computeUserPermissions(u, defaultPermId);
        if (!eff.bound) return { names: '未绑定·拒绝', tagText: '', title: eff.detail.join('；'), deny: true };
        // 来源只有「自身」时不加标记（那是默认预期）；有继承/默认则标出来，解释「弹窗里没勾却有权限」
        const tagText = eff.tags.length && !(eff.tags.length === 1 && eff.tags[0] === '自身') ? eff.tags.join('+') : '';
        return { names: eff.names.join('、'), tagText, title: eff.detail.join('；'), deny: false };
      }
      /** 用户角色的展示文本（单独角色优先，其次取所属部门绑定的角色集合）。
       *  返回 { text, tone } 而不是节点：表格里要用 ellipsis 截断并向 title 暴露全文。 */
      function userRoleLabelOf(u) {
        if (u.roleId) return { text: roleName(u.roleId), tone: '' };
        const ids = [];
        for (const did of u.deptIds || []) {
          const d = depts.find((x) => x.id === did);
          if (d && d.roleIds) ids.push(...d.roleIds);
        }
        const uniq = [...new Set(ids)];
        if (!uniq.length) return { text: '—', tone: 'mrrp-muted' };
        const names = uniq.map((id) => { const r = roles.find((x) => x.id === id); return r ? r.name : id; });
        return { text: `部门角色：${names.join('、')}`, tone: 'mrrp-roleFallback' };
      }

      const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return users;
        return users.filter((u) => `${u.name} ${u.id} ${roleName(u.roleId)} ${(u.deptIds || []).map(deptName).join(' ')}`.toLowerCase().includes(q));
      }, [users, search, roles, depts]);

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '用户',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${users.length} 个用户`),
            h('div', { className: 'mrrp-search' }, h('input', { className: 'mrrp-search-input', placeholder: '搜索姓名 / ID / 部门 / 角色', value: search, onChange: (e) => setSearch(e.target.value) })),
            h(Btn, { size: 'small', onClick: syncIm, title: '扫描 dsh-im 首次出现的发送者并自动建用户' }, '同步 dsh-im'),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setCreating(true) }, h(IconPlus, { size: 14 }), '新建用户')),
        },
        users.length === 0
          ? h(Empty, { title: '还没有用户', desc: '新建用户可用 dsh-im 的 senderId 作为唯一标识；dsh-im 中首次出现的发送者会自动创建用户。', icon: h(IconNavUsers, { size: 22 }) },
              h(Btn, { variant: 'primary', onClick: () => setCreating(true) }, '新建用户'))
          : h('div', { className: 'mrrp-tableWrap' },
            h('table', { className: 'mrrp-table mrrp-table-users' },
              h('thead', null, h('tr', null,
                h('th', { className: 'cell-key' }, '姓名'),
                h('th', { className: 'cell-tight' }, 'ID'),
                h('th', { className: 'cell-pill' }, '部门'),
                h('th', { className: 'cell-tight' }, '角色'),
                h('th', { className: 'cell-tight', title: '最终生效权限 = 用户自身 + 角色 + 部门（含部门角色）+ 默认权限，多处绑定时按最严合并' }, '权限'),
                h('th', { className: 'cell-grow' }, '备注'),
                h('th', { className: 'is-right cell-act' }, '操作'))),
              h('tbody', null,
                filtered.map((u) => {
                  const role = userRoleLabelOf(u);
                  const perm = userPermTextOf(u);
                  return h('tr', { key: u.id },
                    h('td', { className: 'cell-key' }, h('span', { className: 'mrrp-userName' }, u.name)),
                    h('td', { className: 'cell-tight' }, h('span', { className: 'mrrp-userId', title: u.id || 'dsh-im senderId（唯一标识）' }, u.id)),
                    h('td', { className: 'cell-pill' }, (u.deptIds || []).length
                      ? h('div', { className: 'mrrp-userDeptChips' }, (u.deptIds || []).map((id) => h(Pill, { key: id }, deptName(id))))
                      : h('span', { className: 'mrrp-muted' }, '—')),
                    h('td', { className: 'cell-tight' }, h('span', { className: 'mrrp-cellClipNarrow' + (role.tone ? ' ' + role.tone : ''), title: role.tone === 'mrrp-roleFallback' ? '未单独绑定角色，使用所属部门绑定的角色' : role.text }, role.text)),
                    h('td', { className: 'cell-tight' }, perm.deny
                      ? h('span', { className: 'mrrp-cellClipNarrow mrrp-permDeny', title: perm.title }, perm.names)
                      : h('span', { className: 'mrrp-permCell', title: perm.title },
                          h('span', { className: 'mrrp-permCellNames' }, perm.names),
                          perm.tagText ? h('span', { className: 'mrrp-permCellSrc' }, `（${perm.tagText}）`) : null)),
                    h('td', { className: 'cell-grow' }, h('span', { className: 'mrrp-muted mrrp-cellClip', title: u.note || '' }, u.note || '—')),
                    h('td', { className: 'is-right cell-act' }, h('div', { className: 'mrrp-rowActions' },
                      Btn({ size: 'small', onClick: () => setEditingUser(clone(u)), title: '编辑' }, '编辑'),
                      Btn({ size: 'small', variant: 'danger', onClick: async () => { const next = users.filter((x) => x.id !== u.id); if (await saveUsers(next)) notify('用户已删除', 'success'); }, title: '删除' }, '删除'))));
                })))),
        (creating || editingUser) ? h(UserModal, {
          user: editingUser ? clone(editingUser) : { id: '', name: '', roleId: '', deptIds: [], permissionIds: [], note: '' },
          roles, depts, permissions, defaultPermissionId: defaultPermId,
          onClose: () => { setCreating(false); setEditingUser(null); },
          onSave: async (user) => {
            const next = editingUser
              ? users.map((u) => u.id === editingUser.id ? { ...user, id: editingUser.id } : u)
              : [...users, user];
            const ok = await saveUsers(next);
            if (ok) { setCreating(false); setEditingUser(null); }
          },
        }) : null));
    }

    function UserModal({ user, roles, depts, permissions, defaultPermissionId, onClose, onSave }) {
      const isEdit = Boolean(user.id);
      const [id, setId] = useState(user.id || '');
      const [name, setName] = useState(user.name);
      const [roleId, setRoleId] = useState(user.roleId);
      const [deptIds, setDeptIds] = useState(user.deptIds || []);
      const [permissionIds, setPermissionIds] = useState(user.permissionIds || []);
      const [note, setNote] = useState(user.note || '');
      const [saving, setSaving] = useState(false);
      // 随弹窗里的勾选/改角色实时重算，勾完立刻能看到最终落到什么权限
      const effective = useMemo(
        () => resolveUserPermissionView({ permissionIds, roleId, deptIds }, roles, depts, permissions, defaultPermissionId),
        [permissionIds, roleId, deptIds, roles, depts, permissions, defaultPermissionId],
      );

      function save() {
        if (!isEdit && !id.trim()) { notify('请填写 ID（dsh-im 的 senderId，作为用户唯一标识）', 'error'); return; }
        if (!name.trim()) { notify('请填写姓名', 'error'); return; }
        setSaving(true);
        onSave({ id: id.trim(), name: name.trim(), roleId, deptIds, permissionIds, note: note.trim() });
      }

      return h(Modal, {
        title: isEdit ? '编辑用户' : '新建用户', onClose, width: 480,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: save }, saving ? h(Spinner, {}) : '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: isEdit ? 'ID（唯一标识）' : 'ID（dsh-im 的 senderId）', hint: isEdit ? '用户的唯一标识，不可修改' : '用户唯一标识，如钉钉对话里的 senderId；dsh-im 中首次出现的发送者会自动创建用户' },
          isEdit
            ? h('span', { className: 'mrrp-input mrrp-idStatic' }, id)
            : h('input', { className: 'mrrp-input', value: id, placeholder: '如 ou_xxxx / staffId', onChange: (e) => setId(e.target.value) })),
        h(Field, { label: '姓名' }, h('input', { className: 'mrrp-input', value: name, autoFocus: !isEdit, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '部门（可多选）', hint: '说明用户属于哪些部门；可归属于多个部门' },
          depts.length === 0
            ? h('span', { className: 'mrrp-hint' }, '暂未创建部门，可在「部门」栏添加')
            : h(PickPanel, { items: depts.map((d) => ({ key: d.id, label: d.name })), selected: deptIds, onChange: setDeptIds, searchOf: (it) => it.label, placeholder: '搜索部门名称', emptyText: '暂未创建部门' })),
        h(Field, { label: '角色', hint: '留空则使用所属部门绑定的角色' }, h(Select, { value: roleId, onChange: setRoleId, placeholder: '选择角色（留空 = 用部门角色）', options: roles.map((r) => ({ value: r.id, label: r.name })) })),
        h(Field, { label: '权限（可多选）', hint: '这里勾的是「用户自身」的权限。不勾 ≠ 没权限：角色、部门与「默认权限」仍会叠加，最终按最严合并。' },
          h('div', { className: 'mrrp-permEffective' + (effective.bound ? '' : ' is-deny') },
            h('span', { className: 'mrrp-permEffectiveLabel' }, '有效权限'),
            h('span', { className: 'mrrp-permEffectiveValue' }, effective.bound ? effective.names.join('、') : '拒绝'),
            h('span', { className: 'mrrp-permEffectiveSrc' },
              effective.bound ? `来源：${effective.sourceText}` : effective.detail[0])),
          permissions.length === 0
            ? h('span', { className: 'mrrp-hint' }, '暂未创建权限，可在「权限」栏添加')
            : h(PickPanel, { items: permissions.map((p) => ({ key: p.id, label: p.name })), selected: permissionIds, onChange: setPermissionIds, searchOf: (it) => it.label, placeholder: '搜索权限名称', emptyText: '暂未创建权限' })),
        h(Field, { label: '备注' }, h('textarea', { className: 'mrrp-input mrrp-textarea', value: note, onChange: (e) => setNote(e.target.value) }))));
    }

    /* ============================== 设置抽屉 ============================== */
    function SettingsDrawer({ ctx, notify, onClose, onModeChange }) {
      const [sidebarMode, setSidebarMode] = useState('auto');
      const [info, setInfo] = useState(null);
      const [busy, setBusy] = useState(false);

      async function reload() {
        try {
          const [entry, st] = await Promise.all([
            rpcCall(ctx, 'sidebar-entry.get', {}),
            rpcCall(ctx, 'status', {}),
          ]);
          setSidebarMode(entry.mode || 'auto');
          setInfo(st);
        } catch (error) { notify(error.message, 'error'); }
      }
      useEffect(() => { reload(); }, []);

      async function setMode(mode) {
        setBusy(true);
        try {
          await rpcCall(ctx, 'sidebar-entry.set', { mode });
          setSidebarMode(mode);
          notify('侧边栏入口已更新', 'success');
          onModeChange && onModeChange(mode);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }

      const modeOptions = [
        { value: 'auto', label: '自动（未配置路由时显示入口，配置后自动隐藏）' },
        { value: 'show', label: '始终显示' },
        { value: 'hide', label: '始终隐藏' },
      ];

      return h('div', { className: 'mrrp-drawerOverlay', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'mrrp-floatCard' },
          h('div', { className: 'mrrp-floatCard-head' },
            h('div', { className: 'mrrp-brandRow' },
              h('span', { className: 'mrrp-brandDot' }),
              h('span', { className: 'mrrp-brandText' }, '设置'),
              h('span', { className: 'mrrp-version' }, `v${PLUGIN_VERSION}`)),
            IconBtn({ onClick: onClose, title: '关闭' }, h(IconX, { size: 16 }))),
          h('div', { className: 'mrrp-floatCard-body' },
            h(Card, { title: '侧边栏入口' },
              h('div', { className: 'mrrp-form' },
                h(Field, { label: '在 DSH 侧边栏显示「MRRP」入口', hint: '控制 DSH 左侧栏是否出现 MRRP 快捷入口' },
                  h(Select, { value: sidebarMode, onChange: setMode, disabled: busy, options: modeOptions })))),
            h(Card, { title: '插件信息' },
              info ? h('div', { className: 'mrrp-kv' },
                h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '版本'), h('span', {}, PLUGIN_VERSION)),
                h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '模型提供方'), h('span', {}, info.providers)),
                h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '已发现模型'), h('span', {}, info.models)),
                h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '分类 / 角色 / 用户'), h('span', {}, `${info.categories} / ${info.roles} / ${info.users}`)),
                info.configPath ? h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '配置存储'), h('span', { className: 'mrrp-kvPath', title: info.configPath }, info.configPath)) : null,
                info.llmError ? h('div', { className: 'mrrp-notice mrrp-notice-warn' }, `模型发现异常：${info.llmError}`) : h('div', { className: 'mrrp-notice' }, '模型发现接口正常。'))
              : h(Spinner, { size: 20 })),
            h('p', { className: 'mrrp-hint' }, 'MRRP 控制台只通过 /api/mrrp 管理通道读写配置，不拦截 DSH 主链路。'))));
    }

    /* ============================== 路由决策日志页 ============================== */
    function LogsPage({ ctx, notify }) {
      const [logs, setLogs] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [expanded, setExpanded] = useState(null);
      const [panelVisible, setPanelVisible] = useState(false);
      const [panelOpen, setPanelOpen] = useState(false);
      const [limit, setLimit] = useState(100);
      // 详情面板：从左侧滑出（覆盖表格左 2/3）；收起先播滑出动画再卸载
      const areaRef = useRef(null);
      const [areaH, setAreaH] = useState(null);
      const measureArea = useCallback(() => {
        if (typeof window === 'undefined' || !window.innerHeight) return;
        const el = areaRef.current;
        if (!el || typeof el.getBoundingClientRect !== 'function') return;
        const rect = el.getBoundingClientRect();
        const h = Math.max(200, Math.floor(window.innerHeight - rect.top - 24));
        setAreaH((prev) => (prev === h ? prev : h));
      }, []);
      useEffect(() => {
        measureArea();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measureArea);
          return () => window.removeEventListener('resize', measureArea);
        }
        return undefined;
      }, [measureArea]);
      const openPanel = (i) => {
        setExpanded(i);
        setPanelVisible(true);
        setPanelOpen(false);
        requestAnimationFrame(() => requestAnimationFrame(() => setPanelOpen(true)));
      };
      const closePanel = () => {
        setPanelOpen(false);
        setTimeout(() => { setPanelVisible(false); setExpanded(null); }, 180);
      };
      const load = useCallback(() => {
        setBusy(true); setError('');
        rpcCall(ctx, 'logs.read', { limit })
          .then((r) => { setLogs(r.logs || []); if (!r.logs || !r.logs.length) setError('暂无日志：还没有产生路由决策记录'); })
          .catch((e) => setError((e && e.message) || '读取日志失败'))
          .finally(() => setBusy(false));
      }, [ctx, limit]);
      useEffect(() => { load(); }, [load]);

      const fmtTime = (ts) => {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return ts || '';
        return d.toLocaleString('zh-CN', { hour12: false });
      };
      const metaChips = (row) => {
        const out = [];
        if (row && row.ts) out.push(['时间', fmtTime(row.ts)]);
        if (row && row.scope) out.push(['来源', row.scope]);
        if (row && row.level) out.push(['级别', row.level]);
        if (row && row.event) out.push(['事件', row.event]);
        if (row && row.model) out.push(['模型', row.model]);
        if (row && (row.senderName || row.senderId)) {
          out.push(['发送者', row.senderName ? `${row.senderName}${row.senderId ? `（${row.senderId}）` : ''}` : row.senderId]);
        }
        if (row && row.source) out.push(['来源', row.source]);
        if (row && row.providerId) out.push(['决策提供方', row.providerId]);
        if (row && row.failover) out.push(['故障转移', '是']);
        if (row && row.attachmentOverride) out.push(['附件改选', '是']);
        return out;
      };
      const jsonHighlight = (text) => {
        const re = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
        const out = [];
        let last = 0;
        let m;
        let i = 0;
        while ((m = re.exec(text))) {
          if (m.index > last) out.push(text.slice(last, m.index));
          const tok = m[0];
          let cls = 'mrrp-js';
          if (/:$/.test(tok)) cls = 'mrrp-jk';
          else if (/^(?:true|false|null)$/.test(tok)) cls = 'mrrp-jb';
          else if (/^-?\d/.test(tok)) cls = 'mrrp-jn';
          out.push(h('span', { key: 't' + i++, className: cls }, tok));
          last = m.index + tok.length;
        }
        if (last < text.length) out.push(text.slice(last));
        return out;
      };
      const eventMeta = (row) => {
        const ev = row.event || '';
        const map = {
          'decide-before': { tone: 'info', label: '决策请求' },
          'decide-after': { tone: 'ok', label: '决策返回' },
          'decide-error': { tone: 'err', label: '决策失败' },
          route: { tone: row.branch === 'laya' ? 'ok' : (row.branch === 'fallback' ? 'warn' : 'info'), label: '路由结果' },
          'ctx-hit': { tone: 'info', label: '上下文命中' },
          'fallback-after-error': { tone: 'warn', label: '转发失败切兜底' },
          'failover-switch': { tone: 'warn', label: '自动切换模型' },
          'attempt-fail': { tone: 'warn', label: '模型调用失败' },
          'model-failure': { tone: 'err', label: '模型报错（限流/额度/错误码）' },
          'failover-recovered': { tone: 'ok', label: '容灾恢复' },
          'forward-exhausted': { tone: 'err', label: '模型全部不可用' },
          'unknown-sender': { tone: 'warn', label: '未知发送者' },
          'decision-disabled': { tone: 'warn', label: '路由未启动' },
          'no-route': { tone: 'err', label: '未路由' },
        };
        return map[ev] || { tone: 'info', label: ev || '观测' };
      };
      const pickedFromRaw = (raw) => {
        try {
          if (!raw || typeof raw !== 'object') return '';
          const answers = raw.answers;
          if (answers && typeof answers === 'object') {
            for (const key of Object.keys(answers)) {
              const a = answers[key];
              if (a && typeof a === 'object' && typeof a.choice === 'string' && a.choice) return a.choice;
            }
          }
          if (typeof raw.choice === 'string' && raw.choice) return raw.choice;
          if (typeof raw.model === 'string' && raw.model) return raw.model;
        } catch { /* ignore */ }
        return '';
      };
      const modelOf = (row) => {
        if (row.event === 'route') return row.model || '';
        if (row.event === 'fallback-after-error') return row.fallback || row.model || '';
        if (row.event === 'failover-switch') return row.to || '';
        if (row.event === 'failover-recovered') return row.model || '';
        if (row.event === 'attempt-fail') return row.model || '';
        if (row.event === 'model-failure') return row.model || '';
        if (row.event === 'decide-after') return pickedFromRaw(row.raw) || '';
        return '';
      };
      const detailOf = (row) => {
        if (row.event === 'route') {
          const parts = [];
          if (row.model) parts.push(`模型：${row.model}`);
          parts.push(`来源：${row.branch || ''}`);
          if (row.candidates && row.candidates.length) parts.push(`候选 ${row.candidates.length} 个`);
          return parts.join(' · ');
        }
        if (row.event === 'ctx-hit') return `决策上下文命中（候选池 ${row.candidates || 0} 个），本条消息仍走 Laya 决策`;
        if (row.event === 'fallback-after-error') return `目标模型 ${row.model || ''} 调用失败，已切换兜底 ${row.fallback || ''}`;
        if (row.event === 'failover-switch') return `${row.from || ''} 不可用 → 自动切换 ${row.to || ''}${row.reason ? `（${String(row.reason).slice(0, 160)}）` : ''}`;
        if (row.event === 'attempt-fail') return `${row.model || ''} 调用失败${row.emitted ? '（已输出部分内容，停止切换）' : '（尚未输出，继续换模型）'}：${String(row.message || '').slice(0, 160)}`;
        if (row.event === 'model-failure') return `${row.model || ''} 返回错误${row.code ? `（${row.code}${row.status ? ` / HTTP ${row.status}` : ''}）` : ''}：${String(row.message || '').slice(0, 160)}`;
        if (row.event === 'failover-recovered') return `改由 ${row.model || ''} 完成回复，此前失败 ${row.failedAttempts || 0} 次`;
        if (row.event === 'forward-exhausted') return `依次尝试均失败：${(row.tried || []).join(' / ')}`;
        if (row.event === 'decide-before') {
          const criteria = (row.questions && row.questions.model && row.questions.model.criteria) || {};
          return `决策请求已发出 · 候选 ${Object.keys(criteria).length} 个 · 超时 ${row.timeoutMs || 0}ms`;
        }
        if (row.event === 'decide-after') return `Laya 返回 · 选中 ${pickedFromRaw(row.raw) || '(未命中候选)'}`;
        if (row.event === 'decide-error') return `错误：${row.message || ''}`;
        if (row.event === 'unknown-sender') return (row.message || '') + (row.session ? ` · 会话 ${row.session}` : '');
        return '';
      };

      const current = expanded !== null && logs ? logs[expanded] : null;
      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '路由决策日志',
          sub: 'route-decision-YYYY-MM-DD.log（按天分文件） · 每次对话的 Laya 决策与模型选择（最新在前）',
          extra: h('div', { className: 'mrrp-card-extra' },
            h(Select, { value: String(limit), onChange: (v) => setLimit(Number(v)), options: [
              { value: '50', label: '50 条' }, { value: '100', label: '100 条' }, { value: '200', label: '200 条' },
            ] }),
            Btn({ size: 'small', onClick: load, disabled: busy, title: '刷新' }, busy ? '读取中…' : '刷新')),
        },
          error ? h('div', { className: 'mrrp-notice' + (error.includes('暂无') ? '' : ' mrrp-notice-warn') }, error)
            : logs === null ? h(Spinner, { size: 20 })
              : logs.length === 0 ? h('div', { className: 'mrrp-notice' }, '暂无路由决策日志。')
                : h('div', { ref: areaRef, className: 'mrrp-logArea', style: areaH ? { maxHeight: areaH + 'px' } : null },
                  h('div', { className: 'mrrp-tableWrap' },
                    h('table', { className: 'mrrp-table mrrp-logTable' },
                      h('thead', {}, h('tr', {},
                        h('th', { className: 'cell-tight' }, '时间'),
                        h('th', { className: 'cell-tight' }, '事件'),
                        h('th', { className: 'cell-pill' }, '发送者'),
                        h('th', { className: 'cell-grow' }, '决策 / 模型'),
                        h('th', { className: 'is-right cell-act' }, ''))),
                      h('tbody', {}, logs.map((row, i) => {
                        const meta = eventMeta(row);
                        const model = modelOf(row);
                        const detail = detailOf(row);
                        const open = expanded === i;
                        return h('tr', { key: i, className: 'mrrp-logRow' + (open ? ' is-open' : ''), onClick: () => (open ? closePanel() : openPanel(i)) },
                          h('td', { className: 'cell-tight' }, h('span', { className: 'mrrp-logTime', title: row.ts }, fmtTime(row.ts))),
                          h('td', { className: 'cell-tight' }, h('span', { className: 'mrrp-tag mrrp-tag-' + meta.tone }, meta.label)),
                          h('td', { className: 'cell-pill' }, h('span', { className: 'mrrp-logSender', title: row.senderName ? `${row.senderName}${row.senderId ? `（${row.senderId}）` : ''}` : (row.senderId || '') }, row.senderName ? `${row.senderName}${row.senderId ? `（${row.senderId}）` : ''}` : (row.senderId || '—'))),
                          h('td', { className: 'cell-grow' },
                            model ? h('span', { className: 'mrrp-logModel', title: model }, model) : null,
                            detail ? h('span', { className: 'mrrp-logText', title: detail }, detail) : null),
                          h('td', { className: 'is-right cell-act' }, h('span', { className: 'mrrp-logExpand' }, open ? '收起' : '详情')));
                      })))),
                  panelVisible && current ? h('div', { className: 'mrrp-logPanel' + (panelOpen ? ' is-open' : '') },
                    h('div', { className: 'mrrp-logPanel-head' },
                      h('span', { className: 'mrrp-logPanel-title' }, '原始记录'),
                      IconBtn({ onClick: closePanel, title: '收起' }, h(IconX, { size: 14 }))),
                    h('div', { className: 'mrrp-logMeta' },
                      metaChips(current).map(([k, v], i) => h('span', { key: i, className: 'mrrp-logMetaChip' },
                        h('span', { className: 'mrrp-logMetaK' }, k),
                        h('span', { className: 'mrrp-logMetaV' }, v)))),
                    h('div', { className: 'mrrp-logPanel-body' },
                      h('pre', { className: 'mrrp-logRaw' }, jsonHighlight(JSON.stringify(current, null, 2))))) : null)));
    }

    /* ============================== 日志设置页 ============================== */
    function LogSettingsPage({ ctx, notify }) {
      const [settings, setSettings] = useState(null);
      const [days, setDays] = useState('30');
      const [logDir, setLogDir] = useState('');
      const [pickingDir, setPickingDir] = useState(false);
      const [busy, setBusy] = useState(false);
      const [fileList, setFileList] = useState([]);
      const [manageName, setManageName] = useState(null);
      const [manageRows, setManageRows] = useState([]);
      const [manageTotal, setManageTotal] = useState(0);
      const [selected, setSelected] = useState([]);
      const [pruneKeyword, setPruneKeyword] = useState('');
      const [clearAllOpen, setClearAllOpen] = useState(false);
      const [clearFileOpen, setClearFileOpen] = useState(null);

      async function reload() {
        setBusy(true);
        try {
          const [s, f] = await Promise.all([
            rpcCall(ctx, 'logs.settings.get', {}),
            rpcCall(ctx, 'logs.files.list', {}),
          ]);
          setSettings(s);
          setDays(String(s.retentionDays ?? 30));
          setLogDir(s.logDir || '');
          setFileList(Array.isArray(f && f.files) ? f.files : []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function reloadManage(name) {
        if (!name) return;
        try {
          const r = await rpcCall(ctx, 'logs.file.read', { name, limit: 200 });
          setManageRows(Array.isArray(r && r.rows) ? r.rows : []);
          setManageTotal((r && r.total) || 0);
          setSelected([]);
        } catch (error) { notify(error.message, 'error'); }
      }

      const openManage = async (name) => {
        if (manageName === name) { setManageName(null); setManageRows([]); setManageTotal(0); setSelected([]); return; }
        setManageName(name);
        setClearFileOpen(null);
        await reloadManage(name);
      };

      const saveDays = async () => {
        const raw = Number(days);
        if (!Number.isFinite(raw)) { notify('请输入有效的天数（1~365）', 'error'); return; }
        const v = Math.min(365, Math.max(1, Math.round(raw)));
        try {
          const r = await rpcCall(ctx, 'logs.settings.set', { retentionDays: v });
          setDays(String(r.retentionDays));
          setSettings((s) => (s ? { ...s, retentionDays: r.retentionDays } : s));
          notify('自动清理天数已保存', 'success');
        } catch (error) { notify(error.message, 'error'); }
      };
      const saveDir = async (next) => {
        const value = typeof next === 'string' ? next : logDir;
        try {
          const r = await rpcCall(ctx, 'logs.settings.set', { logDir: value });
          setLogDir(r.logDir || '');
          await reload();
          notify(
            r.isCustom ? `日志目录已切换到 ${r.resolvedDir}` : `已恢复默认日志目录 ${r.defaultDir}`,
            'success',
          );
        } catch (error) { notify(error.message, 'error'); }
      };
      /** 打开系统「选择文件夹」对话框：start 立刻返回，之后轮询取结果（对话框由 host 侧弹出，网页拿不到绝对路径）。 */
      const pickDir = async () => {
        if (pickingDir) return;
        setPickingDir(true);
        try {
          const start = await rpcCall(ctx, 'logs.dir.pick.start', { defaultDir: logDir || settings?.resolvedDir || '' });
          const id = start && start.id;
          if (!id) {
            notify('打不开系统文件夹选择框，请直接填写绝对路径（例如 D:\\dsh-logs）。', 'error');
            return;
          }
          const deadline = Date.now() + 5 * 60 * 1000;
          while (Date.now() < deadline) {
            const r = await rpcCall(ctx, 'logs.dir.pick.poll', { id });
            const state = r && r.state;
            if (state === 'done') {
              setLogDir(r.path || '');
              notify('已选中目录，确认无误后点「保存」才会生效。', 'success');
              return;
            }
            if (state === 'canceled') { notify('已取消选择', 'info'); return; }
            if (state === 'unsupported' || state === 'error' || state === 'expired') {
              notify((r && r.message) || '系统对话框不可用，请手动填写绝对路径。', 'error');
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
          notify('等待选择超时，请重试或手动填写路径。', 'error');
        } catch (error) {
          notify(error.message, 'error');
        } finally {
          setPickingDir(false);
        }
      };
      const clearAll = async () => {
        setClearAllOpen(false);
        try {
          const r = await rpcCall(ctx, 'logs.clear', {});
          setSettings((s) => (s ? { ...s, bytes: 0, lineCount: 0, files: 0 } : s));
          setFileList([]);
          setManageName(null); setManageRows([]); setManageTotal(0); setSelected([]);
          notify(`已清空全部日志（${r.removed} 条 / ${r.files} 个文件）`, 'success');
        } catch (error) { notify(error.message, 'error'); }
      };
      const clearFile = async (name) => {
        setClearFileOpen(null);
        try {
          const r = await rpcCall(ctx, 'logs.file.clear', { name });
          notify(`已删除日志文件 ${name}（${r.removed} 条）`, 'success');
          if (manageName === name) { setManageName(null); setManageRows([]); setManageTotal(0); setSelected([]); }
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      };
      const pruneByKeyword = async () => {
        const kw = pruneKeyword.trim();
        if (!kw) { notify('请输入关键词', 'error'); return; }
        try {
          const r = await rpcCall(ctx, 'logs.file.prune', { name: manageName, dropKeyword: kw });
          notify(`已删除含「${kw}」的 ${r.removed} 条记录`, 'success');
          await reloadManage(manageName);
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      };
      const dropSelected = async () => {
        if (!selected.length) return;
        try {
          const r = await rpcCall(ctx, 'logs.file.dropRows', { name: manageName, raws: selected });
          notify(`已删除勾选的 ${r.removed} 条记录`, 'success');
          await reloadManage(manageName);
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      };
      const toggleSel = (raw) => setSelected((s) => (s.includes(raw) ? s.filter((x) => x !== raw) : [...s, raw]));
      const fmtBytes = (n) => {
        if (!(n > 0)) return '0 B';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
      };
      const fmtTime = (ms) => {
        if (!(ms > 0)) return '—';
        const d = new Date(ms);
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      const isTodayName = (name) => {
        const m = /^route-decision-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name || '');
        if (!m) return false;
        const d = new Date();
        return Number(m[1]) === d.getFullYear() && Number(m[2]) === d.getMonth() + 1 && Number(m[3]) === d.getDate();
      };
      const rowText = (r) => {
        if (!r || !r.data) return '(坏行) ' + (r && r.raw ? r.raw : '');
        const d = r.data;
        return [d.scope, d.event, d.model, d.senderId, d.message].filter((v) => v !== undefined && v !== null && v !== '').join(' · ');
      };
      const rowTime = (r) => {
        const ts = r && r.data && typeof r.data.ts === 'string' ? new Date(r.data.ts).getTime() : NaN;
        return fmtTime(Number.isFinite(ts) ? ts : 0);
      };

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '日志设置',
          hint: '路由决策日志按天分文件（route-decision-YYYY-MM-DD.log，多人共用写入无压力）：存放目录可改，默认与 config.json 同目录；每次写入最多每 6 小时清理一次「超过保留天数的历史文件」及当天文件内过期行，DSH 启动时也清理一次。',
        },
          h(Field, { label: '自动清理保留天数', hint: '日志保留 N 天，超过即自动删除（1~365）' },
            h('div', { className: 'mrrp-tsRow' },
              h('input', {
                type: 'number', min: 1, max: 365,
                className: 'mrrp-profileScene',
                style: { width: 120 },
                value: days,
                onChange: (e) => setDays(e.target.value),
              }),
              h(Btn, { size: 'small', onClick: saveDays, disabled: busy }, '保存'))),
          h(Field, { label: '日志存放目录', hint: '点「浏览…」用系统的文件夹选择框挑一个目录，也可以直接粘贴绝对路径；留空 = 与 config.json 同目录' },
            h('div', { className: 'mrrp-dirRow' },
              h('input', {
                className: 'mrrp-input mrrp-dirInput',
                value: logDir,
                placeholder: settings?.defaultDir || '留空使用默认目录',
                spellCheck: false,
                title: settings?.resolvedDir || '',
                onChange: (e) => setLogDir(e.target.value),
              }),
              h(Btn, { size: 'small', onClick: pickDir, disabled: busy || pickingDir, title: '打开系统的文件夹选择框' },
                pickingDir ? '选择中…' : '浏览…'),
              h(Btn, { size: 'small', onClick: () => saveDir(), disabled: busy }, '保存'),
              h(Btn, { className: 'is-ghost', size: 'small', onClick: () => saveDir(''), disabled: busy }, '恢复默认')),
            h('div', { className: 'mrrp-dirNote' },
              h('span', { className: 'mrrp-dirNoteLabel' }, '当前生效'),
              h('code', { className: 'mrrp-dirPath', title: settings?.resolvedDir || '' }, settings?.resolvedDir || '—'),
              h('span', { className: 'mrrp-pill ' + (settings?.isCustom ? 'mrrp-pill-info' : 'mrrp-pill-muted') },
                settings?.isCustom ? '自定义' : '默认'),
              settings && settings.dirExists === false
                ? h('span', { className: 'mrrp-pill mrrp-pill-muted' }, '目录待创建')
                : null),
            h('span', { className: 'mrrp-hint' },
              '切换目录不会自动迁移历史日志：旧目录里的 route-decision-*.log 需要的话手动拷到新目录即可；保存后新日志立即写入新目录，目录不存在会自动创建，不可写会直接报错。')),
          h(Field, { label: '当天日志文件', hint: '按天分文件，JSON 行追加写入当前日志目录' },
            h('div', { className: 'mrrp-logInfoCard' },
              h('div', { className: 'mrrp-logInfoPath', title: settings?.path || '' }, settings?.path || '—'),
              h('div', { className: 'mrrp-logInfoStats' },
                h('span', { className: 'mrrp-logInfoStat' }, h('b', {}, fmtBytes(settings?.bytes || 0)), ' 大小'),
                h('span', { className: 'mrrp-logInfoStat' }, h('b', {}, String(settings?.lineCount || 0)), ' 条记录'),
                h('span', { className: 'mrrp-logInfoStat' }, h('b', {}, String(settings?.files || 0)), ' 个按天文件'),
                h(Tip, { text: '文件名 route-decision-YYYY-MM-DD.log；写在上面设置的日志存放目录；历史文件超过保留天数会自动删除。' })))),
          h(Field, { label: '全部日志文件（当天 + 历史）', hint: '可整文件清理，或展开「管理」按关键词 / 勾选选择性删除记录' },
            h('div', { className: 'mrrp-logFiles' },
              (Array.isArray(fileList) && fileList.length)
                ? fileList.map((f) => h('div', { key: f.name, className: 'mrrp-logFileRow' + (isTodayName(f.name) ? ' is-today' : '') },
                    h('span', { className: 'mrrp-logFileName', title: f.path }, f.name,
                      isTodayName(f.name) ? h('span', { className: 'mrrp-logToday' }, '今天') : null),
                    h('span', { className: 'mrrp-logFileStat' }, `${fmtBytes(f.bytes)} · ${f.lineCount} 条`),
                    h('span', { className: 'mrrp-logFileTime' }, fmtTime(f.mtime)),
                    h(Btn, { className: 'is-ghost', size: 'small', onClick: () => openManage(f.name), disabled: busy },
                      manageName === f.name ? '收起' : '管理'),
                    h(Btn, { className: 'is-soft', variant: 'danger', size: 'small', onClick: () => setClearFileOpen(f.name), disabled: busy }, '清理')))
                : h('span', { className: 'mrrp-hint' }, '暂无日志文件'))),
          manageName ? h('div', { className: 'mrrp-logFileManage' },
            h('div', { className: 'mrrp-logFileManageHead' },
              h('span', { className: 'mrrp-logFileManageTitle' }, '管理：', h('code', {}, manageName)),
              h('span', { className: 'mrrp-logFileManageCount' }, `共 ${manageTotal} 条 · 显示最新 ${manageRows.length} 条`),
              h(Tip, { text: '按关键词删除符合条件的记录，或在下方勾选记录后批量删除；删除后不可恢复。' })),
            h('div', { className: 'mrrp-tsRow', style: { gap: 8, flexWrap: 'wrap' } },
              h('input', {
                className: 'mrrp-profileScene', placeholder: '关键词（模型名 / 来源等）',
                value: pruneKeyword,
                onChange: (e) => setPruneKeyword(e.target.value),
              }),
              h(Btn, { size: 'small', onClick: pruneByKeyword, disabled: busy }, '删除含关键词行')),
            h('div', { className: 'mrrp-logRows' },
              manageRows.map((r, i) => h('label', {
                key: i, className: 'mrrp-logRowItem' + (selected.includes(r.raw) ? ' is-sel' : ''),
              },
                h('input', { type: 'checkbox', checked: selected.includes(r.raw), onChange: () => toggleSel(r.raw) }),
                h('span', { className: 'mrrp-logRowTime' }, rowTime(r)),
                h('span', { className: 'mrrp-logRowText', title: r.data ? JSON.stringify(r.data) : r.raw }, rowText(r)))),
              manageRows.length === 0 ? h('span', { className: 'mrrp-hint' }, '该文件暂无记录') : null),
            selected.length
              ? h('div', { className: 'mrrp-logRowsAct' }, h(Btn, { variant: 'danger', size: 'small', onClick: dropSelected }, `删除勾选的 ${selected.length} 条`))
              : null)
            : null,
          h('div', { className: 'mrrp-logSettingsDanger' },
            h(Btn, { variant: 'danger', size: 'small', onClick: () => setClearAllOpen(true) }, '立即清理全部日志')),
          h(ConfirmDialog, {
            open: clearAllOpen, title: '清理全部日志',
            desc: '将删除目录下全部按天日志文件（含历史），此操作不可恢复。',
            confirmText: '确认清理全部', onConfirm: clearAll, onCancel: () => setClearAllOpen(false),
          }),
          h(ConfirmDialog, {
            open: Boolean(clearFileOpen), title: '删除日志文件',
            desc: clearFileOpen ? `确认删除 ${clearFileOpen}？删除后不可恢复。` : '',
            confirmText: '确认删除', onConfirm: () => clearFile(clearFileOpen), onCancel: () => setClearFileOpen(null),
          })));
    }

    /* ============================== 导航（两级子菜单） ============================== */
    const NAV = [
      {
        key: 'models', label: '模型管理', icon: IconNavCategories, children: [
          { key: 'route', label: '路由配置', icon: IconNavRoute },
          { key: 'decision', label: '决策模型配置', icon: IconNavDecision },
          { key: 'category', label: '模型分类配置', icon: IconNavCategories },
          { key: 'modellist', label: '模型列表', icon: IconNavModels },
          { key: 'typescene', label: '类型/场景', icon: IconNavModels },
        ],
      },
      {
        key: 'org', label: '角色部门', icon: IconNavRoles, children: [
          { key: 'role', label: '角色', icon: IconNavRoles },
          { key: 'dept', label: '部门', icon: IconNavDept },
          { key: 'user', label: '用户', icon: IconNavUsers },
          { key: 'permission', label: '权限', icon: IconNavShield },
        ],
      },
      {
        key: 'diag', label: '日志管理', icon: IconNavLog, children: [
          { key: 'logs', label: '日志', icon: IconNavLog },
          { key: 'logsettings', label: '日志设置', icon: IconNavLog },
        ],
      },
    ];

    function MrrpPage({ ctx, applySidebarMode }) {
      const [route, setRoute] = useState('route');
      const [collapsed, setCollapsed] = useState(false);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [toasts, setToasts] = useState([]);
      const [openGroup, setOpenGroup] = useState({ models: true, org: true, diag: true });
      const [versionInfo, setVersionInfo] = useState({
        current: PLUGIN_VERSION, latest: null, updateAvailable: false, checking: false,
        command: null, env: null, updating: false, pendingRestart: null,
        profile: null, profileSource: null, candidates: [],
      });

      const notify = useCallback((message, tone = 'info') => {
        const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
      }, []);
      const dismiss = useCallback((id) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

      // 启动时自动检查一次插件版本（GitHub Release；网络不可达时静默）。
      useEffect(() => {
        let alive = true;
        void (async () => {
          try {
            const value = await rpcCall(ctx, 'version.check');
            if (!alive) return;
            setVersionInfo({
              current: value?.current ?? PLUGIN_VERSION,
              latest: value?.latest ?? null,
              updateAvailable: Boolean(value?.updateAvailable),
              command: value?.command ?? null,
              env: value?.env ?? null,
              updating: false,
              checking: false,
              profile: value?.profile ?? value?.env?.profile ?? null,
              profileSource: value?.profileSource ?? value?.env?.profileSource ?? null,
              candidates: value?.candidates ?? value?.env?.candidates ?? [],
            });
            if (value?.updateAvailable && value?.latest) {
              const needPick = !(value?.profile ?? value?.env?.profile)
                && (value?.candidates ?? value?.env?.candidates ?? []).length > 1;
              notify(
                needPick
                  ? `发现新版本 v${value.latest}，本机装了多个环境，请在横幅里选择当前环境后再更新`
                  : `发现新版本 v${value.latest}，点击顶部版本号可一键更新`,
                'info',
              );
            }
          } catch {
            if (alive) setVersionInfo((v) => ({ ...v, checking: false }));
          }
        })();
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const checkVersion = useCallback(async () => {
        setVersionInfo((v) => ({ ...v, checking: true }));
        try {
          const value = await rpcCall(ctx, 'version.check');
          setVersionInfo({
            current: value?.current ?? PLUGIN_VERSION,
            latest: value?.latest ?? null,
            updateAvailable: Boolean(value?.updateAvailable),
            command: value?.command ?? null,
            env: value?.env ?? null,
            updating: false,
            checking: false,
            profile: value?.profile ?? value?.env?.profile ?? null,
            profileSource: value?.profileSource ?? value?.env?.profileSource ?? null,
            candidates: value?.candidates ?? value?.env?.candidates ?? [],
          });
          if (value?.updateAvailable && value?.latest) {
            const needPick = !(value?.profile ?? value?.env?.profile)
              && (value?.candidates ?? value?.env?.candidates ?? []).length > 1;
            notify(
              needPick
                ? `发现新版本 v${value.latest}，本机装了多个环境，请在横幅里选择当前环境后再更新`
                : `发现新版本 v${value.latest}，点击顶部版本号可一键更新`,
              'info',
            );
          } else {
            notify('已是最新版本', 'success');
          }
        } catch (cause) {
          setVersionInfo((v) => ({ ...v, checking: false }));
          notify(cause?.message ?? '版本检查失败', 'error');
        }
      }, [notify]);

      const copyUpdateCommand = useCallback(() => {
        if (!versionInfo.command) return;
        void (navigator.clipboard?.writeText(versionInfo.command).then(() => {
          notify(`更新命令已复制：${versionInfo.command}`, 'success');
        }).catch(() => {
          notify(`请手动执行更新命令：${versionInfo.command}`, 'info');
        }));
      }, [versionInfo.command, notify]);

      // 一键更新：host 侧自动识别本机环境（profile / 安装来源 / 可用 CLI）后执行对应安装命令。
      // profile 参数来自「当前环境未确定」时用户在横幅里的选择；不传时用已识别结论，绝不在多命中时猜。
      const runUpdate = useCallback(async (profile) => {
        if (versionInfo.updating) return;
        const picked = typeof profile === 'string' && profile ? profile : (versionInfo.profile || '');
        if (!picked && (versionInfo.candidates || []).length > 1) {
          notify('本机多个环境都装了本插件，请先在更新横幅里选择当前页面属于哪个环境', 'error');
          return;
        }
        if (!picked && versionInfo.env?.blocker) {
          notify(versionInfo.env.blocker, 'error');
          return;
        }
        setVersionInfo((v) => ({ ...v, updating: true }));
        try {
          const value = await rpcCall(ctx, 'version.update', picked ? { profile: picked } : undefined);
          if (value?.ok) {
            setVersionInfo((v) => ({
              ...v, updating: false, updateAvailable: false, pendingRestart: value.latest ?? v.latest,
              profile: value?.profile ?? v.profile ?? null,
            }));
            notify(
              `已安装 v${value.latest ?? versionInfo.latest}${value?.profile ? `（profile ${value.profile}）` : ''}，重启 DSH 后生效`,
              'success',
            );
          } else {
            setVersionInfo((v) => ({ ...v, updating: false }));
            const tail = String(value?.output ?? '').trim().split('\n').filter(Boolean).slice(-3).join(' / ');
            notify(`更新失败：${tail || '未知错误'}（可点「复制命令」手工执行）`, 'error');
            if (value?.command) {
              try { await navigator.clipboard?.writeText(value.command); } catch { /* 剪贴板不可用 */ }
            }
          }
        } catch (cause) {
          setVersionInfo((v) => ({ ...v, updating: false }));
          notify(cause?.message ?? '更新失败', 'error');
        }
      }, [ctx, notify, versionInfo.command, versionInfo.updating, versionInfo.latest, versionInfo.profile, versionInfo.candidates]);

      // 认不出当前属于哪个 profile（多命中）且用户还没选过：横幅改为让用户选，不猜着装到别的环境
      const needPickProfile = Boolean(versionInfo.updateAvailable)
        && !versionInfo.profile
        && (versionInfo.candidates || []).length > 1;

      const pageProps = { ctx, notify };
      let page;
      if (route === 'route') page = h(RouteConfigPage, { ...pageProps, key: 'route' });
      else if (route === 'decision') page = h(DecisionConfigPage, { ...pageProps, key: 'decision' });
      else if (route === 'category') page = h(CategoryConfigPage, { ...pageProps, key: 'category' });
      else if (route === 'modellist') page = h(ModelListPage, { ...pageProps, key: 'modellist' });
      else if (route === 'typescene') page = h(TypeScenePage, { ...pageProps, key: 'typescene' });
      else if (route === 'role') page = h(RolePage, { ...pageProps, key: 'role' });
      else if (route === 'dept') page = h(DeptPage, { ...pageProps, key: 'dept' });
      else if (route === 'logs') page = h(LogsPage, { ...pageProps, key: 'logs' });
      else if (route === 'logsettings') page = h(LogSettingsPage, { ...pageProps, key: 'logsettings' });
      else if (route === 'permission') page = h(PermissionPage, { ...pageProps, key: 'permission' });
      else page = h(UserPage, { ...pageProps, key: 'user' });

      const leafLabel = (() => {
        for (const group of NAV) {
          const child = group.children.find((c) => c.key === route);
          if (child) return child.label;
        }
        return '';
      })();

      const toggleGroup = (key) => setOpenGroup((s) => ({ ...s, [key]: !s[key] }));

      return h('div', { className: 'mrrp-page' },
        h('div', { className: 'mrrp-topbar' },
          h('div', { className: 'mrrp-brandRow' },
            h('span', { className: 'mrrp-brandDot' }),
            h('span', { className: 'mrrp-brandText' }, 'MRRP'),
            h('span', { className: 'mrrp-brandSub' }, '模型路由控制台'),
            h('span', {
              className: 'mrrp-version'
                + (versionInfo.updateAvailable ? ' mrrp-versionNew' : '')
                + (versionInfo.updating ? ' mrrp-versionBusy' : ''),
              title: versionInfo.updating ? '正在更新，请稍候…'
                : versionInfo.checking ? '正在检查更新…'
                : versionInfo.pendingRestart ? `已安装 v${versionInfo.pendingRestart}，重启 DSH 后生效`
                : versionInfo.updateAvailable ? `发现新版本 v${versionInfo.latest}，点击一键更新`
                : '已是最新版本，点击检查更新',
              onClick: versionInfo.updating ? undefined
                : versionInfo.updateAvailable ? runUpdate : checkVersion,
            }, versionInfo.updating ? `v${versionInfo.current} 更新中…`
              : versionInfo.pendingRestart ? `v${versionInfo.current} → v${versionInfo.pendingRestart} 待重启`
              : versionInfo.updateAvailable ? `v${versionInfo.current} ↑ v${versionInfo.latest}`
              : versionInfo.checking ? `v${versionInfo.current}…` : `v${versionInfo.current}`)),
          h('div', { className: 'mrrp-topbarRight' },
            Btn({ size: 'small', onClick: () => setSettingsOpen(true), title: '设置' }, '设置'))),
        versionInfo.updateAvailable ? h('div', { className: 'mrrp-updateBanner' },
          h('span', { className: 'mrrp-updateBannerText' },
            '发现新版本 ', h('strong', null, `v${versionInfo.latest}`), `（当前 v${versionInfo.current}）。`,
            needPickProfile
              ? '本机有多个 DSH 环境都装了本插件，无法确定当前页面属于哪一个，请选择后再更新。'
              : (versionInfo.env
                ? (versionInfo.env.blocker
                  ? versionInfo.env.blocker
                  : (versionInfo.env.cli
                    ? (versionInfo.env.mode === 'update'
                      ? `本机将用 update 命令原地刷新（版本号未变，只换了安装包资产）到 ${versionInfo.env.profile ?? '当前'} profile。`
                      : `本机将用 ${versionInfo.env.cli === 'dsh' ? 'dsh plugin' : versionInfo.env.cli} 安装 v${versionInfo.latest} 到 ${versionInfo.env.profile ?? '当前'} profile。`)
                    : '未检测到 dsh / pnpm / npm，请复制命令手工更新。'))
                : null)),
          h('div', {
            className: 'mrrp-updateBannerActions',
          },
          needPickProfile
            ? versionInfo.candidates.map((name) => h('button', {
              key: name,
              type: 'button',
              className: 'mrrp-btn mrrp-btn-small mrrp-btn-primary',
              disabled: versionInfo.updating,
              title: `更新到 ${name} profile`,
              onClick: () => runUpdate(name),
            }, `${name} 更新`))
            : h('button', {
              type: 'button',
              className: 'mrrp-btn mrrp-btn-small mrrp-btn-primary',
              disabled: versionInfo.updating || Boolean(versionInfo.env?.blocker),
              title: versionInfo.env?.blocker || undefined,
              onClick: runUpdate,
            }, versionInfo.updating ? '更新中…' : '立即更新'),
          h('button', { type: 'button', className: 'mrrp-btn mrrp-btn-small', onClick: copyUpdateCommand }, '复制命令'))) : null,
        h('div', { className: 'mrrp-body' },
          h('aside', { className: `mrrp-sidebar${collapsed ? ' is-collapsed' : ''}` },
            h('nav', { className: 'mrrp-nav' },
              NAV.map((group) => {
                const isOpen = !!openGroup[group.key];
                const GroupIcon = group.icon;
                return h('div', { key: group.key, className: 'mrrp-navGroup' },
                  h('button', {
                    className: `mrrp-navItem mrrp-navGroupHead${isOpen ? ' is-open' : ''}`,
                    title: group.label, onClick: () => toggleGroup(group.key),
                  },
                  h('span', { className: 'mrrp-navIcon' }, h(GroupIcon, { size: 17 })),
                  collapsed ? null : h('span', { className: 'mrrp-navLabel' }, group.label),
                  collapsed ? null : h('span', { className: 'mrrp-navCaret' }, isOpen ? h(IconChevronDown, { size: 14 }) : h(IconChevronRight, { size: 14 }))),
                  (!collapsed && isOpen) ? h('div', { className: 'mrrp-navSub' },
                    group.children.map((child) => {
                      const ChildIcon = child.icon;
                      const active = route === child.key;
                      return h('button', {
                        key: child.key,
                        className: `mrrp-navItem mrrp-navSubItem${active ? ' is-active' : ''}`,
                        title: child.label, onClick: () => setRoute(child.key),
                      },
                      h('span', { className: 'mrrp-navIcon' }, h(ChildIcon, { size: 15 })),
                      h('span', { className: 'mrrp-navLabel' }, child.label));
                    })) : null);
              })),
            h('button', {
              className: `mrrp-collapseHandle${collapsed ? ' is-collapsed' : ''}`,
              title: collapsed ? '展开侧边栏' : '收起侧边栏',
              onClick: () => setCollapsed((v) => !v),
            }, collapsed ? h(IconExpand, { size: 18 }) : h(IconCollapse, { size: 18 }))),
          h('main', { className: 'mrrp-content' },
            h('div', { className: 'mrrp-contentHead' },
              h('h2', {}, leafLabel),
              h('span', { className: 'mrrp-contentSub' }, '通过 /api/mrrp 管理通道读写配置')),
            h('div', { className: 'mrrp-contentBody' }, page))),
        h(ToastStack, { toasts, onDismiss: dismiss }),
        settingsOpen ? h(SettingsDrawer, { ctx, notify, onClose: () => setSettingsOpen(false), onModeChange: applySidebarMode }) : null);
    }

    /* ============================== 样式（DSH 浅色主题变量） ============================== */
    const styles = `
.mrrp-page { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-module-platform, #f7f8fa); box-sizing: border-box; font-family: inherit; }
.mrrp-page *, .mrrp-page *::before, .mrrp-page *::after { box-sizing: border-box; }
.mrrp-topbar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px clamp(16px, 3vw, 32px); border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-brandRow { display: flex; align-items: center; gap: 10px; }
.mrrp-brandDot { width: 10px; height: 10px; border-radius: 50%; background: #38c7bc; box-shadow: 0 0 0 4px rgba(56, 199, 188, .15); }
.mrrp-brandText { font-size: 16px; font-weight: 750; letter-spacing: .02em; }
.mrrp-brandSub { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; }
.mrrp-topbarRight { display: flex; align-items: center; gap: 10px; }
.mrrp-version { color: var(--dsw-alias-label-tertiary, #8f959e); font: 500 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; cursor: pointer; transition: color .12s ease; }
.mrrp-version:hover { color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-versionNew { color: #b45309; font-weight: 700; }
.mrrp-versionNew:hover { color: #d97706; }
.mrrp-updateBanner { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px clamp(16px, 3vw, 32px) 0; padding: 9px 14px; border: 1px solid #f3d19e; border-radius: 10px; background: #fff8ec; color: #7a4d00; font-size: 12.5px; }
.mrrp-updateBannerText { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; }
.mrrp-updateBanner strong { color: #b45309; }
.mrrp-updateBannerActions { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.mrrp-versionBusy { color: #b45309; opacity: .75; cursor: progress; }
.mrrp-body { flex: 1 1 auto; min-height: 0; display: flex; }
.mrrp-sidebar { flex: 0 0 176px; width: 176px; position: relative; display: flex; flex-direction: column; gap: 4px; padding: 12px 12px; border-right: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); transition: width .16s ease, flex-basis .16s ease; }
.mrrp-sidebar.is-collapsed { flex: 0 0 52px; width: 52px; }
.mrrp-nav { display: flex; flex-direction: column; gap: 4px; }
.mrrp-navGroup { display: flex; flex-direction: column; gap: 2px; }
.mrrp-navItem { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 38px; padding: 0 10px; border: 0; border-radius: 9px; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: 500 13px/1 inherit; text-align: left; cursor: pointer; transition: background .12s ease, color .12s ease; }
.mrrp-navItem:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-navItem.is-active { color: #0e8f84; background: rgba(56, 199, 188, .12); font-weight: 650; }
.mrrp-navIcon { display: inline-flex; align-items: center; }
.mrrp-navLabel { white-space: nowrap; overflow: hidden; }
.mrrp-navCaret { margin-left: auto; display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-navGroupHead.is-open { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 650; }
.mrrp-navSub { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 4px 6px; padding-left: 8px; border-left: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-navSubItem { min-height: 34px; padding-left: 6px; font-size: 12.5px; font-weight: 400; }
.mrrp-sidebar.is-collapsed .mrrp-navItem { justify-content: center; padding: 0; }
.mrrp-collapseHandle { position: absolute; right: -9px; top: 50%; transform: translateY(-50%); z-index: 6; display: flex; align-items: center; justify-content: center; width: 17px; height: 48px; padding: 0; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 8px; color: var(--dsw-alias-label-tertiary, #8f959e); background: var(--dsw-alias-bg-layer-2, #fff); cursor: pointer; box-shadow: 0 1px 3px rgb(31 35 41 / 8%); transition: color .12s ease, border-color .12s ease, background .12s ease; }
.mrrp-collapseHandle:hover { color: #0e8f84; border-color: #38c7bc; background: rgba(56, 199, 188, .06); }
.mrrp-singleCard { max-width: 720px; }
.mrrp-imRouteDesc { padding: 10px 12px; margin: 4px 0 12px; border-radius: 8px; color: var(--dsw-alias-label-secondary, #646a73); background: rgba(56, 199, 188, .08); border: 1px solid rgba(56, 199, 188, .22); font-size: 12.5px; line-height: 1.65; }
.mrrp-textarea { min-height: 74px; resize: vertical; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
.mrrp-ruleHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 14px 0 8px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12.5px; }
.mrrp-ruleRow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mrrp-ruleField { flex: 0 0 32%; min-width: 0; }
.mrrp-ruleValue { flex: 0 0 30%; min-width: 0; }
.mrrp-ruleCat { flex: 1 1 auto; min-width: 0; }
.mrrp-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.mrrp-contentHead { flex: 0 0 auto; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 22px clamp(16px, 3vw, 32px) 0; }
.mrrp-contentHead h2 { margin: 0; font-size: 20px; line-height: 26px; font-weight: 750; }
.mrrp-contentSub { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; }
.mrrp-contentBody { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px clamp(16px, 3vw, 32px) 32px; }
.mrrp-section { display: flex; flex-direction: column; gap: 16px; }
.mrrp-topSplit { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.mrrp-card { border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 2px rgb(31 35 41 / 3%); }
.mrrp-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-card-head h3 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 700; }
.mrrp-card-sub { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.mrrp-card-extra { display: flex; align-items: center; gap: 10px; }
.mrrp-card-extra-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mrrp-card-body { padding: 16px; }
.mrrp-card-foot { display: flex; justify-content: flex-end; padding-top: 4px; }
.mrrp-formGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
.mrrp-poolBox { margin-top: 14px; padding: 14px 14px 12px; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 12px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); display: grid; gap: 10px; }
.mrrp-poolHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.mrrp-poolTitle { font-weight: 600; font-size: 13px; color: var(--dsw-alias-text-l1, #1d2129); }
.mrrp-poolDesc { margin-top: 4px; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-text-l3, #86909c); }
.mrrp-poolSlots { display: grid; gap: 6px; }
.mrrp-poolSlotsHint { font-size: 12px; color: var(--dsw-alias-text-l3, #86909c); }
.mrrp-poolRow { display: grid; grid-template-columns: 1.2fr 1.2fr 78px 68px 1.6fr; gap: 8px; align-items: center; font-size: 12px; }
.mrrp-poolRowHead { color: var(--dsw-alias-text-l3, #86909c); }
.mrrp-poolName, .mrrp-poolModel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-text-l2, #4e5969); }
.mrrp-poolStat { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-text-l3, #86909c); }
.mrrp-poolEmpty { font-size: 12px; color: var(--dsw-alias-text-l3, #86909c); }
.mrrp-form { display: flex; flex-direction: column; gap: 16px; }
.mrrp-formToggles { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.mrrp-field { display: grid; gap: 6px; }
.mrrp-field-label { color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; font-weight: 560; }
.mrrp-hint { margin: 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.mrrp-input, .mrrp-select { width: 100%; box-sizing: border-box; min-height: 34px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: 13px/34px inherit; outline: none; }
.mrrp-select { cursor: pointer; }
.mrrp-textarea { min-height: 84px; padding: 8px 10px; line-height: 1.55; resize: vertical; font-family: inherit; }
.mrrp-input:focus-visible, .mrrp-select:focus-visible, .mrrp-textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 1px; }
.mrrp-toggle { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); cursor: pointer; }
.mrrp-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.mrrp-toggle-track { position: relative; width: 34px; height: 20px; flex: none; border-radius: 999px; background: var(--dsw-alias-bg-fill-2, #dfe1e5); transition: background .15s ease; }
.mrrp-toggle input:checked + .mrrp-toggle-track { background: #38c7bc; }
.mrrp-toggle-thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(31 35 41 / 25%); transition: transform .15s ease; }
.mrrp-toggle input:checked + .mrrp-toggle-track .mrrp-toggle-thumb { transform: translateX(14px); }
.mrrp-toggle-text { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.mrrp-toggle-text small { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.mrrp-btn { min-height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: 500 13px/1 inherit; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.mrrp-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.mrrp-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.mrrp-btn:disabled { opacity: .55; cursor: not-allowed; }
.mrrp-btn-primary { border-color: #38c7bc; color: #fff; background: #38c7bc; }
.mrrp-btn-primary:hover:not(:disabled) { background: #2fb3a8; }
.mrrp-btn-danger { border-color: var(--dsw-alias-state-error-primary, #d54941); color: var(--dsw-alias-state-error-primary, #d54941); }
.mrrp-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 8%, transparent); }
.mrrp-btn-small { min-height: 28px; padding: 0 9px; font-size: 12px; border-radius: 7px; }
.mrrp-btn-icon { width: 32px; height: 32px; padding: 0; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-btn-icon:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-btn-icon { display: inline-flex; align-items: center; justify-content: center; }
.mrrp-btn-icon .mrrp-ico { display: inline-flex; }
.mrrp-ico { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none; flex-shrink: 0; line-height: 1; font-weight: 600; font-style: normal; }
/* 默认禁用所有伪元素；仅对“纯 background / box-shadow”形状按类重新启用（现场验证此类可渲染） */
.mrrp-ico::before, .mrrp-ico::after { content: none; }
/* 加号 + */
.ico-plus::before, .ico-plus::after { content: ''; position: absolute; display: block; box-sizing: border-box; }
.ico-plus::before { left: 0.14em; top: 0.45em; width: 0.72em; height: 0.1em; border-radius: 0.05em; background: currentColor; }
.ico-plus::after { left: 0.45em; top: 0.14em; width: 0.1em; height: 0.72em; border-radius: 0.05em; background: currentColor; }
/* 导航：三层（模型分类配置） */
.ico-navLayers::before { content: ''; position: absolute; display: block; left: 0.06em; top: 0.08em; width: 0.76em; height: 0.18em; border-radius: 0.05em; background: currentColor; box-shadow: 0 0.26em 0 currentColor, 0 0.52em 0 currentColor; }
/* 导航：列表（模型列表） */
.ico-navList::before { content: ''; position: absolute; display: block; left: 0.18em; top: 0.16em; width: 0.64em; height: 0.1em; border-radius: 0.05em; background: currentColor; box-shadow: 0 0.24em 0 currentColor, 0 0.48em 0 currentColor; }
/* 导航：人（角色 / 用户） */
.ico-navPerson::before { content: ''; position: absolute; display: block; left: 50%; top: 0.1em; width: 0.3em; height: 0.3em; margin-left: -0.15em; border-radius: 50%; background: currentColor; }
.ico-navPerson::after { content: ''; position: absolute; display: block; left: 50%; top: 0.5em; width: 0.62em; height: 0.32em; margin-left: -0.31em; border-radius: 0.32em 0.32em 0.1em 0.1em; background: currentColor; }
/* 圆点 */
.ico-dot::before { content: ''; position: absolute; display: block; left: 50%; top: 50%; width: 0.42em; height: 0.42em; margin: -0.21em 0 0 -0.21em; border-radius: 50%; background: currentColor; }
/* 侧边栏入口：圆角方块（纯 background，渲染分界内最可靠） */
.ico-sidebarTile::before { content: ''; position: absolute; display: block; left: 50%; top: 50%; width: 0.5em; height: 0.5em; margin: -0.25em 0 0 -0.25em; border-radius: 0.13em; background: currentColor; }
/* 导航：路由配置（折线三点：路径转折 / 路由分发） */
.ico-navRoute::before { content: ''; position: absolute; display: block; left: 50%; top: 50%; width: 0.18em; height: 0.18em; margin: -0.09em 0 0 -0.09em; border-radius: 50%; background: currentColor; box-shadow: -0.3em 0.28em 0 currentColor, 0.3em -0.28em 0 currentColor; }
/* 导航：决策模型配置（中心点 + 右上分支点：决策 / 选择） */
.ico-navDecision::before { content: ''; position: absolute; display: block; left: 50%; top: 50%; width: 0.18em; height: 0.18em; margin: -0.09em 0 0 -0.09em; border-radius: 50%; background: currentColor; box-shadow: 0.34em -0.34em 0 currentColor; }
/* 其余图标（× « » √ → ▼ ▶ ⌂ 等）一律使用文本字符渲染，CSS 形状仅对上述“纯背景/阴影”类保留 */
.mrrp-sidebarIcon { color: #38c7bc; display: inline-flex; }
.mrrp-pill { display: inline-flex; align-items: center; gap: 6px; min-height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--dsw-alias-bg-module-platform, #f2f3f5); color: var(--dsw-alias-label-secondary, #646a73); white-space: nowrap; }
.mrrp-pill-brand { color: #0e8f84; background: rgba(56, 199, 188, .14); }
.mrrp-pill-info { color: var(--dsw-alias-state-business-primary, #3370ff); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 10%, transparent); }
.mrrp-pill-muted { color: var(--dsw-alias-label-tertiary, #8f959e); background: transparent; }
.mrrp-catList { display: flex; flex-direction: column; gap: 8px; }
.mrrp-catItem { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 12px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; cursor: pointer; transition: border-color .12s ease, background .12s ease; }
.mrrp-catItem:hover { border-color: #38c7bc; }
.mrrp-catItem.is-active { border-color: #38c7bc; background: rgba(56, 199, 188, .06); }
.mrrp-catItem-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mrrp-catItem-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mrrp-catItem-name { font-size: 13px; font-weight: 650; }
.mrrp-catItem-desc { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.mrrp-catItem-actions { display: flex; align-items: center; gap: 2px; }
.mrrp-tableWrap { overflow-x: auto; }
.mrrp-table { width: 100%; border-collapse: collapse; table-layout: auto; min-width: 720px; }
.mrrp-table th, .mrrp-table td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); font-size: 13px; vertical-align: middle; }
.mrrp-table th { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; font-weight: 600; white-space: nowrap; }
.mrrp-table thead th { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: inset 0 -1px 0 var(--dsw-alias-border-regular, #e6e8eb); }
.mrrp-table th.is-right, .mrrp-table td.is-right { text-align: right; }
.mrrp-table tr:last-child td { border-bottom: 0; }
.mrrp-table tbody tr { transition: background-color .12s ease; }
.mrrp-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover, #fafbfc); }
/* 列宽自适应：宽度按内容算，只用语义类决定「谁吃余量 / 谁收紧到内容」 */
.mrrp-table th.cell-key { width: auto; min-width: 170px; }
.mrrp-table th.cell-grow { width: auto; }
.mrrp-table th.cell-pill { width: auto; min-width: 110px; }
.mrrp-table th.cell-tight, .mrrp-table th.cell-act { width: 1%; white-space: nowrap; }
.mrrp-table td.cell-tight, .mrrp-table td.cell-act { white-space: nowrap; }
.mrrp-table td.cell-key, .mrrp-table td.cell-grow, .mrrp-table td.cell-pill { min-width: 0; }
.mrrp-cellClip { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-width: 360px; white-space: normal; word-break: break-word; line-height: 1.45; }
.mrrp-cellClipNarrow { display: block; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 模型列表专用：列宽随内容与窗口自适应（不再写死百分比），并给列表一个最低可见高度，
   展开「擅长类型」多选浮层时列表不会被压扁；这里不做 overflow 裁剪，浮层可正常溢出显示 */
.mrrp-tableWrap-model { overflow-x: auto; min-height: 360px; }
.mrrp-table-model { min-width: 880px; }
.mrrp-pill-clip { max-width: 190px; }
.mrrp-pillText { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-modelCell { display: flex; flex-direction: column; gap: 2px; min-width: 0; max-width: 320px; }
.mrrp-modelName { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-modelId { color: var(--dsw-alias-label-tertiary, #8f959e); font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-bindCell { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.mrrp-profileCell { display: block; min-width: 0; }
.mrrp-profileEditor { display: block; width: 100%; min-width: 0; }
.mrrp-profileScene { width: 150px; height: 30px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 6px; font-size: 12px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-text, #1a1d21); outline: none; box-sizing: border-box; }
.mrrp-combobox { position: relative; display: flex; flex-direction: column; min-width: 0; width: 100%; }
.mrrp-combobox-input { display: flex; align-items: center; justify-content: space-between; min-height: 32px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 6px; cursor: pointer; background: var(--dsw-alias-bg-layer-1, #fff); transition: border-color .15s ease, box-shadow .15s ease; }
.mrrp-combobox-input:hover { border-color: var(--dsw-alias-border-l2, #d9dde3); }
.mrrp-combobox.is-open .mrrp-combobox-input { border-color: #38c7bc; box-shadow: 0 0 0 2px rgba(56, 199, 188, .14); }
.mrrp-combobox-field { flex: 1; min-width: 0; border: none; outline: none; font-size: 12px; background: transparent; color: var(--dsw-alias-text, #1a1d21); }
.mrrp-combobox-value { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-text, #1a1d21); }
.mrrp-combobox-placeholder { color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-combobox-arrow { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8f959e); margin-left: 8px; flex: none; transition: transform .18s ease; }
.mrrp-combobox.is-open .mrrp-combobox-arrow { transform: rotate(180deg); }
.mrrp-combobox-panel { position: absolute; top: calc(100% + 6px); left: 0; min-width: 280px; max-width: 480px; width: max-content; z-index: 200; max-height: 220px; overflow-y: auto; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; box-shadow: 0 10px 28px rgba(0, 0, 0, .12); padding: 6px; animation: mrrpPop .16s ease; }
.mrrp-combobox-panel.is-fixed { position: fixed; top: auto; left: auto; max-height: none; }
@keyframes mrrpPop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
.mrrp-combobox-option { padding: 8px 10px; font-size: 12px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-text, #1a1d21); transition: background .12s ease; }
.mrrp-combobox-option:hover, .mrrp-combobox-option.is-highlight { background: var(--dsw-alias-interactive-bg-hover, #f5f6f8); }
.mrrp-combobox-option.is-selected { color: var(--dsw-alias-brand, #3370ff); font-weight: 600; }
.mrrp-combobox-empty { padding: 12px 10px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); text-align: center; }
/* 类型多选（模型画像 / 决策模型提供方） */
.mrrp-multiselect { min-width: 132px; }
.mrrp-multiTags { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; }
.mrrp-multiTag { display: inline-flex; align-items: center; max-width: 150px; height: 18px; padding: 0 6px; border-radius: 4px; font-size: 11px; background: rgba(56, 199, 188, .14); color: #0e8f84; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mrrp-multiMore { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 4px; font-size: 11px; background: var(--dsw-alias-interactive-bg-hover, #f5f6f8); color: var(--dsw-alias-label-secondary, #565d66); white-space: nowrap; }
.mrrp-multiPanelHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #8f959e); border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); margin-bottom: 4px; }
.mrrp-multiClear { border: none; background: transparent; color: #0e8f84; font-size: 12px; cursor: pointer; padding: 2px 6px; border-radius: 4px; transition: background .12s ease; }
.mrrp-multiClear:hover { background: rgba(56, 199, 188, .12); }
.mrrp-multiOption { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 12px; border-radius: 6px; cursor: pointer; color: var(--dsw-alias-text, #1a1d21); transition: background .12s ease; }
.mrrp-multiOption:hover { background: var(--dsw-alias-interactive-bg-hover, #f5f6f8); }
.mrrp-multiOption input { margin: 0; width: 14px; height: 14px; accent-color: #38c7bc; cursor: pointer; flex: none; }
.mrrp-multiOptionLabel { min-width: 0; white-space: normal; word-break: break-word; line-height: 1.45; }
.mrrp-multiOption.is-checked { color: #0e8f84; font-weight: 600; background: rgba(56, 199, 188, .08); }
.mrrp-multiOption.is-checked:hover { background: rgba(56, 199, 188, .14); }
.mrrp-bindSelect { min-width: 120px; max-width: 190px; }
.mrrp-tsRow { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.mrrp-tsList { display: flex; flex-wrap: wrap; gap: 8px; }
.mrrp-tsItem { display: inline-flex; align-items: center; gap: 4px; }
.mrrp-tsRemove { border: none; background: none; padding: 0 2px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-tertiary, #8f959e); cursor: pointer; }
.mrrp-tsRemove:hover { color: #d54941; }
/* 日志设置：信息卡 + 文件列表 + 管理面板 */
.mrrp-dirRow { display: flex; align-items: center; gap: 8px; }
.mrrp-dirRow .mrrp-btn { flex: 0 0 auto; white-space: nowrap; }
.mrrp-dirInput { flex: 1 1 auto; min-width: 0; font-family: var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace); font-size: 12px; }
.mrrp-dirNote { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.mrrp-dirNoteLabel { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-dirPath { font-family: var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f2f3f5); padding: 2px 8px; border-radius: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.mrrp-logInfoCard { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-regular, #e6e8eb); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-logInfoPath { font-family: var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-logInfoStats { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.mrrp-logInfoStat { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); display: inline-flex; align-items: baseline; gap: 4px; }
.mrrp-logInfoStat b { font-size: 13px; font-weight: 700; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-logSettingsDanger { margin-top: 16px; display: flex; align-items: center; }
.mrrp-logFiles { display: flex; flex-direction: column; gap: 6px; }
.mrrp-logFileRow { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-regular, #e6e8eb); border-radius: 10px; flex-wrap: wrap; transition: border-color .15s ease, background .15s ease; }
.mrrp-logFileRow:hover { border-color: #38c7bc; background: color-mix(in srgb, #38c7bc 4%, transparent); }
.mrrp-logFileRow.is-today { border-color: #38c7bc; background: color-mix(in srgb, #38c7bc 5%, transparent); }
.mrrp-logFileName { font-family: var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace); font-size: 12px; color: var(--dsw-alias-label-primary, #1f2329); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
.mrrp-logToday { margin-left: 6px; font-size: 11px; color: #0c6b64; border: 1px solid #38c7bc; border-radius: 4px; padding: 0 5px; flex: none; }
.mrrp-logFileStat { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); flex: none; }
.mrrp-logFileTime { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); flex: none; margin-left: auto; }
.mrrp-logFileManage { margin-top: 10px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-regular, #e6e8eb); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-logFileManageHead { display: flex; align-items: center; gap: 10px; font-size: 12px; font-weight: 600; margin-bottom: 10px; flex-wrap: wrap; }
.mrrp-logFileManageTitle { display: inline-flex; align-items: center; gap: 4px; }
.mrrp-logFileManageTitle code { font-family: var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace); font-weight: 600; color: #0c6b64; }
.mrrp-logFileManageCount { font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-logRows { margin-top: 8px; max-height: 300px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.mrrp-logRowItem { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
.mrrp-logRowItem:hover { background: color-mix(in srgb, var(--dsw-alias-fill-tertiary, #eef0f2) 60%, transparent); }
.mrrp-logRowItem.is-sel { background: color-mix(in srgb, #38c7bc 12%, transparent); }
.mrrp-logRowItem input[type='checkbox'] { flex: none; }
.mrrp-logRowTime { font-family: var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace); font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); flex: none; }
.mrrp-logRowText { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mrrp-logRowsAct { margin-top: 8px; }
/* 按钮变体 */
.mrrp-btn.is-ghost { border-color: transparent; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-fill-tertiary, #eef0f2); }
.mrrp-btn.is-ghost:hover { color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-btn.is-soft { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 45%, transparent); color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 7%, transparent); }
.mrrp-btn.is-soft:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 14%, transparent); }
/* hover 角标：? 图标 + 悬停气泡 */
.mrrp-tip-wrap { position: relative; display: inline-flex; align-items: center; margin-left: 6px; cursor: help; }
.mrrp-tip-ico { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; font-size: 10px; line-height: 1; color: #fff; background: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-tip-bubble { position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; display: none; width: 260px; padding: 8px 10px; border-radius: 8px; font-size: 12px; font-weight: 400; line-height: 1.5; color: #f2f3f5; background: #1f2329; box-shadow: 0 6px 18px -6px rgb(15 18 24 / 40%); }
.mrrp-tip-wrap:hover .mrrp-tip-bubble { display: block; }
.mrrp-tip-wrap.is-wide .mrrp-tip-bubble { width: 320px; }
/* 确认弹窗 */
.mrrp-modal-mask { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; background: rgb(15 18 24 / 45%); }
.mrrp-modal { width: 380px; max-width: calc(100vw - 32px); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 12px 40px -8px rgb(15 18 24 / 35%); padding: 18px 18px 14px; }
.mrrp-modal-title { font-size: 14px; font-weight: 650; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-modal-desc { margin-top: 8px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #646a73); word-break: break-all; }
.mrrp-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.mrrp-linkHint { display: inline-flex; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-muted { color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-rowActions { display: inline-flex; align-items: center; gap: 2px; }
.mrrp-search { display: flex; align-items: center; gap: 6px; min-width: 160px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-tertiary, #8f959e); background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-search-input { flex: 1 1 auto; min-width: 0; min-height: 28px; border: 0; outline: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font: 13px/1 inherit; }
.mrrp-roleList, .mrrp-deptList { display: flex; flex-direction: column; gap: 8px; }
.mrrp-roleItem, .mrrp-deptItem { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 11px 12px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; }
.mrrp-roleItem-main, .mrrp-deptItem-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.mrrp-roleItem-name, .mrrp-deptItem-name { font-size: 13px; font-weight: 650; }
.mrrp-roleItem-meta, .mrrp-deptItem-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mrrp-roleItem-desc { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.mrrp-roleItem-actions, .mrrp-deptItem-actions { display: flex; align-items: center; gap: 2px; }
.mrrp-defaultTag { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; font-size: 11px; color: #8a5a00; background: #fff4d6; border: 1px solid #f3d98b; white-space: nowrap; }
/* 权限页 */
.mrrp-permNote { margin: 0 0 12px; padding: 10px 14px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 19px; }
.mrrp-permNote strong { color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-permDefaultRow { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 12px; padding: 10px 14px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-permDefaultLabel { font-size: 12.5px; font-weight: 650; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-permDefaultPick { width: 220px; }
.mrrp-permWarn { color: #b45309 !important; }
.mrrp-permDeny { color: #c53030; font-weight: 600; }
/* 用户表权限列：权限名 + 来源标记（标记用浅色小字，避免被误读成权限名的一部分） */
.mrrp-permCell { display: inline-flex; align-items: baseline; gap: 5px; max-width: 240px; min-width: 0; }
.mrrp-permCellNames { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-permCellSrc { flex: none; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
/* 用户弹窗：有效权限摘要（解释「自身没勾也有权限」是继承来的） */
.mrrp-permEffective { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin: 0 0 8px; padding: 8px 11px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 9px; background: var(--dsw-alias-fill-bg, #f7f8fa); font-size: 12px; line-height: 18px; }
.mrrp-permEffective.is-deny { border-color: #f5c2c2; background: #fff7f7; }
.mrrp-permEffectiveLabel { color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-permEffectiveValue { font-weight: 650; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-permEffective.is-deny .mrrp-permEffectiveValue { color: #c53030; }
.mrrp-permEffectiveSrc { color: var(--dsw-alias-label-secondary, #646a73); }
.mrrp-capGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
.mrrp-capItem { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-capDesc { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 15px; }
/* 部门页：树形展开（点击部门展开子部门与部门内用户） */
.mrrp-deptTree { display: flex; flex-direction: column; gap: 2px; }
.mrrp-deptNode { display: flex; flex-direction: column; }
.mrrp-deptRow { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-fill-bg, #fff); min-width: 0; cursor: pointer; }
.mrrp-deptRow:hover { border-color: rgba(56,199,188,.45); }
.mrrp-deptCaret { width: 18px; flex: 0 0 18px; text-align: center; color: var(--dsw-alias-label-secondary, #646a73); cursor: pointer; user-select: none; font-size: 11px; line-height: 18px; }
.mrrp-deptCaret.is-empty { color: #c9cdd4; cursor: default; }
.mrrp-deptName { flex: 0 1 auto; min-width: 0; font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-deptStats { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 6px; overflow: hidden; }
.mrrp-deptRow-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.mrrp-deptChildren { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.mrrp-deptUsers { display: flex; flex-direction: column; gap: 2px; margin-bottom: 2px; }
.mrrp-deptUserRow { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); border-left: 2px solid rgba(56,199,188,.35); min-width: 0; }
.mrrp-deptUserName { font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); flex: none; }
.mrrp-deptUserRole { color: var(--dsw-alias-label-tertiary, #8f959e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-deptUserRole.is-fallback { color: #0e8f84; }
.mrrp-deptUserId { margin-left: auto; flex: none; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dsw-alias-label-tertiary, #8f959e); word-break: break-all; }
.mrrp-twoCol { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.mrrp-checkGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; }
.mrrp-checkItem { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; min-height: 22px; }
.mrrp-checkItem input { width: 15px; height: 15px; accent-color: #38c7bc; flex: none; }
/* 分类弹窗：绑定模型选择器（搜索 + 分页） */
.mrrp-bindPanel { border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); overflow: hidden; }
.mrrp-bindHead { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-bindSearch { flex: 1; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 7px; font-size: 12px; color: var(--dsw-alias-label-primary, #1f2329); background: transparent; }
.mrrp-bindSearch:focus { outline: none; border-color: #38c7bc; box-shadow: 0 0 0 2px rgba(56,199,188,.15); }
.mrrp-bindCount { flex: none; font-size: 12px; font-weight: 600; color: #0e8f84; white-space: nowrap; }
.mrrp-bindBody { max-height: 216px; overflow-y: auto; padding: 10px; }
.mrrp-bindGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.mrrp-bindItem { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid transparent; border-radius: 8px; font-size: 13px; cursor: pointer; min-width: 0; }
.mrrp-bindItem:hover { background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.mrrp-bindItem.is-checked { border-color: #38c7bc; background: rgba(56,199,188,.08); }
.mrrp-bindItem input { width: 15px; height: 15px; accent-color: #38c7bc; flex: none; }
.mrrp-bindMeta { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
.mrrp-bindMeta small { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.mrrp-bindFoot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-bindMuted { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-bindPages { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
.mrrp-bindNav { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 26px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 6px; font-size: 13px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-layer-1, #fff); cursor: pointer; }
.mrrp-bindNav:hover:not(:disabled) { border-color: #38c7bc; color: #0e8f84; }
.mrrp-bindNav:disabled { opacity: .45; cursor: not-allowed; }
.mrrp-bindAll { font-size: 12px; }
.mrrp-bindPageNo { min-width: 42px; text-align: center; }
.mrrp-bindEmpty { padding: 26px 12px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 角色弹窗：每个选中分类的模型配置卡片 */
.mrrp-roleCatList { display: flex; flex-direction: column; gap: 10px; }
.mrrp-roleCatItem { border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; padding: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-roleCatHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.mrrp-roleCatName { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-roleCatCount { font-size: 12px; color: #0e8f84; white-space: nowrap; }
.mrrp-userDeptChips { display: flex; flex-wrap: wrap; gap: 4px; max-width: 200px; overflow: hidden; }
/* 用户：ID / 角色回退 */
.mrrp-idStatic { display: flex; align-items: center; color: var(--dsw-alias-label-primary, #1f2329); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.mrrp-userId { display: block; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.mrrp-roleFallback { color: #0e8f84; font-size: 12px; }
/* 路由页：决策模型提供方卡片 */
.mrrp-card-head { display: flex; align-items: center; gap: 10px; }
.mrrp-providerList { display: flex; flex-direction: column; gap: 10px; }
.mrrp-providerCard { border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-providerHead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mrrp-providerName { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-formatBadge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.mrrp-format-laya { background: rgba(56,199,188,.12); color: #0e8f84; }
.mrrp-format-openai { background: rgba(61,116,240,.12); color: #3d74f0; }
.mrrp-format-generic { background: rgba(132,94,247,.12); color: #845ef7; }
.mrrp-providerState { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-providerActions { margin-left: auto; display: flex; gap: 6px; }
.mrrp-providerMeta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
.mrrp-modelChips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.mrrp-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-chip button { border: 0; background: none; color: var(--dsw-alias-label-tertiary, #8f959e); cursor: pointer; padding: 0; font-size: 12px; line-height: 1; }
.mrrp-chip button:hover { color: #d92d20; }
.mrrp-modelAdd { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
.mrrp-modelAdd .mrrp-bindSearch { flex: 1; }
.mrrp-testLine { margin-top: 10px; font-size: 12px; }
.mrrp-test-ok { color: #0e8f84; }
.mrrp-test-error { color: #d92d20; }
.mrrp-userName { font-weight: 600; }
.mrrp-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 34px 16px; text-align: center; }
.mrrp-empty-icon { display: flex; color: var(--dsw-alias-label-tertiary, #8f959e); opacity: .7; }
.mrrp-empty-title { font-size: 14px; font-weight: 650; }
.mrrp-empty-desc { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; line-height: 18px; max-width: 320px; }
.mrrp-empty-action { padding-top: 8px; }
.mrrp-notice { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.mrrp-notice-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 30%, var(--dsw-alias-border-l2, #dfe1e5)); color: var(--dsw-alias-state-warn-primary, #d97706); }
.mrrp-kv { display: flex; flex-direction: column; gap: 8px; }
.mrrp-kvRow { display: flex; align-items: baseline; gap: 12px; font-size: 12px; line-height: 18px; }
.mrrp-kvKey { flex: 0 0 92px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-kvPath { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.mrrp-modal-overlay, .mrrp-drawerOverlay { position: fixed; inset: 0; z-index: 1000; background: rgba(15, 18, 24, .38); display: flex; align-items: flex-start; justify-content: center; }
.mrrp-modal-overlay { align-items: center; padding: 24px; }
.mrrp-modal { max-width: 100%; max-height: 90vh; overflow: auto; border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 12px 40px rgb(15 18 24 / 22%); }
.mrrp-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-modal-head h3 { margin: 0; font-size: 15px; font-weight: 700; }
.mrrp-modal-body { padding: 18px 16px; }
.mrrp-modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-modal-actions { display: flex; gap: 8px; }
.mrrp-modal-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-drawerOverlay { align-items: center; justify-content: center; padding: 24px; }
.mrrp-floatCard { width: 420px; max-width: 92vw; max-height: 82vh; display: flex; flex-direction: column; background: var(--dsw-alias-bg-module-platform, #f7f8fa); border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 14px; box-shadow: 0 12px 40px rgb(15 18 24 / 22%); overflow: hidden; }
.mrrp-floatCard-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-floatCard-head .mrrp-brandRow { gap: 6px; }
.mrrp-floatCard-head .mrrp-brandText { font-size: 15px; font-weight: 700; }
.mrrp-floatCard-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.mrrp-drawer { width: 340px; max-width: 88vw; height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-module-platform, #f7f8fa); box-shadow: -12px 0 32px rgb(15 18 24 / 16%); }
.mrrp-drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-drawer-head h3 { margin: 0; font-size: 16px; font-weight: 700; }
.mrrp-drawer-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.mrrp-drawer-foot { padding: 14px 18px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-toasts { position: fixed; top: 16px; right: 16px; z-index: 1200; display: flex; flex-direction: column; gap: 8px; max-width: 320px; }
.mrrp-toast { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-radius: 10px; font-size: 12px; line-height: 18px; color: #fff; background: #26303a; box-shadow: 0 6px 20px rgb(15 18 24 / 20%); animation: mrrpToastIn .18s ease; }
.mrrp-toast-success { background: #1a9d63; }
.mrrp-toast-error { background: #d54941; }
.mrrp-toast-msg { word-break: break-word; }
.mrrp-toast .mrrp-btn-icon { color: rgba(255,255,255,.75); }
.mrrp-spinner { display: inline-block; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: mrrpSpin .7s linear infinite; }
@keyframes mrrpSpin { to { transform: rotate(360deg); } }
@keyframes mrrpToastIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@media (max-width: 900px) {
  .mrrp-topSplit, .mrrp-twoCol { grid-template-columns: 1fr; }
  .mrrp-formGrid { grid-template-columns: 1fr; }
  .mrrp-poolRow { grid-template-columns: 1fr 1fr; }
  .mrrp-poolStat { grid-column: 1 / -1; }
  .mrrp-ruleRow { flex-wrap: wrap; }
  .mrrp-ruleField, .mrrp-ruleValue, .mrrp-ruleCat { flex: 1 1 100%; }
}
/* 插件详情页「打开 MRRP」按钮 */
.mrrp-pluginOpen {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 0 14px; height: 32px; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; cursor: pointer;
}
.mrrp-pluginOpen:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); border-color: var(--dsw-alias-border-l3, #c9cdd4); }
/* 路由决策日志页（列宽交给 cell-* 语义类，不再按百分比硬切） */
.mrrp-logTable { min-width: 760px; }
.mrrp-logTable .mrrp-logSender { display: block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-logRow { cursor: pointer; }
.mrrp-logRow.is-open { background: rgba(56, 199, 188, .06); }
.mrrp-logTime { color: var(--dsw-alias-label-tertiary, #8f959e); font: 11.5px/16px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.mrrp-tag { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; font-weight: 600; white-space: nowrap; }
.mrrp-tag-ok { color: #0f8f63; background: rgba(26, 157, 99, .12); }
.mrrp-tag-warn { color: #b2540c; background: rgba(219, 128, 18, .14); }
.mrrp-tag-err { color: #c0392b; background: rgba(213, 73, 65, .12); }
.mrrp-tag-info { color: #2a5ac7; background: rgba(51, 112, 255, .10); }
.mrrp-logDetail { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mrrp-logModel { display: inline-block; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-logText { display: block; max-width: 520px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-logExpand { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; white-space: nowrap; }
.mrrp-logRaw {
  margin: 0; padding: 14px 16px; border-radius: 10px;
  background: #1c2230; color: #d6dbe6;
  font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word;
  min-height: 240px; max-height: 300px; overflow-y: auto;
}
.mrrp-jk { color: #7dd3fc; }
.mrrp-js { color: #86efac; }
.mrrp-jn { color: #fbbf24; }
.mrrp-jb { color: #f472b6; }
/* 日志详情：底边栏布局——上方表格滚动区 + 底部固定面板（点任意行详情均无需滚动即可看到原始记录） */
.mrrp-logArea { position: relative; max-height: calc(100vh - 200px); display: flex; flex-direction: column; }
.mrrp-logArea .mrrp-tableWrap { max-height: inherit; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
.mrrp-logPanel {
  flex: none; max-height: 0; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, #fff);
  border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3);
  border-radius: 0 0 10px 10px;
  box-shadow: 0 -6px 16px -10px rgb(15 18 24 / 25%);
  transition: max-height .22s ease;
  display: flex; flex-direction: column;
}
.mrrp-logPanel.is-open { max-height: 420px; }
.mrrp-logPanel-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-logPanel-title { font-size: 13px; font-weight: 650; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-logMeta { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.mrrp-logMetaChip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 20px; background: #fff; border: 1px solid var(--dsw-alias-border-regular, #e6e8eb); font-size: 12px; }
.mrrp-logMetaK { color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-logMetaV { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 600; }
.mrrp-logPanel-body { min-height: 0; overflow: hidden; padding: 12px 14px 14px; }
`;

    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      const element = document.createElement('style');
      element.dataset.dshMrrp = 'styles';
      element.textContent = styles;
      document.head.appendChild(element);
      return () => element.remove();
    }

    /* ============================== 侧边栏图标 / 打开按钮 ============================== */
    function SidebarIcon({ size = 16 }) {
      // 侧边栏入口图标：宿主侧边栏对插件图标渲染历史上不稳定（钉卡片同样无图标）。
      // 用「纯 background 圆角方块」形状（渲染分界内最可靠），品牌青绿，替代文本箭头。
      return h('span', {
        className: 'mrrp-ico ico-sidebarTile mrrp-sidebarIcon',
        'aria-hidden': 'true',
        style: { width: size + 'px', height: size + 'px', fontSize: size + 'px', lineHeight: '1' },
      });
    }

    // 插件详情页的「打开 MRRP」按钮。DSH 靠 subject + packageName 匹配过滤，
    // 只有当前查看的插件是 dsh-mrrp 时才渲染，天然不会泄漏到其它插件页。
    function OpenMrrpAction({ subject, packageName, onOpen, t }) {
      if (subject?.kind !== 'bundle' && subject?.kind !== 'row') return null;
      if (subject.pkg?.name !== packageName) return null;
      if (subject.kind === 'row' && subject.row?.moduleName !== packageName) return null;
      return h('button', { type: 'button', className: 'mrrp-pluginOpen', onClick: onOpen }, t('打开 MRRP'));
    }

    /* ============================== 挂载 ============================== */
    exports.name = 'dsh-mrrp';
    exports.inject = ['slots', 'connection', 'locale'];

    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-mrrp: locale');
      const t = ctx.locale.bind(NAMESPACE);
      const disposers = [installStyles()];

      let panelRegistered = false;
      let stopSidebar = null;
      let stopActions = null;
      let pageCtxRef = null;
      // 侧边栏默认可见：注册即出现，只有 host 显式配置 hide 才收起。
      // 避免「等 sidebar-entry.get RPC 成功才注册」——host RPC 未就绪时入口永远不出现。
      let sidebarVisible = true;
      // 根据 sidebarVisible 动态注册/注销 DSH 侧边栏的「MRRP」入口。
      // eslint-disable-next-line no-var
      var syncSidebar = null;
      syncSidebar = () => {
        const pc = pageCtxRef;
        if (!pc) return;
        if (sidebarVisible) {
          if (!stopSidebar) {
            stopSidebar = pc.slots.inject('sidebar.panellist', () => (
              pc.slots.register({
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 11,
                label: () => t('MRRP'),
                locale: NAMESPACE,
              }, SidebarIcon)
            ));
          }
        } else if (stopSidebar) {
          stopSidebar();
          stopSidebar = null;
        }
      };
      // 设置里改「侧边栏入口」后，立刻同步宿主侧边栏显隐（show/hide 即时生效，auto 回查 host）。
      const applySidebarMode = (mode) => {
        if (mode === 'show') { sidebarVisible = true; syncSidebar(); return; }
        if (mode === 'hide') { sidebarVisible = false; syncSidebar(); return; }
        rpcCall(ctx, 'sidebar-entry.get', {}).then((entry) => {
          sidebarVisible = entry?.visible !== false;
          syncSidebar();
        }).catch(() => undefined);
      };

      if (typeof ctx.inject === 'function') {
        ctx.inject(['layout'], (pageCtx) => {
          pageCtxRef = pageCtx;
          const panels = pageCtx.slots.inject('main', () => {
            const unregisterPage = pageCtx.slots.register({
              name: 'main',
              key: PANEL_ID,
              locale: NAMESPACE,
              inject: () => ({ ctx, applySidebarMode }),
            }, MrrpPage);
            panelRegistered = true;
            // 插件详情页「打开 MRRP」按钮（DSH 靠 packageName 过滤，不会泄漏到其它插件页）。
            stopActions = pageCtx.slots.inject('plugins.detail.actions', () => (
              pageCtx.slots.register({
                name: 'plugins.detail.actions',
                id: 'dsh-mrrp-open',
                order: 21,
                locale: NAMESPACE,
                inject: () => ({
                  packageName: 'dsh-mrrp',
                  onOpen: () => pageCtx.layout.selectPanel(PANEL_ID),
                }),
              }, OpenMrrpAction)
            ));
            // 侧边栏默认已注册（sidebarVisible=true），异步读 host 配置：仅确认为 hide 时收起。
            syncSidebar();
            rpcCall(ctx, 'sidebar-entry.get', {}).then((entry) => {
              sidebarVisible = entry?.visible !== false;
              syncSidebar();
            }).catch(() => undefined);
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

      // 挂进 DSH 全局设置页：左侧出现「MRRP」入口，右侧渲染完整控制台。
      if (typeof ctx.slots?.inject === 'function' && typeof ctx.slots.register === 'function') {
        const stopSettings = ctx.slots.inject('settings.section', () => {
          const unregister = ctx.slots.register({
            name: 'settings.section',
            id: PANEL_ID,
            order: 22,
            label: () => t('MRRP'),
            locale: NAMESPACE,
            inject: () => ({ ctx, applySidebarMode }),
          }, MrrpPage);
          return () => unregister();
        });
        disposers.push(() => stopSettings?.());
      }

      if (typeof ctx.provide === 'function') {
        ctx.provide('dshMrrpClient', Object.freeze({
          version: 1,
          render: () => h(MrrpPage, { ctx }),
          selectPanel: () => ctx.get?.('layout')?.selectPanel?.(PANEL_ID),
          panelRegistered: () => panelRegistered,
        }));
      }

      ctx.effect(() => () => {
        for (const dispose of disposers.reverse()) {
          try { dispose(); } catch { /* ignore */ }
        }
      }, 'dsh-mrrp: client styles and panel');
    };

    exports.__internals = {
      MrrpPage,
      RouteConfigPage,
      DecisionConfigPage,
      CategoryConfigPage,
      ModelListPage,
      TypeScenePage,
      RolePage,
      DeptPage,
      UserPage,
      LogsPage,
      LogSettingsPage,
      SettingsDrawer,
    };

    return module.exports;
  },
});
