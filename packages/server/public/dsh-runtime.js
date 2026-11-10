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
  var config = { id: '', company: '', rpc: null };
  var slots = Object.create(null);
  var listeners = [];
  var disposers = [];
  var locales = Object.create(null);
  var provided = Object.create(null);
  var shellApi = null;

  function notify() {
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i]();
      } catch (error) {
        console.warn('[dsh-runtime] listener failed', error);
      }
    }
  }

  function requireModule(name) {
    if (name === 'react') return window.React;
    if (name === 'react-dom') return window.ReactDOM;
    // DSH 内部包（client-connection / ui-slots / locale ...）在 EAB 里由本运行时顶替
    return {};
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
    return {
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

    var context = {
      slots: makeSlots(),
      locale: makeLocale(),
      connection: makeConnection(),
      layout: layout,
      logger: logger,
      effect: function (fn, label) {
        if (typeof fn === 'function') disposers.push({ fn: fn, label: label || 'effect' });
        return fn;
      },
      provide: function (key, value) {
        provided[key] = value;
      },
      get: function (key) {
        if (key === 'layout') return layout;
        return provided[key];
      },
      inject: function (keys, callback) {
        if (typeof callback !== 'function') return;
        var list = Array.isArray(keys) ? keys : [];
        var child = Object.assign({}, context);
        child.slots = context.slots;
        child.locale = context.locale;
        child.connection = context.connection;
        child.layout = layout;
        if (list.indexOf('layout') >= 0) child.layout = layout;
        try {
          callback(child);
        } catch (error) {
          console.warn('[dsh-runtime] inject callback failed', error);
        }
      },
      applySidebarMode: function () {},
    };
    if (extra) Object.assign(context, extra);
    return context;
  }

  function renderThing(thing, props) {
    var React = window.React;
    if (typeof thing === 'function') return React.createElement(thing, props || {});
    return thing;
  }

  function createShell(options) {
    var React = options.React;
    var ReactDOM = options.ReactDOM;
    var h = React.createElement;
    var mount = options.mount;
    var navEl = options.nav;
    var settingsNavEl = options.settingsNav;
    var settingsTitleEl = options.settingsTitle;
    var active = null;

    function buildNav(container, name, onPick, current) {
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
      var settingsEntries = listSlot('settings.section');
      var all = mainEntries.concat(settingsEntries);
      if (!active && all.length) active = all[0].key;
      var current = null;
      for (var i = 0; i < all.length; i += 1) {
        if (all[i].key === active) current = all[i];
        if (!current && all[i].key === active) current = all[i];
      }
      if (!current && all.length) current = all[0];

      React.useEffect(function () {
        if (navEl) buildNav(navEl, 'main', pick, active);
        if (settingsNavEl) buildNav(settingsNavEl, 'settings.section', pick, active);
        if (settingsTitleEl) {
          var hasSettings = listSlot('settings.section').length > 0;
          settingsTitleEl.className = hasSettings ? 'ph-rail-title' : 'ph-rail-title ph-hidden';
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
      return h('div', { className: 'dsh-panel-host', 'data-slot': current.spec.name }, renderThing(current.Component, injected));
    }

    var root = ReactDOM.createRoot(mount);
    root.render(h(Shell));
    shellApi = {
      select: function (key) {
        pick(key);
        notify();
      },
      panelCount: function () {
        return listSlot('main').length + listSlot('settings.section').length;
      },
    };
    return shellApi;
  }

  function boot() {
    var exports = null;
    for (var i = 0; i < pending.length; i += 1) {
      var definition = pending[i];
      var module = { exports: {} };
      var result = definition.factory(function (name) {
        return requireModule(name);
      });
      exports = result || module.exports || {};
      if (typeof exports.apply === 'function') {
        exports.apply(makeContext());
      }
    }
    loadedExports = exports;
    notify();
    return loadedExports;
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
  };
})();
