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

  function declaredModuleReport() {
    var declared = Array.isArray(config.inject) ? config.inject : []
    return declared.map(function (name) {
      return {
        name: name,
        available: !!moduleProviders[name],
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
      var items = listSlot(name);
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

      var mainEntries = listSlot('main');
      var panelEntries = listSlot('sidebar.panellist');
      var settingsEntries = listSlot('settings.section');
      var all = mainEntries.concat(panelEntries, settingsEntries);
      if (!active && all.length) active = all[0].key;
      var current = null;
      for (var i = 0; i < all.length; i += 1) {
        if (all[i].key === active) current = all[i];
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
          var hasPanels = listSlot('sidebar.panellist').length > 0;
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
        return listSlot('main').length + listSlot('sidebar.panellist').length + listSlot('settings.section').length;
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
