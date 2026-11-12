/**
 * EAB 的 DSH client 兼容运行时。
 *
 * DSH 的插件页面不是 HTML，而是一段 `window.__ModuleLoader__.load({id, factory})` bundle：
 *   const React = require('react')
 *   exports.apply = (ctx) => ctx.slots.register({name:'main', key:'x'}, Component)
 *
 * 这里在控制台里重建它依赖的那几个契约：模块加载器、React、slots、locale、connection.rpc、
 * effect / provide / inject / get。插件源码一行不用改。
 */
;(function () {
  'use strict';

  var pending = [];
  var loadedExports = null;
  var config = { id: '', company: '', rpc: null, inject: [] };
  var slots = Object.create(null);
  var listeners = [];
  var disposers = [];
  var locales = Object.create(null);
  var provided = Object.create(null);
  var shellApi = null;
  var extraRenderers = [];
  var rootContext = null;
  var bootErrors = [];
  var moduleCache = Object.create(null);
  var availableModules = Object.create(null);
  var missingModules = Object.create(null);

  var moduleProviders = {
    'react': function () { return window.React },
    'react-dom': function () { return window.ReactDOM },
    'react-dom/client': function () { return window.ReactDOM },
    'react/jsx-runtime': makeJsxRuntime,
    'react/jsx-dev-runtime': makeJsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': makePrimitives,
    '@deepseek-ai/dsh-client-connection': makeConnection,
    '@deepseek-ai/dsh-client-ui-slots': makeSlots,
    '@deepseek-ai/dsh-client-ui-settings': function () {
      return { settings: makeSettings(), useSettings: function () { return makeSettings() } };
    },
    '@deepseek-ai/dsh-client-locale': makeLocale,
    '@deepseek-ai/dsh-client-runtime': function () {
      return {
        definePlugin: function (value) { return value },
        createPlugin: function (value) { return value },
      };
    },
  };

  function notify() {
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i]();
      } catch (error) {
        console.warn('[dsh-runtime] listener failed', error);
      }
    }
    for (var j = 0; j < extraRenderers.length; j += 1) {
      try {
        extraRenderers[j]();
      } catch (error) {
        console.warn('[dsh-runtime] extra render failed', error);
      }
    }
  }

  function makeModuleShim(name) {
    var target = {};
    return new Proxy(target, {
      get: function (_target, prop) {
        if (prop === '__esModule') return true;
        if (prop === 'default') return target;
        if (prop === 'then') return undefined;
        if (!(prop in target)) {
          target[prop] = function () { return null; };
        }
        return target[prop];
      },
    });
  }

  function requireModule(name) {
    if (moduleCache[name]) return moduleCache[name]
    var provider = moduleProviders[name]
    if (provider) {
      availableModules[name] = true
      moduleCache[name] = provider()
      return moduleCache[name]
    }
    // 未实现的 DSH 内部包不能伪装成完整模块：记录到 missingModules，
    // 页面状态栏会明确显示缺哪个模块；同时仍返回可解构的 Proxy，
    // 让插件能完成 apply，而不是被 undefined 解构直接打断。
    if (!missingModules[name]) {
      missingModules[name] = true
      console.warn('[dsh-runtime] module shim:', name)
    }
    return makeModuleShim(name)
  }

  function makeJsxRuntime() {
    var React = window.React
    function jsx(type, props, key) {
      var next = props || {}
      if (key !== undefined && key !== null) {
        next = Object.assign({}, next, { key: key })
      }
      return React.createElement(type, next)
    }
    return {
      Fragment: React.Fragment,
      jsx: jsx,
      jsxs: jsx,
      jsxDEV: jsx,
    }
  }

  /**
   * DSH 的 `@deepseek-ai/dsh-client-ui-primitives` 是构建期打进 renderer 的组件库。
   * EAB 无法直接加载它的 CSS module / shiki / simple-icons 源码，这里实现插件实际用到的
   * 导出（MarkdownText、JsonTree、Menu、StateDot、Tooltip、图标、剪贴板等），
   * 未列出的组件用一个通用占位组件兜底，避免插件因解构 undefined 而整页白屏。
   */
  function makePrimitives() {
    var React = window.React
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useLayoutEffect = React.useLayoutEffect
    var useRef = React.useRef
    var Fragment = React.Fragment
    var createPortal = window.ReactDOM && window.ReactDOM.createPortal

    function cx() {
      var list = []
      for (var i = 0; i < arguments.length; i += 1) {
        var value = arguments[i]
        if (value) list.push(String(value))
      }
      return list.join(' ')
    }

    function inlineNodes(text, keyPrefix) {
      var nodes = []
      var pattern = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~/g
      var last = 0
      var match
      var index = 0
      while ((match = pattern.exec(String(text))) !== null) {
        if (match.index > last) nodes.push(String(text).slice(last, match.index))
        var key = keyPrefix + '-' + index
        if (match[1] !== undefined) {
          nodes.push(h('a', {
            key: key,
            href: match[2],
            target: /^https?:/i.test(match[2]) ? '_blank' : undefined,
            rel: 'noreferrer',
            onClick: function (event) { event.stopPropagation() },
          }, match[1]))
        } else if (match[3] !== undefined) {
          nodes.push(h('code', { key: key, className: 'dsh-md-code' }, match[3]))
        } else if (match[4] !== undefined) {
          nodes.push(h('strong', { key: key }, match[4]))
        } else if (match[5] !== undefined) {
          nodes.push(h('strong', { key: key }, match[5]))
        } else {
          nodes.push(h('del', { key: key }, match[6]))
        }
        last = pattern.lastIndex
        index += 1
      }
      if (last < String(text).length) nodes.push(String(text).slice(last))
      return nodes.length ? nodes : [String(text)]
    }

    function MarkdownText(props) {
      var text = props && (props.text !== undefined ? props.text : props.content)
      if (text === undefined && props && props.children !== undefined) text = props.children
      var source = String(text === undefined || text === null ? '' : text)
      var blocks = []
      var lines = source.split(/\r?\n/)
      var i = 0
      while (i < lines.length) {
        var line = lines[i]
        if (!line.trim()) { i += 1; continue }
        var fence = line.match(/^```\s*([\w-]+)?\s*$/)
        if (fence) {
          var code = []
          i += 1
          while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1 }
          i += 1
          blocks.push(h('pre', { key: 'code-' + blocks.length, className: 'dsh-md-pre' },
            h('code', { className: 'dsh-md-code' }, code.join('\n'))))
          continue
        }
        var heading = line.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
          blocks.push(h('h' + heading[1].length, {
            key: 'h-' + blocks.length,
            className: 'dsh-md-h dsh-md-h' + heading[1].length,
          }, inlineNodes(heading[2], 'h' + blocks.length)))
          i += 1
          continue
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          var items = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(h('li', { key: 'li-' + i }, inlineNodes(lines[i].replace(/^\s*[-*+]\s+/, ''), 'li' + i)))
            i += 1
          }
          blocks.push(h('ul', { key: 'ul-' + blocks.length, className: 'dsh-md-list' }, items))
          continue
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          var ordered = []
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            ordered.push(h('li', { key: 'oli-' + i }, inlineNodes(lines[i].replace(/^\s*\d+\.\s+/, ''), 'oli' + i)))
            i += 1
          }
          blocks.push(h('ol', { key: 'ol-' + blocks.length, className: 'dsh-md-list' }, ordered))
          continue
        }
        if (/^\s*>/.test(line)) {
          var quote = []
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            quote.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          blocks.push(h('blockquote', { key: 'q-' + blocks.length, className: 'dsh-md-quote' },
            inlineNodes(quote.join(' '), 'q' + blocks.length)))
          continue
        }
        var paragraph = []
        while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) &&
          !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])) {
          paragraph.push(lines[i])
          i += 1
        }
        blocks.push(h('p', { key: 'p-' + blocks.length, className: 'dsh-md-p' },
          inlineNodes(paragraph.join('\n'), 'p' + blocks.length)))
      }
      return h('div', {
        className: cx('dsh-markdown', props && props.className),
        'data-labels': props && props.labels ? '1' : undefined,
      }, blocks.length ? blocks : h('span', { className: 'dsh-md-empty' }, '（无内容）'))
    }

    function valueType(value) {
      if (value === null) return 'null'
      if (Array.isArray(value)) return 'array'
      return typeof value
    }

    function JsonPrimitive(props) {
      var value = props.value
      var type = valueType(value)
      var text = type === 'string' ? '"' + value + '"' : String(value)
      return h('span', { className: 'dsh-json-' + type }, text)
    }

    function JsonNode(props) {
      var value = props.value
      var type = valueType(value)
      var initial = props.depth < 1
      var state = useState(initial)
      var open = state[0]
      var setOpen = state[1]
      var complex = type === 'object' || type === 'array'
      var entries = complex ? (Array.isArray(value) ? value.map(function (item, index) {
        return [String(index), item]
      }) : Object.keys(value).map(function (key) { return [key, value[key]] })) : []
      if (!complex) {
        return h('div', { className: 'dsh-json-row', role: 'treeitem' },
          props.name !== undefined ? h('span', { className: 'dsh-json-key' }, props.name + ': ') : null,
          h(JsonPrimitive, { value: value }))
      }
      return h('div', { className: 'dsh-json-branch', role: 'treeitem', 'aria-expanded': open ? 'true' : 'false' },
        h('button', {
          type: 'button',
          className: 'dsh-json-toggle',
          'data-json-expander': open ? 'true' : 'false',
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () { setOpen(!open) },
        },
        props.name !== undefined ? h('span', { className: 'dsh-json-key' }, props.name) : null,
        h('span', { className: 'dsh-json-summary' }, type === 'array'
          ? '[' + entries.length + ']'
          : '{' + entries.length + '}')),
        open ? h('div', { className: 'dsh-json-children', role: 'group' },
          entries.map(function (entry) {
            return h(JsonNode, {
              key: entry[0],
              name: entry[0],
              value: entry[1],
              depth: props.depth + 1,
            })
          })) : null)
    }

    function JsonTree(props) {
      var data = props && props.data
      return h('div', { className: cx('dsh-json-tree', props && props.className), role: 'tree',
        'aria-label': props && props.label ? String(props.label) : 'JSON' },
      h(JsonNode, { name: undefined, value: data, depth: 0 }))
    }

    function MenuItem(props) {
      var item = props.item || {}
      var id = item.id !== undefined ? item.id : item.key !== undefined ? item.key : props.index
      var label = item.label !== undefined ? item.label : item.name !== undefined ? item.name : String(item)
      var disabled = !!(item.disabled || props.disabled)
      return h('button', {
        type: 'button',
        role: 'menuitem',
        'data-id': String(id),
        className: cx('dsh-menu-item', props.selected ? 'is-selected' : '', disabled ? 'is-disabled' : ''),
        disabled: disabled,
        onClick: function (event) {
          event.preventDefault()
          if (!disabled && typeof props.onSelect === 'function') props.onSelect(item)
        },
      }, label)
    }

    function Menu(props) {
      var anchorRef = useRef(null)
      var menuRef = useRef(null)
      var state = useState({ top: 0, left: 0, width: 0 })
      var pos = state[0]
      var setPos = state[1]
      var ReactDOM = window.ReactDOM
      var anchor = props && props.anchor ? props.anchor : null
      var items = Array.isArray(props && props.items) ? props.items : []

      useLayoutEffect(function () {
        if (!props || !props.open || !anchorRef.current) return
        var rect = anchorRef.current.getBoundingClientRect()
        setPos({
          top: rect.bottom + 4,
          left: props.align === 'end' ? rect.right : rect.left,
          width: rect.width,
        })
      }, [props && props.open, props && props.align])

      useEffect(function () {
        if (!props || !props.open) return undefined
        function onDoc(event) {
          if (menuRef.current && menuRef.current.contains(event.target)) return
          if (anchorRef.current && anchorRef.current.contains(event.target)) return
          if (typeof props.onClose === 'function') props.onClose()
        }
        function onKey(event) {
          if (event.key === 'Escape' && typeof props.onClose === 'function') props.onClose()
        }
        document.addEventListener('mousedown', onDoc)
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('mousedown', onDoc)
          document.removeEventListener('keydown', onKey)
        }
      }, [props && props.open])

      if (!anchor) return null
      var anchorNode = React.cloneElement(anchor, { ref: anchorRef })
      if (!props || !props.open) return anchorNode
      var menu = h('div', {
        ref: menuRef,
        className: 'dsh-menu',
        role: 'menu',
        style: {
          position: 'fixed',
          top: pos.top + 'px',
          left: pos.left + 'px',
          minWidth: Math.max(pos.width, 160) + 'px',
          transform: props.align === 'end' ? 'translateX(-100%)' : undefined,
        },
        onClick: function (event) { event.stopPropagation() },
      }, items.map(function (item, index) {
        var id = item && item.id !== undefined ? item.id : index
        return h(MenuItem, {
          key: String(id),
          item: item,
          index: index,
          selected: String(id) === String(props.selectedId),
          disabled: item && item.disabled,
          onSelect: props.onSelect,
        })
      }))
      if (props.portal && createPortal) return h(Fragment, null, anchorNode, createPortal(menu, document.body))
      return h('div', { className: 'dsh-menu-anchor', style: { position: 'relative' } }, anchorNode, menu)
    }

    function Tooltip(props) {
      var child = props && props.children
      var label = props && (props.label !== undefined ? props.label : props.content)
      if (!child) return null
      if (typeof child === 'string' || typeof child === 'number') {
        return h('span', { title: label ? String(label) : undefined, className: 'dsh-tooltip' }, child)
      }
      if (React.isValidElement(child)) {
        return React.cloneElement(child, { title: label ? String(label) : child.props.title })
      }
      return h('span', { className: 'dsh-tooltip' }, child)
    }

    function StateDot(props) {
      var size = props && typeof props.size === 'number' ? props.size : 9
      return h('span', {
        className: cx('dsh-state-dot', props && props.className, props && props.state ? 'is-' + props.state : ''),
        style: { width: size + 'px', height: size + 'px' },
      })
    }

    function makeIcon(paths) {
      return function Icon(props) {
        var size = props && typeof props.size === 'number' ? props.size : 16
        return h('svg', {
          className: cx('dsh-icon', props && props.className),
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          'aria-hidden': 'true',
        }, paths.map(function (d, index) {
          return h('path', { key: index, d: d })
        }))
      }
    }

    var icons = {
      IconChecklistOutlineRegular: makeIcon(['M4 6h16', 'M4 12h10', 'M4 18h7']),
      IconPanelLeftOutlineRegular: makeIcon(['M4 4h16v16H4z', 'M9 4v16']),
      IconRightUpOutlineRegular: makeIcon(['M7 17L17 7', 'M8 7h9v9']),
      IconSendOutlineRegular: makeIcon(['M4 12l16-8-6 16-2-6 8 2-2-6z']),
      IconWorkspaceTreeOutlineRegular: makeIcon(['M4 5h6v4H4z', 'M14 5h6v4h-6z', 'M9 16h6v4h-6z', 'M7 9v3h10v-3', 'M12 12v4']),
    }

    function writeClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(String(text)).then(function () { return true }, function () { return false })
      }
      try {
        var area = document.createElement('textarea')
        area.value = String(text)
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        var ok = document.execCommand('copy')
        document.body.removeChild(area)
        return Promise.resolve(!!ok)
      } catch (error) {
        return Promise.resolve(false)
      }
    }

    function useCodeHighlighter() {
      return function () { return undefined }
    }

    function fallbackComponent(name) {
      return function PrimitiveFallback(props) {
        var children = props && props.children
        if (name.indexOf('Icon') === 0) {
          return h('span', { className: 'dsh-icon-fallback', 'aria-hidden': 'true' }, '•')
        }
        if (name === 'Button') {
          return h('button', { type: 'button', className: 'dsh-fallback-button', onClick: props && props.onClick }, children)
        }
        return h('span', { className: 'dsh-primitive-fallback', 'data-primitive': name }, children)
      }
    }

    var primitives = {
      MarkdownText: MarkdownText,
      JsonTree: JsonTree,
      Menu: Menu,
      MenuGroup: Menu,
      Tooltip: Tooltip,
      StateDot: StateDot,
      writeClipboard: writeClipboard,
      useCodeHighlighter: useCodeHighlighter,
    }
    Object.keys(icons).forEach(function (name) { primitives[name] = icons[name] })
    return new Proxy(primitives, {
      get: function (target, prop) {
        if (prop === '__esModule') return true
        if (prop === 'default') return target
        if (prop in target) return target[prop]
        if (typeof prop === 'string' && /^[A-Z]/.test(prop)) {
          return fallbackComponent(prop)
        }
        return undefined
      },
    })
  }


  function declaredModuleReport() {
    var declared = Array.isArray(config.inject) ? config.inject : []
    return declared.map(function (name) {
      return {
        name: name,
        available: !!moduleProviders[name],
        imported: !!moduleCache[name] || !!missingModules[name],
      }
    })
  }

  window.__ModuleLoader__ = {
    load: function (definition) {
      if (!definition || typeof definition.factory !== 'function') {
        throw new Error('__ModuleLoader__.load 需要 { id, factory }');
      }
      pending.push(definition);
    },
  };

  function localeDict(namespace) {
    if (!locales[namespace]) locales[namespace] = { zh: {}, en: {} };
    return locales[namespace];
  }

  function makeLocale() {
    var active = 'zh';
    return {
      locale: active,
      getLocale: function () {
        return { active: active };
      },
      getSnapshot: function () {
        return { active: active };
      },
      register: function (namespace, dict) {
        var target = localeDict(namespace);
        if (dict && typeof dict === 'object') {
          if (dict.zh) Object.assign(target.zh, dict.zh);
          if (dict.en) Object.assign(target.en, dict.en);
        }
        return function () {};
      },
      bind: function (namespace) {
        var dict = localeDict(namespace);
        return function (key, params) {
          var text = dict.zh[key] || dict.en[key] || key;
          if (params && typeof params === 'object') {
            text = String(text).replace(/\{(\w+)\}/g, function (_, name) {
              return params[name] === undefined ? '{' + name + '}' : String(params[name]);
            });
          }
          return text;
        };
      },
    };
  }

  function labelOf(spec) {
    try {
      var label = typeof spec.label === 'function' ? spec.label() : spec.label;
      return label || spec.title || spec.key || spec.id || spec.name || '未命名页面';
    } catch (error) {
      return spec.key || spec.id || spec.name || '未命名页面';
    }
  }

  function listSlot(name) {
    return slots[name] || [];
  }

  function makeSlots() {
    return {
      inject: function (name, callback) {
        if (typeof callback !== 'function') return function () {};
        var result = callback();
        return typeof result === 'function' ? result : function () {};
      },
      register: function (spec, Component) {
        if (!spec || !Component) throw new Error('slots.register 需要 (spec, Component)');
        var slotName = spec.name;
        if (!slotName) throw new Error('slots.register 缺少 spec.name');
        var entry = {
          spec: spec,
          Component: Component,
          key: spec.key || spec.id || spec.name,
          order: typeof spec.order === 'number' ? spec.order : 100,
          label: labelOf(spec),
        };
        if (!slots[slotName]) slots[slotName] = [];
        slots[slotName].push(entry);
        slots[slotName].sort(function (a, b) {
          return a.order - b.order;
        });
        notify();
        return function () {
          slots[slotName] = slots[slotName].filter(function (item) {
            return item !== entry;
          });
          notify();
        };
      },
      list: function (name) {
        return listSlot(name).slice();
      },
    };
  }

  function makeRpc() {
    return {
      call: function (base, channel, call, signal) {
        if (!config.rpc) return Promise.reject(new Error('DSH 运行时未连接 EAB 控制台'));
        return config.rpc(channel, call);
      },
      register: function () {
        return function () {};
      },
    };
  }

  function makeConnection() {
    return { rpc: makeRpc(), fetch: { register: function () { return function () {} } } };
  }

  function makeSettings() {
    var prefix = 'dsh:settings:' + (config.id || 'plugin') + ':';
    function read(ns) {
      try {
        var raw = window.localStorage.getItem(prefix + ns);
        var value = raw ? JSON.parse(raw) : {};
        return value && typeof value === 'object' ? value : {};
      } catch (error) {
        return {};
      }
    }
    function write(ns, value) {
      try {
        window.localStorage.setItem(prefix + ns, JSON.stringify(value || {}));
      } catch (error) {
        console.warn('[dsh-runtime] settings write failed', error);
      }
      notify();
    }
    return {
      get: read,
      set: function (ns, value) { write(ns, value); },
      update: function (ns, patch) { write(ns, Object.assign({}, read(ns), patch || {})); },
      describe: function () {
        var rows = [];
        try {
          for (var i = 0; i < window.localStorage.length; i += 1) {
            var key = window.localStorage.key(i);
            if (!key || key.indexOf(prefix) !== 0) continue;
            var ns = key.slice(prefix.length);
            rows.push(Object.assign({ ns: ns }, read(ns)));
          }
        } catch (error) {}
        return rows;
      },
    };
  }

  function makeContext(extra) {
    var logger = function () {
      return { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} };
    };
    logger.info = function () {};
    logger.warn = function () {};
    logger.error = function () {};
    logger.debug = function () {};

    var layout = {
      selectPanel: function (key) {
        if (shellApi && typeof shellApi.select === 'function') shellApi.select(key);
      },
    };
    var settings = makeSettings();

    var context = {
      slots: makeSlots(),
      locale: makeLocale(),
      connection: makeConnection(),
      layout: layout,
      settings: settings,
      logger: logger,
      effect: function (fn, label) {
        if (typeof fn !== 'function') return fn;
        // Cordis/DSH 的 effect 是「立即执行安装函数，并保留它返回的清理函数」。
        // 插件把 CSS 注入、事件订阅、侧栏入口都放在 effect 里；只存不跑会导致页面没样式。
        var dispose = function () {};
        try {
          var result = fn();
          if (typeof result === 'function') {
            dispose = result;
          } else if (result && typeof result.dispose === 'function') {
            dispose = function () {
              result.dispose();
            };
          }
        } catch (error) {
          console.warn('[dsh-runtime] effect failed: ' + (label || 'effect'), error);
        }
        var entry = { dispose: dispose, label: label || 'effect' };
        disposers.push(entry);
        return function () {
          disposers = disposers.filter(function (item) {
            return item !== entry;
          });
          try {
            dispose();
          } catch (error) {
            console.warn('[dsh-runtime] effect dispose failed: ' + entry.label, error);
          }
        };
      },
      provide: function (key, value) {
        provided[key] = value;
      },
      get: function (key) {
        if (key === 'layout') return layout;
        if (key === 'settings') return settings;
        return provided[key];
      },
      inject: function (keys, callback) {
        if (typeof callback !== 'function') return Promise.resolve(undefined);
        var list = Array.isArray(keys) ? keys : [];
        var child = Object.assign({}, context);
        child.slots = context.slots;
        child.locale = context.locale;
        child.connection = context.connection;
        child.layout = layout;
        child.settings = settings;
        if (list.indexOf('layout') >= 0) child.layout = layout;
        if (list.indexOf('settings') >= 0) child.settings = settings;
        child.root = context;
        return Promise.resolve()
          .then(function () { return callback(child); })
          .catch(function (error) {
            console.warn('[dsh-runtime] inject callback failed', error);
          });
      },
      applySidebarMode: function () {},
    };
    if (extra) Object.assign(context, extra);
    context.root = context;
    return context;
  }

  function renderThing(thing, props) {
    var React = window.React;
    if (typeof thing === 'function') return React.createElement(thing, props || {});
    return thing;
  }

  function createSlotBoundary() {
    var React = window.React;
    var h = React.createElement;
    function SlotBoundary(props) {
      React.Component.call(this, props);
      this.state = { error: null };
    }
    SlotBoundary.prototype = Object.create(React.Component.prototype);
    SlotBoundary.prototype.constructor = SlotBoundary;
    SlotBoundary.getDerivedStateFromError = function (error) {
      return { error: error };
    };
    SlotBoundary.prototype.componentDidCatch = function (error, info) {
      var message = error && error.message ? error.message : String(error);
      console.warn('[dsh-runtime] slot render failed', error, info);
      if (this.props.onError) this.props.onError('页面渲染失败：' + message);
    };
    SlotBoundary.prototype.render = function () {
      if (!this.state.error) return this.props.children;
      var message = this.state.error && this.state.error.message
        ? this.state.error.message
        : String(this.state.error);
      return h('div', { className: 'ph-slot-error', role: 'alert' },
        h('div', { className: 'ph-slot-error-title' }, '这个插件页面渲染失败'),
        h('div', { className: 'ph-slot-error-detail' }, message),
        h('button', {
          type: 'button',
          className: 'ph-slot-error-retry',
          onClick: function () { this.setState({ error: null }); }.bind(this),
        }, '重试这一页'));
    };
    return SlotBoundary;
  }

  /** DSH 会话协议：插件从 localStorage['dsh.sessions.current'] 读取当前会话。 */
  function readDshSessionId() {
    try {
      var raw = window.localStorage.getItem('dsh.sessions.current');
      if (!raw) return '';
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
    } catch (error) {
      return '';
    }
  }

  function createShell(options) {
    var React = options.React;
    var ReactDOM = options.ReactDOM;
    var h = React.createElement;
    var mount = options.mount;
    var navEl = options.nav;
    var panelNavEl = options.panelNav;
    var panelTitleEl = options.panelTitle;
    var settingsNavEl = options.settingsNav;
    var settingsTitleEl = options.settingsTitle;
    var detailEl = options.detailActions;
    var detailRoot = detailEl ? ReactDOM.createRoot(detailEl) : null;
    var active = null;
    var SlotBoundary = createSlotBoundary();

    function buildNav(container, name, onPick, current) {
      if (!container) return [];
      container.innerHTML = '';
      var extra = name === 'main' ? 'conversation.view'
        : name === 'sidebar.panellist' ? 'sidebar'
          : null
      var items = extra ? listSlot(name).concat(listSlot(extra)) : listSlot(name)
      items.forEach(function (entry) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = current && current === entry.key ? 'on' : '';
        button.innerHTML = '<span class="ph-dot"></span><span></span>';
        button.lastChild.textContent = entry.label;
        button.addEventListener('click', function () {
          onPick(entry.key);
        });
        container.appendChild(button);
      });
      return items;
    }

    function renderDetailActions() {
      if (!detailRoot) return;
      var entries = listSlot('plugins.detail.actions');
      detailRoot.render(h(
        'div',
        { className: 'ph-actions' },
        entries.length
          ? entries.map(function (entry) {
            return h('span', { key: entry.key, className: 'ph-action' }, renderThing(entry.Component, {}));
          })
          : null,
      ));
    }
    extraRenderers.push(renderDetailActions);

    function pick(key) {
      active = key;
      notify();
    }

    function Shell() {
      var state = React.useState(0);
      var force = state[1];
      React.useEffect(function () {
        var listener = function () {
          force(function (value) {
            return value + 1;
          });
        };
        listeners.push(listener);
        return function () {
          listeners = listeners.filter(function (item) {
            return item !== listener;
          });
        };
      }, []);

      var mainEntries = listSlot('main').concat(listSlot('conversation.view'))
      var panelEntries = listSlot('sidebar.panellist').concat(listSlot('sidebar'))
      var settingsEntries = listSlot('settings.section')
      var all = mainEntries.concat(panelEntries, settingsEntries);
      if (!active && all.length) active = all[0].key;
      var current = null;
      for (var i = 0; i < all.length; i += 1) {
        // DSH 允许 main 与 sidebar.panellist 用同一个 key 指向同一页面。
        // 这里必须让 main 优先；若继续覆盖，侧栏入口会抢走主面板，
        // 页面只剩一个侧栏图标。
        if (!current && all[i].key === active) current = all[i];
      }
      if (!current && all.length) current = all[0];

      React.useEffect(function () {
        if (navEl) buildNav(navEl, 'main', pick, active);
        if (panelNavEl) buildNav(panelNavEl, 'sidebar.panellist', pick, active);
        if (settingsNavEl) buildNav(settingsNavEl, 'settings.section', pick, active);
        if (settingsTitleEl) {
          var hasSettings = listSlot('settings.section').length > 0;
          settingsTitleEl.className = hasSettings ? 'ph-rail-title' : 'ph-rail-title ph-hidden';
        }
        if (panelTitleEl) {
          var hasPanels = listSlot('sidebar.panellist').length + listSlot('sidebar').length > 0;
          panelTitleEl.className = hasPanels ? 'ph-rail-title' : 'ph-rail-title ph-hidden';
        }
      }, [active, state[0]]);

      if (!current) {
        return h('div', { className: 'ph-empty' }, '插件还没有注册页面（slots.register 未被调用）。');
      }
      var injected = {};
      try {
        if (typeof current.spec.inject === 'function') injected = current.spec.inject() || {};
      } catch (error) {
        options.onError && options.onError('页面注入失败：' + (error && error.message ? error.message : error));
      }
      // 标准 slot props 先给全，插件的 spec.inject() 再覆盖；组件不再因为
      // 拿不到 ctx / t / locale / settings 在首屏静默空白。
      var pageCtx = rootContext || makeContext();
      var localeTag = pageCtx.locale && typeof pageCtx.locale.getLocale === 'function'
        ? (pageCtx.locale.getLocale() || {}).active || 'zh'
        : 'zh';
      var dshSessionId = readDshSessionId();
      var slotProps = {
        ctx: pageCtx,
        context: pageCtx,
        pluginId: config.id,
        companyId: config.company,
        slot: current.spec.name,
        spec: current.spec,
        t: pageCtx.locale.bind(current.spec.locale || ''),
        locale: localeTag,
        getLocale: function () { return { active: localeTag }; },
        settings: pageCtx.settings,
        connection: pageCtx.connection,
        layout: pageCtx.layout,
        rpc: pageCtx.connection && pageCtx.connection.rpc,
        sessionId: dshSessionId,
        session: dshSessionId ? { id: dshSessionId, sessionId: dshSessionId, cwd: '' } : undefined,
        useSessions: function (selector) {
          var snapshot = { byId: {}, current: dshSessionId || null };
          return typeof selector === 'function' ? selector(snapshot) : snapshot;
        },
      };
      for (var key in injected) {
        if (Object.prototype.hasOwnProperty.call(injected, key)) slotProps[key] = injected[key];
      }
      if (typeof slotProps.t !== 'function') {
        slotProps.t = pageCtx.locale.bind(current.spec.locale || '');
      }
      var Boundary = SlotBoundary;
      return h('div', { className: 'dsh-panel-host', 'data-slot': current.spec.name },
        h(Boundary, {
          key: current.spec.name + ':' + current.key,
          onError: options.onError,
        }, renderThing(current.Component, slotProps)));
    }

    var root = ReactDOM.createRoot(mount);
    root.render(h(Shell));
    shellApi = {
      select: function (key) {
        pick(key);
        notify();
      },
      panelCount: function () {
        return listSlot('main').length + listSlot('conversation.view').length +
          listSlot('sidebar.panellist').length + listSlot('sidebar').length +
          listSlot('settings.section').length
      },
    };
    return shellApi;
  }

  function boot() {
    var definitions = pending.slice();
    pending = [];
    var exports = null;
    bootErrors = [];
    rootContext = makeContext();
    function addError(stage, error) {
      var message = error && error.message ? error.message : String(error);
      bootErrors.push(stage + '：' + message);
      console.warn('[dsh-runtime] ' + stage + ' failed', error);
    }
    function run(index) {
      if (index >= definitions.length) {
        loadedExports = exports;
        notify();
        return { errors: bootErrors.slice(), modules: declaredModuleReport() };
      }
      var definition = definitions[index];
      var module = { exports: {} };
      try {
        var result = definition.factory(function (name) {
          return requireModule(name);
        });
        exports = result || module.exports || {};
        loadedExports = exports;
      } catch (error) {
        addError('client bundle 执行失败', error);
        return Promise.resolve().then(function () { return run(index + 1); });
      }
      if (typeof exports.apply === 'function') {
        // DSH 的 apply 允许异步；必须等它完成后再认定 boot 成功，
        // 否则页面会在插件注册 slot 之前就停在空状态。
        return Promise.resolve()
          .then(function () { return exports.apply(rootContext); })
          .catch(function (error) {
            addError('插件 apply 失败', error);
          })
          .then(function () { return run(index + 1); });
      }
      return Promise.resolve().then(function () {
        return run(index + 1);
      });
    }
    return Promise.resolve().then(function () {
      return run(0);
    });
  }

  function installPrimitiveStyles() {
    if (document.getElementById('dsh-primitive-styles')) return
    var style = document.createElement('style')
    style.id = 'dsh-primitive-styles'
    style.textContent = [
      '.dsh-markdown{font-size:13px;line-height:1.65;color:inherit;overflow-wrap:anywhere}',
      '.dsh-md-p{margin:0 0 8px}.dsh-md-h{margin:12px 0 6px;font-weight:650;line-height:1.35}',
      '.dsh-md-h1{font-size:18px}.dsh-md-h2{font-size:16px}.dsh-md-h3{font-size:14px}',
      '.dsh-md-list{margin:0 0 8px;padding-left:18px}.dsh-md-list li{margin:2px 0}',
      '.dsh-md-quote{margin:8px 0;padding:6px 10px;border-left:3px solid rgba(127,127,127,.35);opacity:.85}',
      '.dsh-md-pre{margin:8px 0;padding:8px 10px;border-radius:6px;background:rgba(127,127,127,.12);overflow:auto}',
      '.dsh-md-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}',
      '.dsh-json-tree{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.55}',
      '.dsh-json-row{padding:1px 0 1px 14px}.dsh-json-branch{padding:1px 0 1px 10px}',
      '.dsh-json-toggle{display:inline-flex;gap:4px;align-items:center;border:0;background:none;color:inherit;cursor:pointer;padding:0;font:inherit}',
      '.dsh-json-children{padding-left:12px;border-left:1px dashed rgba(127,127,127,.28);margin-left:4px}',
      '.dsh-json-key{color:#7c8aa0}.dsh-json-string{color:#2f9e68}.dsh-json-number{color:#b07219}',
      '.dsh-json-boolean{color:#2b7cd3}.dsh-json-null{color:#8b8b8b}',
      '.dsh-menu{position:fixed;z-index:2147483000;background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid rgba(127,127,127,.24);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:4px;max-height:320px;overflow:auto}',
      '.dsh-menu-item{display:block;width:100%;text-align:left;border:0;background:none;color:inherit;font:inherit;font-size:13px;padding:7px 10px;border-radius:6px;cursor:pointer}',
      '.dsh-menu-item:hover:not(.is-disabled){background:rgba(127,127,127,.12)}.dsh-menu-item.is-selected{background:rgba(64,128,255,.14)}',
      '.dsh-menu-item.is-disabled{opacity:.5;cursor:default}',
      '.dsh-state-dot{display:inline-block;border-radius:999px;background:#2f9e68;vertical-align:middle}',
      '.dsh-state-dot.is-ongoing{background:#e0a03a}.dsh-state-dot.is-failed{background:#d84a4a}',
      '.dsh-icon{display:inline-block;vertical-align:-2px;flex:none}',
      '.dsh-primitive-fallback{display:contents}.dsh-fallback-button{font:inherit;cursor:pointer}',
    ].join('\n')
    ;(document.head || document.documentElement).appendChild(style)
  }
  installPrimitiveStyles()

  window.__DSH_HOST__ = {
    configure: function (next) {
      config = Object.assign({}, config, next);
    },
    createShell: createShell,
    boot: boot,
    get exports() {
      return loadedExports;
    },
    slots: function () {
      return slots;
    },
    status: function () {
      return {
        ready: !!loadedExports,
        errors: bootErrors.slice(),
        modules: declaredModuleReport(),
        missingModules: Object.keys(missingModules),
        slots: Object.keys(slots).map(function (name) {
          return { name: name, count: slots[name].length };
        }),
      };
    },
  };
})();
